import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { atomicJson, exists, noLinks, readJson, requireThat, SyncError } from '../lib/io.mjs';
import { uuidPattern } from '../lib/device.mjs';
import { portableState, snapshot } from '../lib/snapshot.mjs';
import { verify } from '../lib/manifest.mjs';
import { enoughSpace, validateContent, validatePayloadPaths } from '../lib/content.mjs';
import { receiveUsb } from '../lib/usb-stream.mjs';
import { prepare, buildPlan, applyPlan, commitPlan, retireRecovery, rollback, validatePlan } from './apply.mjs';
import { Manager, stateDifference } from './manager.mjs';
import { Lifecycle } from './lifecycle.mjs';

export const USB_PROTOCOL = 'tavernsyn-usb-v1';
const TERMINAL = new Set(['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED']);

export function usbPeer(device, peer) {
    requireThat(peer && uuidPattern.test(peer.deviceId ?? '') && peer.deviceId !== device.deviceId,
        'USB_IDENTITY', 'USB 对端设备标识无效或与本机相同；不能向同一设备同步。');
    requireThat(typeof peer.deviceName === 'string' && peer.deviceName.length > 0 && peer.deviceName.length <= 200
        && !/[\x00-\x1f\x7f-\x9f]/.test(peer.deviceName), 'USB_IDENTITY', 'USB 对端设备名称无效。');
    return { deviceId: peer.deviceId, deviceName: peer.deviceName };
}

// The offline entry owns the same locks as the normal launcher. Reserving ST's
// port additionally blocks an uninstrumented server from starting during a copy.
export class UsbSession {
    constructor(device, { lifecycle, log = () => {} } = {}) {
        this.device = device; this.log = log; this.stage = 'idle'; this.locks = [];
        this.manager = new Manager(device, null, undefined, (_job, message) => log(message));
        this.lifecycle = lifecycle ?? new Lifecycle(device, (action, payload) => {
            requireThat(['status', 'recovery', 'configuration'].includes(action), 'BUSY', 'USB 同步正在进行，请等待其结束。');
            return this.manager.action(action, payload);
        });
        this.manager.lifecycle = this.lifecycle;
    }
    async reservePort() {
        if (this.reservation) return;
        const server = net.createServer(socket => socket.destroy());
        await new Promise((resolve, reject) => {
            server.once('error', () => reject(new SyncError('USB_RUNNING', '酒馆端口仍被占用，请保存内容并正常关闭两端酒馆及启动器。')));
            server.listen({ host: '127.0.0.1', port: Number(new URL(this.device.origin).port), exclusive: true }, resolve);
        });
        this.reservation = server;
    }
    async releasePort() {
        const server = this.reservation;
        if (server) { this.reservation = null; await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    }
    async open() {
        requireThat(!this.opened && !this.locks.length, 'USB_SESSION', 'USB 会话已打开。');
        await noLinks(this.device.state);
        try {
            for (const name of ['launcher.lock', 'operation.lock']) {
                const file = path.join(this.device.state, name), nonce = randomUUID();
                const handle = await fs.open(file, 'wx', 0o600).catch(() => {
                    throw new SyncError('USB_RUNNING', '酒馆、启动器或同步任务锁仍存在。请先正常关闭；异常退出请按恢复说明处理，不会自动清除锁。');
                });
                this.locks.push({ file, handle, nonce });
                await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, purpose: 'usb', id: nonce })); await handle.sync();
            }
            requireThat(!await exists(path.join(this.device.state, 'instance.lock')), 'USB_RUNNING', '酒馆实例仍有运行锁，请先关闭酒馆。');
            await this.reservePort();
            const previous = await this.manager.status();
            requireThat(TERMINAL.has(previous.phase) && !previous.maintenancePending, 'RECOVERY_REQUIRED', '上次任务尚待应用、恢复或收尾，请先从正常入口处理完成再使用 USB。');
            const applyFile = path.join(this.device.state, 'apply.json');
            if (await exists(applyFile)) {
                const journal = await readJson(applyFile); await validatePlan(this.device, journal);
                requireThat(['committed', 'rolled-back'].includes(journal.phase), 'RECOVERY_REQUIRED', '上次替换尚未完成，请先从正常入口恢复，USB 不会删除恢复数据。');
            }
            this.previous = previous; this.opened = true;
            return this;
        } catch (error) { await this.releasePort(); await this.releaseLocks(); throw error; }
    }
    async releaseLocks() {
        for (const lease of [...this.locks].reverse()) {
            await lease.handle.close();
            if (await exists(lease.file)) {
                requireThat((await readJson(lease.file)).nonce === lease.nonce, 'LOCK', 'USB 任务锁归属已改变，未删除其他任务锁。');
                await fs.unlink(lease.file);
            }
            this.locks.splice(this.locks.indexOf(lease), 1);
        }
    }
    async close() {
        requireThat(!this.lifecycle.child || this.lifecycle.stopped, 'RECOVERY_REQUIRED', '健康检查进程尚未退出，保留任务锁；请勿启动其他酒馆实例。');
        if (this.opened && !['idle', 'completed', 'failed'].includes(this.stage)) {
            await this.fail(new SyncError('USB_INTERRUPTED', 'USB 会话在收到完整应用回执前已关闭；请核对接收端结果后再同步。'));
        }
        await this.releasePort(); await this.releaseLocks(); this.opened = false;
    }
    async begin(direction, peer, id) {
        requireThat(this.opened && this.stage === 'idle', 'USB_SESSION', '本次 USB 会话已有任务，请结束后重新启动 USB 服务。');
        requireThat(uuidPattern.test(id ?? ''), 'JOB', 'USB 任务标识无效。');
        this.peer = usbPeer(this.device, peer);
        this.stage = direction === 'push' ? 'exporting' : 'receiving';
        this.root = path.join(this.device.state, 'jobs', id); this.payload = path.join(this.root, 'payload');
        requireThat(!await exists(this.root), 'USB_JOB_EXISTS', 'USB 任务目录已经存在，拒绝覆盖旧任务。');
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        if (uuidPattern.test(this.previous.id ?? '') && await exists(path.join(this.device.state, 'jobs', this.previous.id))) {
            await atomicJson(path.join(this.device.state, 'jobs', this.previous.id, 'job.json'), this.previous);
        }
        this.manager.busy = true;
        this.manager.job = { id, direction, transport: 'usb', peerDeviceId: peer.deviceId, peerDeviceName: peer.deviceName,
            started: new Date().toISOString(), phase: 'PREFLIGHT', snapshotReady: false };
        await this.manager.write('PREFLIGHT', { note: 'USB 离线完整同步：以所选来源覆盖接收端，包含删除。' });
        this.before = await portableState(this.device);
    }
    async recordJob() {
        if (this.manager.job) await atomicJson(path.join(this.root, 'job.json'), this.manager.job);
    }
    async export(peer, id = randomUUID()) {
        requireThat(this.opened && this.stage === 'idle', 'USB_SESSION', '本次 USB 会话已有任务，请重新启动 USB 服务。');
        try {
            await this.begin('push', peer, id);
            await this.manager.write('SNAPSHOT');
            this.frozen = await snapshot(this.device, this.payload);
            requireThat((await portableState(this.device)).digest === this.before.digest
                && this.frozen.metadata.sourceState.digest === this.before.digest, 'SOURCE_CHANGED', '制作 USB 快照期间来源发生变化，未发送，请关闭写入程序后重试。');
            await atomicJson(path.join(this.root, 'manifest.json'), this.frozen.manifest);
            this.stage = 'exported';
            await this.manager.write('UPLOADING', { files: this.frozen.manifest.files.length, bytes: this.frozen.manifest.bytes,
                note: '完整快照已就绪，等待 USB 传输及对端应用确认。' });
            await this.recordJob();
            return { id, payload: this.payload, ...this.frozen };
        } catch (error) { await this.fail(error); throw error; }
    }
    async receive(readable, peer, id) {
        requireThat(this.opened && this.stage === 'idle', 'USB_SESSION', '本次 USB 会话已有任务，请重新启动 USB 服务。');
        try {
            await this.begin('pull', peer, id);
            await this.manager.write('DOWNLOADING', { note: '正在通过 USB 接收完整快照，尚未覆盖本机。' });
            const manifest = await receiveUsb(readable, this.payload, {
                onManifest: async value => { validatePayloadPaths(value); await enoughSpace(this.device.state, value.bytes, 2); },
                onProgress: value => this.manager.progress({ stage: 'usb', ...value }),
            });
            await this.manager.write('VERIFYING', { files: manifest.files.length, bytes: manifest.bytes });
            await validateContent(this.payload, manifest);
            const metadata = await readJson(path.join(this.payload, 'environment.json'));
            requireThat(metadata.sourceState?.digest && Array.isArray(metadata.sourceState.files) && !metadata.scope,
                'MANIFEST', 'USB 只接受带有完整数据基准的全量快照。');
            await atomicJson(path.join(this.root, 'manifest.json'), manifest);
            this.frozen = { manifest, metadata }; this.stage = 'received';
            await this.manager.write('VERIFYING', { note: 'USB 快照已完整接收并校验，等待应用。' });
            await this.recordJob();
            return { id, digest: manifest.digest, files: manifest.files.length, bytes: manifest.bytes };
        } catch (error) { await this.fail(error); throw error; }
    }
    async apply() {
        requireThat(this.opened && this.stage === 'received', 'USB_STAGE', '没有已校验且待应用的 USB 快照。');
        this.stage = 'applying';
        try {
            const { manifest, metadata } = this.frozen;
            await this.manager.write('PREPARING', { summary: stateDifference(this.before, metadata.sourceState), note: '正在准备插件；目标平台依赖可能需要网络或本机缓存。' });
            const prepared = await prepare(this.device, this.payload, manifest, this.root);
            requireThat((await portableState(this.device)).digest === this.before.digest, 'LOCAL_CHANGED', 'USB 同步期间本机数据发生变化，未覆盖，请关闭写入程序后重试。');
            await verify(this.payload, manifest);
            // Preparation and integrity checks complete before consuming the old
            // recovery point. buildPlan then moves this target's current roots.
            await retireRecovery(this.device);
            this.plan = await buildPlan(this.device, prepared, this.root);
            await this.manager.write('APPLYING'); await applyPlan(this.device, this.plan);
            const applied = await portableState(this.device);
            await this.manager.write('STARTING', { note: '临时启动接收端进行实例和插件健康检查，检查后正常停止。' });
            await this.releasePort();
            await this.lifecycle.start(); await this.lifecycle.stop();
            await this.reservePort();
            const remote = { generation: this.manager.job.id, digest: manifest.digest };
            this.plan.completion = this.manager.makeOutcome(applied, remote, this.stats());
            await commitPlan(this.device, this.plan);
            await this.manager.success(applied, remote, this.stats(), { outcome: this.plan.completion });
            this.result = { jobId: this.manager.job.id, digest: manifest.digest, deviceId: this.device.deviceId,
                applied: true, maintenancePending: !!this.manager.job.maintenancePending };
            this.stage = 'completed'; await this.recordJob(); return this.result;
        } catch (error) {
            // Never overwrite files held by an unconfirmed live health process.
            if (this.plan && !['committed', 'rolled-back'].includes(this.plan.phase)) {
                try {
                    if (!this.lifecycle.stopped) await this.lifecycle.stop();
                    // An unrelated server may have taken the port between the
                    // reservation and health startup. Prove exclusive ownership
                    // again before moving any live directory back into place.
                    await this.reservePort();
                    await this.manager.write('ROLLING_BACK'); await rollback(this.device, this.plan);
                } catch { error = new SyncError('RECOVERY_REQUIRED', 'USB 应用或健康检查未能安全恢复。已保留全部恢复数据和日志，请先确认进程退出并按恢复说明处理。'); }
            }
            await this.fail(error); throw error;
        }
    }
    stats() {
        const bytes = this.frozen.manifest.bytes;
        return { sentBytes: this.manager.job.direction === 'push' ? bytes : 0, receivedBytes: this.manager.job.direction === 'pull' ? bytes : 0,
            literalBytes: bytes, matchedBytes: 0, transferredFiles: this.frozen.manifest.files.length, note: 'USB 文件内容字节，不含 HTTP 和清单开销。' };
    }
    async acknowledge(result) {
        requireThat(this.stage === 'exported' && result?.applied === true && result.jobId === this.manager.job.id
            && result.digest === this.frozen.manifest.digest && result.deviceId === this.peer.deviceId,
        'USB_RESULT', '对端应用回执与本次 USB 快照不一致，不能报告同步成功。');
        const remote = { generation: this.manager.job.id, digest: this.frozen.manifest.digest };
        await this.manager.success(this.frozen.metadata.sourceState, remote, this.stats());
        this.result = { ...result, maintenancePending: !!(result.maintenancePending || this.manager.job.maintenancePending) };
        this.stage = 'completed'; await this.recordJob(); return this.result;
    }
    async fail(error) {
        if (this.stage === 'completed' || this.plan?.phase === 'committed') return; // A transport/receipt failure cannot undo an applied commit.
        this.stage = 'failed';
        if (!this.manager.job) return;
        const phase = error.code === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'FAILED';
        await this.manager.write(phase, { failurePhase: this.manager.job.phase, snapshotReady: false,
            error: { code: error.code ?? 'USB_FAILED', message: error.code ? error.message : 'USB 同步未完成，请查看本机日志及对端结果。' } });
        await this.recordJob();
    }
    status() {
        const job = this.manager.job;
        return { protocol: USB_PROTOCOL, deviceId: this.device.deviceId, deviceName: this.device.deviceName, stage: this.stage,
            ...(job ? { job: { id: job.id, phase: job.phase, direction: job.direction, note: job.note, files: job.files, bytes: job.bytes,
                progress: job.progress, error: job.error, maintenancePending: job.maintenancePending } } : {}), ...(this.result ? { result: this.result } : {}) };
    }
}
