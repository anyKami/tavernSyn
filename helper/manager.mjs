import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, digest, exists, readJson, requireThat, removeOwned, SyncError } from '../lib/io.mjs';
import { copyTree, verify, validateManifest } from '../lib/manifest.mjs';
import { portableState, snapshot } from '../lib/snapshot.mjs';
import { prepare, buildPlan, applyPlan, rollback, commitPlan, retireRecovery, recoveryStatus, preserveSyncCode, validatePlan } from './apply.mjs';
import * as transport from './transport.mjs';
import { configuration, configureDevice, withDeviceLock } from '../lib/connection.mjs';
import { validateContent } from '../lib/content.mjs';
import { completionPath, readCompletion, validateCompletion, completedStatus, connectionId } from '../lib/completion.mjs';
import { normalizeScope } from '../lib/scope.mjs';
import { executeScoped } from './scoped.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'PREVIEW', 'PENDING_APPLY', 'RECOVERY_REQUIRED']);
const PHASES = { PREFLIGHT: '检查环境', DOWNLOADING: '从 VPS 下载', VERIFYING: '校验文件', PREPARING: '准备插件', AWAITING_CONFIRMATION: '等待覆盖确认',
    AWAITING_SAVE: '核对保存', WAITING_PAGE: '等待页面交接', QUIESCING: '安全停止酒馆', SNAPSHOT: '创建独立快照', UPLOADING: '上传到 VPS',
    APPLYING: '应用更新', RESTORING: '恢复上一版', STARTING: '重新启动酒馆', ROLLING_BACK: '回滚数据', SUCCEEDED: '同步完成',
    FAILED: '同步失败', PREVIEW: '预览完成', PENDING_APPLY: '等待受控应用', RECOVERY_REQUIRED: '需要人工恢复' };
export function stateDifference(before, after) {
    const entries = state => {
        const executable = new Set(state?.executables ?? []);
        return new Map((state?.files ?? []).map(f => [f.path, `${f.sha256}:${executable.has(f.path)}`]));
    };
    const a = entries(before), b = entries(after);
    return { added: [...b.keys()].filter(k => !a.has(k)).length, changed: [...b.keys()].filter(k => a.has(k) && a.get(k) !== b.get(k)).length,
        deleted: [...a.keys()].filter(k => !b.has(k)).length, files: b.size };
}
function clearsCore(before, after) {
    const patterns = [/^profile\/chats\//, /^profile\/group chats\//, /^profile\/characters\/[^/]+\.png$/i, /^profile\/worlds\//];
    return patterns.some(pattern => before?.files.some(f => pattern.test(f.path)) && !after.files.some(f => pattern.test(f.path)));
}
export class Manager {
    constructor(device, lifecycle, transportAdapter = transport, logger = () => {}) {
        this.device = device; this.lifecycle = lifecycle; this.transport = transportAdapter; this.job = null; this.busy = false;
        this.logger = logger;
        this.wake = {}; this.progressTime = 0; this.writeQueue = Promise.resolve();
    }
    async status() {
        if (this.statusWriteFailed && this.job?.commit) return structuredClone(this.job);
        const status = await exists(path.join(this.device.state, 'status.json')) ? await readJson(path.join(this.device.state, 'status.json')) : { phase: 'IDLE' };
        if (status.id && status.phase !== 'SUCCEEDED') {
            const outcome = await readCompletion(this.device, status.id);
            if (outcome) return completedStatus(outcome, ['finalization']);
        }
        return status;
    }
    log = message => {
        try { this.logger(this.job, message); }
        catch { if (!this.logFailed) { this.logFailed = true; console.error('TavernSyn：无法记录同步日志，请检查设备控制目录及磁盘空间。'); } }
    };
    async write(phase, fields = {}) {
        const oldPhase = this.job.phase, oldNote = this.job.note;
        Object.assign(this.job, { phase, updated: new Date().toISOString() }, fields);
        const snapshot = structuredClone(this.job);
        this.writeQueue = this.writeQueue.catch(() => {}).then(() => atomicJson(path.join(this.device.state, 'status.json'), snapshot));
        try { await this.writeQueue; this.statusWriteFailed = false; }
        catch (error) { this.statusWriteFailed = true; throw error; }
        if (phase !== oldPhase) this.log(`阶段：${PHASES[phase] ?? phase} (${phase})`);
        if (fields.files !== undefined) this.log(`快照：${fields.files} 个文件，${fields.bytes ?? 0} 字节`);
        if (fields.summary) this.log(`文件差异：新增 ${fields.summary.added}，修改 ${fields.summary.changed}，删除 ${fields.summary.deleted}`);
        if (fields.remote?.generation) this.log(`VPS 代次：${fields.remote.generation}；SHA-256：${fields.remote.digest}`);
        if (fields.stats && Number.isFinite(fields.stats.sentBytes)) this.log(`传输统计：发送 ${fields.stats.sentBytes} 字节，接收 ${fields.stats.receivedBytes} 字节，新增内容 ${fields.stats.literalBytes} 字节，复用内容 ${fields.stats.matchedBytes ?? 0} 字节`);
        if (fields.note && fields.note !== oldNote) this.log(fields.note);
        if (fields.error) this.log(`错误 [${fields.error.code}]：${fields.error.message}`);
        return this.job;
    }
    progress = value => {
        if (value.stage !== 'transferred' && Date.now() - this.progressTime < 500) return;
        this.progressTime = Date.now();
        return this.write(this.job.phase, { progress: value, ...(value.stats ? { stats: value.stats } : {}) }).catch(() => {});
    };
    async action(action, payload = {}) {
        if (action === 'status') return this.status();
        if (action === 'recovery') return recoveryStatus(this.device);
        if (action === 'configuration') return configuration(this.device);
        if (action === 'configure') {
            requireThat(!this.busy, 'BUSY', '同步正在进行，请结束任务后再修改连接。');
            return configureDevice(this.device, action, payload);
        }
        if (action === 'start') return this.start(payload);
        if (action === 'reconcile') return this.reconcile(payload.id);
        if (action === 'resume-upload') {
            const previous = await this.status();
            requireThat(previous.id === payload.id && !previous.commit && previous.phase === 'FAILED' && previous.direction === 'push'
                && previous.snapshotReady === true, 'JOB', '没有可继续上传的完整快照，请重新推送。');
            requireThat(previous.connection === this.connectionId(), 'CONFIG_CHANGED', '连接目标已改变，不能把旧快照发送到另一数据集。');
            return this.start({ direction: 'push', tab: payload.tab, resume: previous });
        }
        if (action === 'resume-pending') {
            const pending = await this.status();
            requireThat(this.lifecycle && pending.phase === 'PENDING_APPLY', 'PENDING_APPLY', '没有可由受控启动器继续的待应用任务。');
            requireThat(pending.jobRoot === path.join(this.device.state, 'jobs', pending.id), 'JOURNAL', '待应用记录路径无效。');
            return this.start({ direction: 'pull', tab: payload.tab, preview: false, pending });
        }
        if (action === 'confirm') {
            requireThat(this.job?.id === payload.id && this.job.phase === 'AWAITING_CONFIRMATION' && payload.token === this.job.confirmationToken, 'CONFIRMATION', '确认已过期，请重新预览。');
            requireThat(payload.tab === undefined || (typeof payload.tab === 'string' && /^[a-f0-9-]{36}$/.test(payload.tab)), 'INPUT', '浏览器标签页标识无效。');
            const local = await portableState(this.device, { scope: this.job.scope });
            if (local.digest !== this.job.localDigest && this.confirmationTarget) {
                await this.write('AWAITING_CONFIRMATION', {
                    localDigest: local.digest,
                    confirmationToken: digest({ direction: this.job.direction, local: local.digest, remote: this.confirmationRemote }),
                    summary: this.job.scope && this.job.direction === 'push' ? stateDifference(this.confirmationTarget, local) : stateDifference(local, this.confirmationTarget),
                    ...(payload.tab ? { tab: payload.tab } : {}),
                    reason: `本机内容在等待期间有更新，已重新核对差异。请再次确认。${this.confirmationReason}`,
                });
                return { ok: false, refreshed: true };
            }
            requireThat(local.digest === this.job.localDigest, 'CONFIRMATION', '确认期间本机数据发生变化，请重新执行同步。');
            // The browser may have reloaded while dependencies were prepared.
            // Its confirmation owns the subsequent save/page handoff.
            if (payload.tab && payload.tab !== this.job.tab) await this.write('AWAITING_CONFIRMATION', { tab: payload.tab });
            this.wake.confirm?.(); return { ok: true };
        }
        if (action === 'ready') {
            requireThat(this.job?.id === payload.id && this.job.phase === 'AWAITING_SAVE' && payload.tab === this.job.tab, 'JOB', '任务状态已改变。');
            requireThat(this.lifecycle, 'UNMANAGED', '请使用受控入口启动。');
            const receipt = await this.lifecycle.receipt(payload.receipt);
            await this.lifecycle.verifyReceipt(receipt); this.receipt = receipt;
            this.wake.ready?.(); return { id: this.job.id, ticket: this.job.ticket };
        }
        if (action === 'page') {
            requireThat(this.job?.id === payload.id && payload.ticket === this.job.ticket && payload.tab === this.job.tab && this.job.phase === 'WAITING_PAGE', 'JOB', '等待页确认无效。');
            this.wake.page?.(); return { ok: true };
        }
        if (action === 'cancel') {
            requireThat(this.job?.id === payload.id && ['AWAITING_CONFIRMATION', 'AWAITING_SAVE', 'WAITING_PAGE'].includes(this.job.phase), 'JOB', '当前阶段不能取消。');
            for (const wake of Object.values(this.wake)) wake(new SyncError('CANCELLED', '用户取消了本次同步。')); return { ok: true };
        }
        if (action === 'check') {
            requireThat(!this.busy, 'BUSY', '同步正在进行，请结束任务后再检查连接。');
            return withDeviceLock(this.device, async () => {
                const connection = await this.transport.connect(this.device);
                try { return { ok: true, current: connection.hello.current, dataset: connection.hello.dataset }; } finally { connection.control.close(); }
            });
        }
        throw new SyncError('ACTION', '不支持的同步操作。');
    }
    async waitFor(name, phase, fields = {}) {
        let timeout;
        const promise = new Promise((resolve, reject) => {
            timeout = setTimeout(() => { delete this.wake[name]; reject(new SyncError('USER_TIMEOUT', '等待保存或确认超时；未替换数据。')); }, 10 * 60 * 1000);
            this.wake[name] = error => { clearTimeout(timeout); delete this.wake[name]; if (error) reject(error); else resolve(); };
        });
        try { await this.write(phase, fields); await promise; }
        finally { clearTimeout(timeout); delete this.wake[name]; }
    }
    async start({ direction, tab, preview = false, pending = null, resume = null, scope = null }) {
        scope = normalizeScope(resume?.scope ?? pending?.scope ?? scope);
        requireThat(!scope || direction !== 'restore', 'INPUT', '恢复操作使用上次实际应用的范围，不能另选类别。');
        requireThat(['push', 'pull', 'restore'].includes(direction) && typeof preview === 'boolean' && !(direction === 'restore' && preview), 'INPUT', '同步方向无效。');
        requireThat(typeof tab === 'string' && /^[a-f0-9-]{36}$/.test(tab), 'INPUT', '浏览器标签页标识无效。');
        requireThat(!this.busy, 'BUSY', '已有同步任务正在执行。');
        const previous = await this.status();
        requireThat(!previous.maintenancePending, 'FINALIZATION_PENDING', '数据已提交，但本机收尾尚未完成，请先点击“核对同步结果”再开始新同步。');
        requireThat(TERMINAL.has(previous.phase) || previous.phase === 'IDLE', 'RECOVERY_REQUIRED', '上次任务未正常结束，请先查看恢复说明。');
        requireThat((previous.phase !== 'PENDING_APPLY' || pending) && previous.phase !== 'RECOVERY_REQUIRED', 'PENDING_APPLY', '已有待应用或待恢复任务，请先处理。');
        requireThat(this.lifecycle || direction === 'pull', 'UNMANAGED', '严格推送需要受控启动器；请关闭酒馆后使用 TavernSyn 入口。');
        this.busy = true; this.receipt = null; this.outcome = null; this.statusWriteFailed = false;
        this.pendingSource = pending;
        this.resumeSource = resume;
        const lock = path.join(this.device.state, 'operation.lock');
        let handle;
        try { handle = await fs.open(lock, 'wx', 0o600); } catch { this.busy = false; throw new SyncError('BUSY', '设备任务锁仍存在；请先处理上次任务，禁止并发应用。'); }
        try {
            if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(previous.id ?? '')
                && await exists(path.join(this.device.state, 'jobs', previous.id))) {
                await atomicJson(path.join(this.device.state, 'jobs', previous.id, 'job.json'), previous);
            }
            this.progressTime = 0;
            this.job = { ...(resume ?? {}), id: resume?.id ?? randomUUID(), direction, tab, preview, ticket: randomUUID(),
                ...(scope ? { scope } : {}),
                started: resume?.started ?? new Date().toISOString(), error: null, progress: null,
                ...(resume ? { resumedAt: new Date().toISOString(), note: '正在继续上次的已保存快照；此后的本机改动留待下次推送。' } : {}) };
            await handle.writeFile(JSON.stringify({ id: this.job.id, pid: process.pid })); await handle.sync();
            this.log(`${resume ? '续传' : '开始'}任务 ${this.job.id}；${preview ? '仅预览；' : ''}VPS：${this.device.remote?.user ?? ''}@${this.device.remote?.host ?? '未配置'}`);
            await this.write('PREFLIGHT');
        } catch (error) {
            this.busy = false;
            await handle.close(); await fs.unlink(lock);
            throw error;
        }
        const job = this.job;
        this.ownedOperation = { handle, lock, id: job.id };
        this.done = this.execute().catch(async error => {
            if (this.outcome) { await this.finishOutcome(this.outcome); return; }
            const dangerous = error.code === 'RECOVERY_REQUIRED' || (this.plan && !['committed', 'rolled-back'].includes(this.plan.phase));
            await this.write(dangerous ? 'RECOVERY_REQUIRED' : 'FAILED', { error: { code: error.code ?? 'FAILED', message: error.code ? error.message : '同步失败，详细原因请查看本机日志。' } });
        }).finally(async () => {
            try {
                await atomicJson(path.join(this.device.state, 'jobs', job.id, 'job.json'), this.job);
                if (['SUCCEEDED', 'PREVIEW'].includes(this.job.phase) && !this.job.maintenancePending) await this.pruneCompleted();
            } catch { /* Cleanup never changes a successful publish/apply into a false failure. */ }
            this.wake = {}; this.plan = null;
            await this.releaseOperation(); this.busy = false;
        });
        return { id: job.id, phase: job.phase };
    }
    async pruneCompleted() {
        const applyFile = path.join(this.device.state, 'apply.json');
        const apply = await exists(applyFile) ? await readJson(applyFile) : null;
        const jobs = path.join(this.device.state, 'jobs');
        for (const entry of await fs.readdir(jobs, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name) || entry.name === this.job.id) continue;
            const directory = path.join(jobs, entry.name), marker = path.join(directory, 'job.json');
            if (directory === apply?.jobRoot || !await exists(marker)) continue;
            const old = await readJson(marker);
            if (['SUCCEEDED', 'PREVIEW'].includes(old.phase) && !old.maintenancePending) await removeOwned(jobs, directory);
        }
    }
    async confirm(reason, local, remote, incoming = null) {
        const token = digest({ direction: this.job.direction, local: local.digest, remote });
        this.confirmationTarget = incoming; this.confirmationRemote = remote; this.confirmationReason = reason;
        try {
            await this.waitFor('confirm', 'AWAITING_CONFIRMATION', { reason, localDigest: local.digest, confirmationToken: token });
            return this.job.localDigest;
        } finally { this.confirmationTarget = null; this.confirmationRemote = null; this.confirmationReason = null; }
    }
    async saveAndStop({ skipStop } = {}) {
        await this.waitFor('ready', 'AWAITING_SAVE');
        await this.waitFor('page', 'WAITING_PAGE');
        await this.lifecycle.verifyReceipt(this.receipt);
        if (skipStop && await skipStop()) return false;
        await this.write('QUIESCING');
        await this.lifecycle.stop({ interruptOnDrain: true, onInterrupt: () => this.write('QUIESCING', {
            note: '请求未排空，正在中断旧实例连接并正常关闭酒馆；等待清理完成后继续同步。',
        }) });
        await this.lifecycle.verifyReceipt(this.receipt);
        return true;
    }
    async cache(payload) {
        const cache = path.join(this.device.state, 'cache');
        if (await exists(cache)) await removeOwned(this.device.state, cache);
        await fs.mkdir(cache, { mode: 0o700 }); await fs.rename(payload, path.join(cache, 'payload'));
    }
    async releaseOperation() {
        if (!this.ownedOperation) return true;
        const { handle, lock, id } = this.ownedOperation;
        try {
            await handle.close();
            if (await exists(lock)) {
                requireThat((await readJson(lock)).id === id, 'LOCK', '设备任务锁归属已改变，未删除其他任务的锁。');
                await fs.unlink(lock);
            }
            this.ownedOperation = null; return true;
        } catch (error) {
            this.log(`任务锁收尾未完成（${error.code ?? 'IO'}），保留任务结果和记录。`);
            if (this.job?.commit) {
                const pending = [...new Set([...(this.job.maintenance?.pending ?? []), 'lock'])];
                await this.write('SUCCEEDED', { maintenancePending: true, maintenance: { ...this.job.maintenance, pending },
                    note: '数据提交已确认；设备任务锁尚待整理。可点击“核对同步结果”重试，或正常关闭启动器后按恢复说明处理。' }).catch(() => {});
            }
            return false;
        }
    }
    makeOutcome(localState, remote, stats, { noChanges = false, cache = false } = {}) {
        return { format: 1, id: this.job.id, connection: this.connectionId(), completedAt: new Date().toISOString(),
            kind: noChanges ? 'checked' : this.job.direction === 'push' ? 'published' : this.job.direction === 'restore' ? 'restored' : 'applied',
            job: structuredClone(this.job), localState, remote, stats, cache };
    }
    async success(localState, remote, stats, options = {}) {
        // Set the fact in memory before any local maintenance can fail. A durable
        // receipt is written before moving the last frozen payload into cache.
        this.outcome = options.outcome ?? this.makeOutcome(localState, remote, stats, options);
        await this.finishOutcome(this.outcome);
    }
    async finishOutcome(outcome) {
        validateCompletion(this.device, outcome, this.job.id);
        const pending = [];
        const attempt = async (step, action) => {
            try { await action(); return true; }
            catch (error) { pending.push(step); this.log(`数据提交已确认；本机收尾 ${step} 未完成（${error.code ?? 'IO'}），保留回执供重新核对。`); return false; }
        };
        const recorded = await attempt('receipt', () => atomicJson(completionPath(this.device, outcome.id), outcome));
        if (outcome.cache) {
            if (!recorded) pending.push('cache');
            else await attempt('cache', async () => {
                const root = path.dirname(completionPath(this.device, outcome.id)), payload = path.join(root, 'payload');
                const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')));
                requireThat(manifest.digest === outcome.remote.digest, 'MANIFEST', '完成回执与缓存清单不一致。');
                if (await exists(payload)) await this.cache(payload);
                else await verify(path.join(this.device.state, 'cache/payload'), manifest);
            });
        }
        let history;
        await attempt('history', async () => {
            const file = path.join(this.device.state, 'history.json');
            history = await exists(file) ? await readJson(file) : {};
            history[this.job.direction] = outcome.completedAt; await atomicJson(file, history);
        });
        await attempt('baseline', async () => {
            if (outcome.job.scope) return; // A partial mirror is never a full-device synchronization baseline.
            const file = path.join(this.device.state, 'baseline.json');
            if (outcome.kind === 'restored') { if (await exists(file)) await fs.unlink(file); }
            else await atomicJson(file, { connection: this.connectionId(), local: outcome.localState, remote: outcome.remote, direction: this.job.direction, at: outcome.completedAt });
        });
        const completed = completedStatus(outcome, pending);
        this.job.commit = completed.commit;
        if (!await attempt('status', () => this.write('SUCCEEDED', { ...completed, ...(history ? { history } : {}) }))) {
            Object.assign(this.job, completedStatus(outcome, pending), history ? { history } : {});
            await attempt('job', () => atomicJson(path.join(this.device.state, 'jobs', outcome.id, 'job.json'), this.job));
        }
    }
    async reconcile(id) {
        requireThat(!this.busy, 'BUSY', '同步正在进行，不能同时核对提交结果。');
        const previous = await this.status();
        requireThat(previous.id === id && (previous.commit || ['FAILED', 'UPLOADING', 'STARTING'].includes(previous.phase)), 'JOB', '只能核对当前已完成、失败或中断在提交阶段的任务。');
        const file = completionPath(this.device, id), lock = path.join(this.device.state, 'operation.lock');
        requireThat(await this.releaseOperation(), 'FINALIZATION_PENDING', '设备任务锁仍无法整理，请检查控制目录的写入权限或文件占用。');
        const handle = await fs.open(lock, 'wx', 0o600).catch(() => { throw new SyncError('BUSY', '仍有任务占用设备，请先处理任务锁。'); });
        this.ownedOperation = { handle, lock, id };
        this.busy = true;
        try {
            await handle.writeFile(JSON.stringify({ id, pid: process.pid, purpose: 'completion' })); await handle.sync();
            let outcome = await readCompletion(this.device, id);
            this.job = structuredClone(previous);
            if (!outcome && previous.direction === 'pull') {
                const journal = await readJson(path.join(this.device.state, 'apply.json'));
                await validatePlan(this.device, journal);
                requireThat(journal.phase === 'committed' && journal.jobRoot === path.dirname(file) && journal.completion,
                    'COMMIT_NOT_CONFIRMED', '未找到此任务的已提交应用回执，未修改数据。');
                outcome = validateCompletion(this.device, journal.completion, id);
            }
            if (!outcome && previous.direction === 'push') {
                const manifest = validateManifest(await readJson(path.join(path.dirname(file), 'manifest.json')));
                requireThat(previous.connection === this.connectionId() && previous.snapshotReady && previous.snapshotDigest === manifest.digest,
                    'COMPLETION', '旧推送的完整快照或目标记录不匹配。');
                const session = await this.transport.connect(this.device, undefined, this.log);
                let remote = { generation: id, digest: manifest.digest };
                try {
                    if (previous.scope) remote = await session.control.request('published', { job: id, snapshotDigest: manifest.digest, scope: previous.scope });
                    else requireThat(session.hello.dataset === this.device.remote.dataset && session.hello.current?.generation === id
                        && session.hello.current.digest === manifest.digest, 'COMMIT_NOT_CONFIRMED', 'VPS 当前代次尚不能证明此任务已发布；可继续原快照上传，未修改 VPS。');
                } finally { session.control.close(); }
                const payload = await exists(path.join(path.dirname(file), 'payload')) ? path.join(path.dirname(file), 'payload') : path.join(this.device.state, 'cache/payload');
                await verify(payload, manifest);
                const metadata = await readJson(path.join(payload, 'environment.json'));
                outcome = this.makeOutcome(metadata.sourceState, remote, previous.stats, { cache: !previous.scope });
            }
            requireThat(outcome, 'COMMIT_NOT_CONFIRMED', '未找到可核对的提交回执，未应用或发布数据。');
            this.outcome = outcome; await this.finishOutcome(outcome);
        } finally {
            await this.releaseOperation(); this.busy = false;
        }
        return structuredClone(this.job);
    }
    async skipUnchanged(session, baseline) {
        if (!this.lifecycle || this.job.preview || !baseline || baseline.local?.format !== 2 || !Array.isArray(baseline.local.executables) || !session.hello.current
            || !/^[a-f0-9]{64}$/.test(baseline.remote?.digest ?? '')
            || baseline.remote?.digest !== session.hello.current.digest) return false;
        // An empty configured root and a missing root have the same file list.
        // Do not hide a missing source or skip a pull that must recreate it.
        for (const extra of this.device.extraRoots) if (!await exists(extra.path)) return false;
        const local = await portableState(this.device);
        if (local.digest !== baseline.local.digest) return false;
        // Recheck the publication after local inventory/save; a stale hello must
        // never let us skip another device's newly published update.
        const latest = await session.control.request('hello');
        requireThat(latest.dataset === this.device.remote.dataset, 'REMOTE_DATASET', 'VPS 数据集已经改变，停止跳过同步。');
        if (latest.current?.digest !== baseline.remote.digest) return false;
        if ((await portableState(this.device)).digest !== local.digest) return false;
        if (this.job.direction === 'push') await this.lifecycle.verifyReceipt(this.receipt);
        await this.success(local, latest.current, { sentBytes: 0, receivedBytes: 0, literalBytes: 0, matchedBytes: 0, transferredFiles: 0 }, { noChanges: true });
        return true;
    }
    connectionId() { return connectionId(this.device); }
    async restore() {
        requireThat((await recoveryStatus(this.device)).available, 'NO_RECOVERY', '没有可用的上一版恢复副本；需要先完成一次拉取更新。');
        const file = path.join(this.device.state, 'apply.json'), journal = await readJson(file), journalDigest = digest(journal);
        const approved = (await portableState(this.device)).digest;
        await this.write('PREPARING', { note: '准备恢复到最近一次拉取前的本机数据。' });
        try {
            await this.saveAndStop();
            requireThat((await portableState(this.device)).digest === approved, 'LOCAL_CHANGED', '确认后本机数据发生变化，未恢复上一版。');
            requireThat(digest(await readJson(file)) === journalDigest && (await recoveryStatus(this.device)).available, 'NO_RECOVERY', '恢复副本已经改变，请重新检查。');
            await preserveSyncCode(this.device, journal);
            this.plan = journal;
            await this.write('RESTORING'); await rollback(this.device, journal);
            await this.write('STARTING'); await this.lifecycle.start();
            await this.success(null, null, null);
        } catch (error) {
            if (this.plan) {
                await this.write('ROLLING_BACK', { note: '恢复未能完成，正在回到恢复操作前的数据。' });
                try {
                    if (!this.lifecycle.stopped) await this.lifecycle.stop();
                    if (journal.phase !== 'rolled-back') await rollback(this.device, journal);
                    await fs.mkdir(journal.recovery, { recursive: true, mode: 0o700 });
                    await applyPlan(this.device, journal); await this.lifecycle.start(); await commitPlan(this.device, journal);
                } catch { throw new SyncError('RECOVERY_REQUIRED', '恢复及返回原状态未能全部完成。保留所有副本，请先检查进程和恢复日志。'); }
            } else if (this.lifecycle.stopped) await this.lifecycle.start();
            else await this.lifecycle.resume();
            throw error;
        }
    }
    async execute() {
        if (this.job.scope) return executeScoped(this);
        if (this.job.direction === 'restore') return this.restore();
        const root = path.join(this.device.state, 'jobs', this.job.id), payload = path.join(root, 'payload');
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const baselineFile = path.join(this.device.state, 'baseline.json');
        const savedBaseline = await exists(baselineFile) ? await readJson(baselineFile) : null;
        const baseline = savedBaseline?.connection === this.connectionId() ? savedBaseline : null;
        const session = this.pendingSource ? null : await this.transport.connect(this.device, undefined, this.log);
        if (session && !this.resumeSource) await this.write(this.job.phase, { remoteBase: session.hello.current, connection: this.connectionId() });
        let remoteBegun = false;
        const onBegin = async begun => {
            remoteBegun = true;
            await this.write(this.job.phase, { remoteJob: this.job.id,
                ...(begun.seededFrom ? { note: '已复用 VPS 上次中断的暂存文件，正在补传差异。' } : {}) });
        };
        try {
            if (this.job.direction === 'push') {
                let frozen;
                if (this.resumeSource) {
                    await this.write('VERIFYING');
                    requireThat(session.hello.current?.generation === this.job.id
                        || (session.hello.current?.digest ?? null) === (this.resumeSource.remoteBase?.digest ?? null),
                    'REMOTE_CHANGED', 'VPS 已发布其他数据，请重新预览后推送；不会用旧快照覆盖。');
                    const manifest = await readJson(path.join(root, 'manifest.json'));
                    requireThat(manifest.digest === this.resumeSource.snapshotDigest, 'MANIFEST', '快照清单与中断记录不符。');
                    await verify(payload, manifest);
                    frozen = { manifest, metadata: await readJson(path.join(payload, 'environment.json')) };
                } else {
                    const local = await portableState(this.device);
                    if (this.job.preview) { await this.write('PREVIEW', { summary: stateDifference(baseline?.local, local), remote: session.hello.current, note: '以当前设备为准更新 VPS；预览不制作停机快照。' }); return; }
                    if (session.hello.current && baseline?.remote?.digest !== session.hello.current.digest) await this.confirm('VPS 已有另一份数据，或本机尚未建立同步基准。推送会以本机为准替换它。', local, session.hello.current.digest);
                    const diff = stateDifference(baseline?.local, local);
                    if ((diff.deleted && diff.deleted > (baseline?.local?.files.length ?? Infinity) * 0.4) || clearsCore(baseline?.local, local)) await this.confirm('本次将大量删除共享文件，或清空某类聊天、角色或世界书，请确认方向。', local, session.hello.current?.digest ?? null);
                    if (!await this.saveAndStop({ skipStop: () => this.skipUnchanged(session, baseline) })) return;
                    try { await this.write('SNAPSHOT'); frozen = await snapshot(this.device, payload); }
                    finally { if (this.lifecycle.stopped) { await this.write('STARTING'); await this.lifecycle.start(); } else await this.lifecycle.resume(); }
                    await atomicJson(path.join(root, 'manifest.json'), frozen.manifest);
                }
                await this.write('UPLOADING', { files: frozen.manifest.files.length, bytes: frozen.manifest.bytes,
                    snapshotReady: true, snapshotDigest: frozen.manifest.digest });
                const published = await this.transport.push(session, this.device, this.job.id, payload, frozen.manifest, this.progress, onBegin);
                remoteBegun = false;
                await this.success(frozen.metadata.sourceState, { generation: published.generation, digest: published.digest,
                    ...(published.maintenance?.length ? { maintenance: published.maintenance } : {}) }, published.stats, { cache: true });
            } else {
                if (!this.pendingSource && await this.skipUnchanged(session, baseline)) return;
                await this.write('DOWNLOADING');
                let downloaded;
                if (this.pendingSource) {
                    const old = this.pendingSource;
                    const manifest = await readJson(path.join(old.jobRoot, 'manifest.json'));
                    await verify(path.join(old.jobRoot, 'payload'), manifest);
                    await copyTree(path.join(old.jobRoot, 'payload'), payload);
                    downloaded = { generation: old.remote.generation, manifest, stats: old.stats };
                    await atomicJson(path.join(root, 'manifest.json'), manifest);
                } else downloaded = await this.transport.pull(session, this.device, this.job.id, payload, this.progress, onBegin);
                remoteBegun = false;
                await this.write('VERIFYING', { files: downloaded.manifest.files.length, bytes: downloaded.manifest.bytes, stats: downloaded.stats });
                const metadata = await readJson(path.join(payload, 'environment.json'));
                requireThat(metadata.sourceState?.digest && Array.isArray(metadata.sourceState.files), 'MANIFEST', '远端缺少便携数据基准。');
                let local = await portableState(this.device);
                let summary = stateDifference(local, metadata.sourceState);
                const remote = { generation: downloaded.generation, digest: downloaded.manifest.digest };
                if (this.job.preview) { await this.cache(payload); await this.write('PREVIEW', { summary, remote, note: '以 VPS 为准替换当前设备共享内容；预览未应用。' }); return; }
                if (!this.lifecycle) {
                    await verify(payload, downloaded.manifest); await validateContent(payload, downloaded.manifest);
                    await this.write('PENDING_APPLY', { jobRoot: root, remote, localDigest: local.digest, reason: '当前酒馆未通过受控入口启动。已下载并校验；关闭酒馆后从 TavernSyn 入口启动以继续。' });
                    return;
                }
                await this.write('PREPARING', { summary, remote });
                const prepared = await prepare(this.device, payload, downloaded.manifest, root);
                // Dependency installation can take minutes while ST continues saving data.
                local = await portableState(this.device);
                summary = stateDifference(local, metadata.sourceState);
                await this.write('PREPARING', { summary });
                const reasons = [];
                if (!baseline || baseline.local.digest !== local.digest) reasons.push('本机有尚未推送的修改，或这是首次拉取。');
                if (summary.deleted > local.files.length * 0.4 || clearsCore(local, metadata.sourceState)) reasons.push('本次将大量删除共享文件，或清空某类聊天、角色或世界书。');
                if (metadata.warnings?.length) reasons.push(`远端设置含 ${metadata.warnings.length} 个设备绝对路径字段，请先核对设备字段保留策略；继续将按远端值同步。`);
                this.approvedLocal = reasons.length
                    ? await this.confirm(`${reasons.join('')}继续会以 VPS 为准替换共享内容，并保留一份恢复数据。`, local, remote.digest, metadata.sourceState)
                    : local.digest;
                try {
                    await this.saveAndStop();
                    requireThat((await portableState(this.device)).digest === this.approvedLocal, 'LOCAL_CHANGED', '确认后共享数据发生变化，保留下载并停止覆盖。');
                    await retireRecovery(this.device);
                    this.plan = await buildPlan(this.device, prepared, root);
                    await this.write('APPLYING'); await applyPlan(this.device, this.plan);
                    // Capture the applied baseline before plugins resume background writes.
                    const appliedState = await portableState(this.device);
                    await this.write('STARTING'); await this.lifecycle.start();
                    this.plan.completion = this.makeOutcome(appliedState, remote, downloaded.stats, { cache: true });
                    await commitPlan(this.device, this.plan);
                    await this.success(appliedState, remote, downloaded.stats, { outcome: this.plan.completion });
                } catch (error) {
                    if (this.plan && !['committed', 'rolled-back'].includes(this.plan.phase)) {
                        await this.write('ROLLING_BACK');
                        if (!this.lifecycle.stopped) { try { await this.lifecycle.stop(); } catch { throw new SyncError('RECOVERY_REQUIRED', '新实例尚未确认退出，禁止覆盖正在使用的数据。请查看恢复说明。'); } }
                        requireThat(this.lifecycle.stopped, 'RECOVERY_REQUIRED', '进程退出状态不明。');
                        await rollback(this.device, this.plan); await this.lifecycle.start();
                    } else if (this.lifecycle.stopped) await this.lifecycle.start();
                    else await this.lifecycle.resume();
                    throw error;
                }
            }
        } catch (error) {
            if (this.lifecycle?.stopped && !this.plan) await this.lifecycle.start();
            throw error;
        } finally {
            // A rejected begin never owns a remote job. Preserve the exact frozen snapshot.
            try {
                if (remoteBegun) await this.write(this.job.phase, { remoteJob: this.job.id,
                    note: this.job.direction === 'pull'
                        ? '下载任务中断，暂存文件已保留；文件传输进度不代表应用完成。完整下载可校验后继续应用，否则可恢复下载。'
                        : session?.hello.capabilities?.includes('paused-jobs')
                        ? '传输中断，暂存数据已保留。连接结束后 VPS 会释放占用；可继续上次上传，或重新推送最新内容。'
                        : '暂存数据已保留。请更新 VPS 以启用断线释放；可继续上传同一快照。' });
            } finally { session?.control.close(); }
            if (this.lifecycle && !this.lifecycle.stopped && ['AWAITING_SAVE', 'WAITING_PAGE', 'QUIESCING'].includes(this.job.phase)) await this.lifecycle.resume().catch(() => {});
        }
    }
}
