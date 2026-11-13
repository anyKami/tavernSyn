import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkRemoteConfig, uuidPattern } from '../lib/device.mjs';
import { readPassword } from '../lib/connection.mjs';
import { atomicJson, exists, noLinks, readJson, requireThat, run, SyncError, removeOwned, canonical, renamePath } from '../lib/io.mjs';
import { copyTree, difference, hashFile, scan, transferSummary, validateManifest, verify } from '../lib/manifest.mjs';
import { enoughSpace } from '../lib/content.mjs';
import { rsyncOutputLog } from './sync-log.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { seedDownloadBasis } from '../lib/download-basis.mjs';
import { normalizeScope, sameScope, inScope } from '../lib/scope.mjs';
import { createDownloadRecovery, permanentTransportFailure, retryableDownloadError } from './download-reconnect.mjs';
import { connectionId } from '../lib/completion.mjs';
import { validateDownloadBinding, bindingMatches, loadDownloadBinding } from './download-binding.mjs';
import { HYBRID_PROTOCOL, validatePlan, createBundle, verifyBundle, applyBundle } from '../lib/hybrid.mjs';

export const RSYNC_ARGS = ['-rt', '--compress', '--omit-dir-times', '--no-whole-file', '--delete-delay', '--partial-dir=.tavernsyn-partial', '--fsync', '--info=progress2,stats2', '--stats', '--itemize-changes', '--8-bit-output', '--outbuf=L', '--timeout=120', '--modify-window=0'];
const ALIAS = 'tavernsyn-vps';
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function quoted(value) {
    requireThat(typeof value === 'string' && !/["\r\n\x00`$]/.test(value), 'SSH_CONFIG', 'SSH 路径含不支持的特殊字符。');
    return `"${value}"`;
}
export async function rsyncShell(ssh, config, posix, platform = process.platform) {
    // A bare executable is searched on PATH, not relative to SillyTavern's cwd.
    const executable = platform === 'win32' || ssh.includes('/') ? await posix(ssh) : ssh;
    return `${quoted(executable)} -F ${quoted(await posix(config))}`;
}
export function parseStats(output) {
    const number = label => Number(output.match(new RegExp(`${label}: ([\\d,]+)`))?.[1]?.replaceAll(',', '') ?? 0);
    return { sentBytes: number('Total bytes sent'), receivedBytes: number('Total bytes received'),
        literalBytes: number('Literal data'), matchedBytes: number('Matched data'), transferredFiles: number('Number of regular files transferred'),
        unit: 'rsync protocol bytes; excludes SSH/Tailscale overhead' };
}
export class Control {
    constructor(child, log = () => {}) {
        this.child = child; this.waiters = new Map(); this.buffer = ''; this.sequence = 0; this.closed = false;
        this.log = log; this.started = Date.now(); this.intentional = false; this.exitLogged = false;
        child.stdin.on('error', () => {});
        const stderr = rsyncOutputLog(line => this.log(`SSH: ${line.slice('rsync: '.length)}`));
        let stderrTail = '';
        child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderrTail = (stderrTail + text).slice(-8192); stderr.write(text); }); child.stderr.once('end', () => stderr.end());
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', text => {
            this.buffer += text;
            if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new SyncError('REMOTE_PROTOCOL', 'VPS 响应过大。')); child.stdin.end(); return; }
            let index;
            while ((index = this.buffer.indexOf('\n')) !== -1) {
                const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
                try {
                    const message = JSON.parse(line), pending = this.waiters.get(message.id);
                    if (!pending) continue;
                    clearTimeout(pending.timer); this.waiters.delete(message.id);
                    if (message.ok) { this.log(`VPS ${pending.op} 完成${message.result?.phase ? `：${message.result.phase}` : ''}`); pending.resolve(message.result); }
                    else {
                        const code = ['BUSY', 'REMOTE_CHANGED', 'UPGRADE_REQUIRED', 'PERMISSION'].includes(message.code) ? message.code : 'REMOTE';
                        const detail = code === 'BUSY' ? 'VPS 仍有传输进程，连接结束后可重试或继续上次上传。'
                            : code === 'UPGRADE_REQUIRED' ? '请先更新本设备与 VPS 的 TavernSyn，才能使用断线释放与续传。'
                                : code === 'PERMISSION' ? 'VPS 暂存文件权限异常，已保留任务，请检查服务端权限。'
                                    : `VPS 拒绝操作：${String(message.error).slice(0, 300)}`;
                        this.log(`VPS ${pending.op} 失败 [${code}]：${detail}`);
                        pending.reject(new SyncError(code, detail));
                    }
                } catch { this.fail(new SyncError('REMOTE_PROTOCOL', 'VPS 返回了无法识别的控制消息。')); }
            }
        });
        child.once('error', () => { this.closed = true; this.fail(Object.assign(new SyncError('SSH', '无法启动 SSH。'), { transportRetryable: false })); });
        const exited = (code, signal) => {
            this.closed = true;
            if (!this.exitLogged) {
                this.exitLogged = true;
                this.log(`SSH 控制进程${this.intentional ? '主动结束' : '退出'}：退出码 ${Number.isInteger(code) ? code : '无'}，信号 ${signal ?? '无'}，存续 ${Math.round((Date.now() - this.started) / 1000)} 秒。`);
            }
            this.fail(Object.assign(new SyncError('SSH', 'SSH 连接已结束，请检查 Tailscale、账号密码和 VPS 密码登录配置；服务器身份改变也会阻止连接。'),
                { transportRetryable: !this.intentional && !permanentTransportFailure(stderrTail) }));
        };
        child.once('exit', exited);
        child.once('close', (code, signal) => { stderr.end(); exited(code, signal); });
    }
    fail(error) { for (const pending of this.waiters.values()) { clearTimeout(pending.timer); pending.reject(error); } this.waiters.clear(); }
    request(op, fields = {}, timeoutMs = 30 * 60 * 1000) {
        requireThat(!this.closed, 'SSH', 'SSH 控制连接已关闭。');
        this.log(`VPS 请求：${op}`);
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.waiters.delete(id); reject(new SyncError('SSH_TIMEOUT', '等待 VPS 响应超时，保留任务以便恢复。')); }, timeoutMs);
            this.waiters.set(id, { resolve, reject, timer, op });
            this.child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
        });
    }
    close() { this.intentional = true; this.child.stdin.end(); this.child.kill(); }
}
export async function environment(device) {
    const remote = await checkRemoteConfig(device), tools = device.tools ?? {};
    requireThat(uuidPattern.test(device.deviceId), 'CONFIG', '设备标识无效。');
    await readPassword(remote.passwordFile);
    const rsync = tools.rsync ?? 'rsync', ssh = tools.ssh ?? 'ssh';
    if (process.platform === 'win32') {
        requireThat(path.isAbsolute(rsync) && path.isAbsolute(ssh) && path.dirname(rsync).toLowerCase() === path.dirname(ssh).toLowerCase(), 'DEPENDENCY', 'Windows 请配置同一 MSYS2 目录中的 rsync.exe 和 ssh.exe。');
        requireThat((await Promise.all(['cygpath.exe', 'sh.exe'].map(name => exists(path.join(path.dirname(rsync), name))))).every(Boolean), 'DEPENDENCY', '所选运行库缺少 cygpath.exe 或 sh.exe。');
    }
    const version = (await run(rsync, ['--version'])).stdout;
    requireThat(/version\s+3\.(?:[2-9]|[1-9]\d)\./.test(version), 'DEPENDENCY', '需要支持 --fsync 的 rsync 3.2 或更新版本。');
    await run(ssh, ['-V']);
    const posix = async value => process.platform === 'win32'
        ? (await run(path.join(path.dirname(rsync), 'cygpath.exe'), ['-u', path.resolve(value)])).stdout.trim() : path.resolve(value);
    const config = path.join(device.state, 'ssh_config');
    const askpass = path.join(device.state, 'credentials/ssh-askpass');
    await noLinks(config); await noLinks(askpass); await noLinks(remote.knownHostsFile);
    await fs.mkdir(path.dirname(askpass), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(remote.knownHostsFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(askpass, `#!/bin/sh\nexec ${shellQuote(await posix(process.execPath))} ${shellQuote(await posix(fileURLToPath(new URL('./askpass.mjs', import.meta.url))))} "$@"\n`, { mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(askpass, 0o700);
    const contents = [
        `Host ${ALIAS}`, `  HostName ${remote.host}`, `  User ${remote.user}`, '  Port 22',
        `  UserKnownHostsFile ${quoted(await posix(remote.knownHostsFile))}`, '  GlobalKnownHostsFile none',
        '  StrictHostKeyChecking accept-new', '  BatchMode no', '  PubkeyAuthentication no', '  PasswordAuthentication yes',
        '  PreferredAuthentications password', '  KbdInteractiveAuthentication no', '  NumberOfPasswordPrompts 1',
        '  ConnectTimeout 15', '  ServerAliveInterval 10', '  ServerAliveCountMax 3', '  ControlMaster no', '  ControlPath none',
        '  ForwardAgent no', '  ClearAllForwardings yes', '  LogLevel ERROR', '',
    ].join('\n');
    await fs.writeFile(config, contents, { mode: 0o600 });
    const authEnv = { SSH_ASKPASS: await posix(askpass), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'tavernsyn:0',
        TAVERNSYN_PASSWORD_FILE: remote.passwordFile, LC_ALL: 'C' };
    return { rsync, ssh, posix, config: await posix(config), rsh: await rsyncShell(ssh, config, posix), remote, authEnv, deviceId: device.deviceId };
}
export async function connect(device, makeEnvironment = environment, log = () => {}) {
    log(`准备 SSH/rsync，连接 ${device.remote?.user ?? 'tavernsyn'}@${device.remote?.host ?? ''}`);
    const env = await makeEnvironment(device);
    const child = spawn(env.ssh, ['-F', env.config, ALIAS, 'tavernsyn-control-v1', device.deviceId], { env: { ...process.env, ...env.authEnv }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const control = new Control(child, log);
    try {
        const hello = await control.request('hello', { requiredProtocol: HYBRID_PROTOCOL });
        requireThat(hello.hybridProtocol === HYBRID_PROTOCOL && hello.capabilities?.includes(HYBRID_PROTOCOL) && hello.capabilities?.includes('job-bound-rsync'), 'UPGRADE_REQUIRED', '请先将本设备和 VPS 同时更新到支持混合传输的版本。');
        env.jobBound = hello.capabilities?.includes('job-bound-rsync') === true;
        requireThat(hello.protocol === 1 && uuidPattern.test(hello.dataset)
            && (!env.remote.dataset || hello.dataset === env.remote.dataset), 'REMOTE_DATASET', '连接到的数据集与本机登记信息不一致。');
        if (!env.remote.dataset) {
            const file = path.join(device.state, 'device.json'), saved = await readJson(file);
            requireThat(saved.remote?.host === env.remote.host && saved.remote?.user === env.remote.user
                && saved.remote?.passwordFile === env.remote.passwordFile && !saved.remote.dataset, 'CONFIG_CHANGED', '连接配置已改变，请重新检查连接。');
            saved.remote.dataset = hello.dataset; await atomicJson(file, saved);
            env.remote.dataset = hello.dataset; device.remote.dataset = hello.dataset;
        }
        log(`SSH 连接成功；数据集 ${hello.dataset}；当前代次 ${hello.current?.generation ?? '尚未发布'}`);
        // Reconnect to the original, authenticated target even if a caller later
        // changes the mutable device object. Keep the original publication base.
        const pinned = { ...device, remote: { ...env.remote, dataset: hello.dataset } };
        const session = { control, env, hello, log, async reconnect() {
            session.control.close();
            const fresh = await connect(pinned, makeEnvironment, session.log);
            session.control = fresh.control; session.env = fresh.env;
        } };
        return session;
    } catch (error) { control.close(); throw error; }
}
async function writeScopedEnvironment(payload, content) {
    const root = path.dirname(payload), target = path.join(payload, 'environment.json');
    await noLinks(target);
    if (await exists(target)) requireThat((await fs.lstat(target)).isFile(), 'DOWNLOAD_BINDING', '分类元数据路径不是普通文件。');
    const temp = path.join(root, `environment-${randomUUID()}.tmp`);
    let created = false, renamed = false;
    try {
        const handle = await fs.open(temp, 'wx', 0o600); created = true;
        try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        await noLinks(target);
        await renamePath(temp, target); renamed = true;
        if (process.platform !== 'win32') {
            for (const directory of [payload, root]) {
                const handle = await fs.open(directory, 'r');
                try { await handle.sync(); } finally { await handle.close(); }
            }
        }
    } catch (error) {
        if (created && !renamed) await fs.unlink(temp).catch(() => {});
        if (renamed) error.atomicCommitted = true;
        throw error;
    }
}
async function partialCleanup(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        requireThat(!entry.isSymbolicLink(), 'LINK', '传输暂存区含链接。');
        if (entry.isDirectory()) {
            if (entry.name === '.tavernsyn-partial') await removeOwned(root, full);
            else await partialCleanup(full);
        }
    }
}
async function transfer(env, direction, job, payload, onProgress, correction, log = () => {}, selection, module = 'payload') {
    const local = `${(await env.posix(payload)).replace(/\/$/, '')}/`, remote = `${ALIAS}::${module}/`;
    const args = [...RSYNC_ARGS];
    if (correction || selection) {
        const list = path.join(path.dirname(payload), `correction-${randomUUID()}.txt`);
        // --files-from implicitly enables --relative, which the VPS deliberately
        // refuses. Anchored exact include filters retain the same path layout
        // without widening the daemon's option allowlist.
        await fs.writeFile(list, `${selectionFilters(correction ?? selection).join('\0')}\0`, { mode: 0o600 });
        args.splice(args.indexOf('--delete-delay'), 1);
        args.push('--from0', `--include-from=${await env.posix(list)}`, '--exclude=*');
        if (correction) args.push('--ignore-times');
    }
    args.push(`--rsync-path=tavernsyn-rsync-v3 ${env.deviceId} ${job} ${module}`, `--rsh=${env.rsh}`, '--', ...(direction === 'push' ? [local, remote] : [remote, local]));
    let tail = '';
    log(`rsync ${direction === 'push' ? '上传' : '下载'}开始${correction ? `：定向补传 ${correction.length} 个文件` : '：增量传输，逐文件显示变更'}`);
    const output = rsyncOutputLog(log);
    let result;
    try { result = await run(env.rsync, args, { env: { ...env.authEnv, RSYNC_PROTECT_ARGS: '0', RSYNC_OLD_ARGS: '0' }, maxBytes: 32 * 1024 * 1024,
        onOutput: text => {
            output.write(text);
            tail = (tail + text).slice(-8192);
            const progress = [...tail.matchAll(/([\d,]+)\s+(\d+)%\s+[^\r\n]+/g)].at(-1);
            if (progress) onProgress?.({ logicalBytes: Number(progress[1].replaceAll(',', '')), percent: Number(progress[2]) });
        } }); } catch (error) {
        if (permanentTransportFailure(tail)) error.transportRetryable = false;
        throw error;
    } finally { output.end(); }
    log(`rsync ${direction === 'push' ? '上传' : '下载'}结束`);
    return parseStats(result.stdout);
}
export function selectionFilters(files) {
    const patterns = new Set();
    const escape = name => name.replace(/[\\[\]*?]/g, '\\$&');
    for (const file of files) {
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++) patterns.add('/' + escape(parts.slice(0, i).join('/')) + '/');
        patterns.add('/' + escape(file));
    }
    return [...patterns];
}
function addStats(first, second) {
    if (!first) return second;
    if (!second) return first;
    return { ...first, ...Object.fromEntries(['sentBytes', 'receivedBytes', 'literalBytes', 'matchedBytes', 'transferredFiles'].map(k => [k, first[k] + second[k]])), corrected: true };
}
export function createUploadRecovery(session, device, job, begun, { scope = null, wait = delay, now = Date.now, onInterrupted } = {}) {
    const dataset = session.hello.dataset ?? device.remote.dataset, base = begun.base ?? null;
    let retries = 0, interrupted = 0, busyWait = 0, phase = begun.phase, busyLogged = false, interruptionLogged = false;
    return {
        get phase() { return phase; },
        async run(operation, transferring = false) {
            let reclaim = false;
            for (;;) {
                try {
                    if (reclaim) {
                        retries++;
                        const backoff = Math.min(1000 * 2 ** (retries - 1), 10000);
                        session.log?.(`上传连接中断，${backoff / 1000} 秒后自动重连（${retries}/5）；保留上传断点。`);
                        await wait(backoff);
                        await session.reconnect();
                        requireThat(session.env.jobBound === true && (!session.env.remote || session.env.remote.dataset === dataset), 'REMOTE_PROTOCOL', '重连后的 VPS 身份或任务绑定能力改变。');
                        let resumed;
                        for (;;) {
                            try { resumed = await session.control.request('begin', { job, dataset, direction: 'push', base, jobBound: true, resumeOnly: true, ...(scope ? { scope } : {}) }); break; }
                            catch (error) {
                                if (error.code !== 'BUSY') throw error;
                                if (busyWait >= 150000) { session.log?.('VPS 持续占用，累计等待已达 150 秒；保留原任务。'); throw error; }
                                if (!busyLogged) { session.log?.('VPS 仍有传输进程，正在同一连接等待释放（最多 150 秒）。'); busyLogged = true; }
                                const duration = Math.min(2000, 150000 - busyWait), start = now();
                                await wait(duration); busyWait += Math.max(duration, now() - start);
                            }
                        }
                        requireThat(resumed.job === job && resumed.direction === 'push' && resumed.generation === job && ['transfer', 'finalizing', 'done'].includes(resumed.phase)
                            && (resumed.base ?? null) === base && sameScope(resumed.scope, scope), 'REMOTE_PROTOCOL', 'VPS 上传续接回执不一致。');
                        phase = resumed.phase; reclaim = false;
                        session.log?.(`SSH 已恢复同一上传任务：${job}（${phase}）。`);
                    }
                    return await operation();
                } catch (error) {
                    if (transferring && !reclaim) { interrupted++; await onInterrupted?.(); }
                    if (session.control.intentional && !reclaim || !retryableDownloadError(error) || retries >= 5 || session.env.jobBound !== true || typeof session.reconnect !== 'function') throw error;
                    reclaim = true;
                }
            }
        },
        stats(value) {
            if (interrupted && !interruptionLogged) { session.log?.('上传统计未包含部分中断尝试流量。'); interruptionLogged = true; }
            return retries ? { ...value, reconnects: retries, interruptedTransfers: interrupted, ...(interrupted ? { incompleteNetworkStats: true, note: '中断尝试的网络流量可能未包含在统计中。' } : {}) } : value;
        },
    };
}
function checkedHybridPlan(plan, manifest, job, dataset, generation, base, scope) {
    validatePlan(plan, manifest);
    requireThat(plan.job === job && plan.dataset === dataset && plan.generation === generation && plan.base === base && sameScope(plan.scope, scope), 'REMOTE_PROTOCOL', '混合传输计划绑定不一致。');
    return plan;
}
async function cleanHybridStage(root, manifest) {
    await noLinks(root); const wanted = new Set(manifest.files.map(f => f.path));
    async function visit(dir, prefix = '') {
        for (const item of await fs.readdir(dir, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${item.name}` : item.name, full = path.join(dir, item.name);
            const stat = await fs.lstat(full); requireThat(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'LINK', '暂存区含链接或特殊文件。');
            if (stat.isDirectory()) {
                if (item.name === '.tavernsyn-partial') {
                    for (const partial of await fs.readdir(full, { withFileTypes: true })) {
                        const candidate = prefix ? `${prefix}/${partial.name}` : partial.name;
                        const entry = path.join(full, partial.name), info = await fs.lstat(entry);
                        requireThat(info.isFile() && !info.isSymbolicLink(), 'LINK', '传输断点含链接或特殊文件。');
                        if (!wanted.has(candidate)) await fs.unlink(entry);
                    }
                } else await visit(full, relative);
                if (!(await fs.readdir(full)).length) await fs.rmdir(full);
            } else if (!wanted.has(relative)) await fs.unlink(full);
        }
    }
    await visit(root);
}
async function hybridDownload(session, device, job, payload, manifest, begun, scope, recovery, onProgress) {
    const have = await scan(payload, { ignorePartials: true });
    const response = await recovery.run(() => session.control.request('hybrid-plan', { job, have }));
    const plan = checkedHybridPlan(response.plan, manifest, job, device.remote.dataset, begun.generation, begun.base ?? null, scope);
    const descriptors = response.descriptors;
    requireThat(Array.isArray(descriptors) && descriptors.length === plan.groups.length && descriptors.every(d => Number.isSafeInteger(d?.size) && d.size >= 12 && /^[a-f0-9]{64}$/.test(d.sha256)), 'REMOTE_PROTOCOL', '混合包描述无效。');
    const saved = path.join(path.dirname(payload), 'hybrid-plan.json');
    if (await exists(saved)) requireThat(canonical(await readJson(saved)) === canonical({ plan, descriptors }), 'DOWNLOAD_BINDING', '恢复时混合计划已改变。');
    else await atomicJson(saved, { plan, descriptors });
    const wire = path.join(path.dirname(payload), 'wire'); await noLinks(wire); await fs.mkdir(wire, { recursive: true });
    let stats;
    if (descriptors.length) stats = await recovery.run(() => transfer(session.env, 'pull', job, wire, onProgress, undefined, session.log, descriptors.map((_, i) => `${i}.bundle`), 'wire'));
    for (let i = 0; i < descriptors.length; i++) {
        const file = path.join(wire, `${i}.bundle`);
        try { requireThat((await fs.lstat(file)).size === descriptors[i].size, 'INTEGRITY', '包大小不匹配。'); await verifyBundle(file, plan, manifest, i, descriptors[i].sha256); }
        catch { stats = { ...addStats(stats, await recovery.run(() => transfer(session.env, 'pull', job, wire, onProgress, [`${i}.bundle`], session.log, undefined, 'wire'))), corrected: true }; await verifyBundle(file, plan, manifest, i, descriptors[i].sha256); }
    }
    await cleanHybridStage(payload, manifest);
    if (plan.large.length) stats = addStats(stats, await recovery.run(() => transfer(session.env, 'pull', job, payload, onProgress, undefined, session.log, plan.large)));
    for (let i = 0; i < descriptors.length; i++) await applyBundle(path.join(wire, `${i}.bundle`), payload, plan, manifest, i, descriptors[i].sha256);
    await partialCleanup(payload);
    let diff = difference(manifest, await scan(payload));
    const correction = [...diff.missing, ...diff.changed];
    requireThat(!diff.extra.length && correction.every(name => plan.large.includes(name)), 'INTEGRITY', '下载暂存与固定计划不一致。');
    if (correction.length) { stats = { ...addStats(stats, await recovery.run(() => transfer(session.env, 'pull', job, payload, onProgress, correction, session.log))), corrected: true }; await partialCleanup(payload); await verify(payload, manifest); }
    else await verify(payload, manifest);
    return stats ?? { sentBytes: 0, receivedBytes: 0, literalBytes: 0, matchedBytes: 0, transferredFiles: 0 };
}
export async function push(session, device, job, payload, manifest, onProgress, onBegin, { scope = null, onPlan } = {}) {
    scope = normalizeScope(scope); validateManifest(manifest);
    if (scope) requireScoped(session);
    const begun = await session.control.request('begin', { job, dataset: device.remote.dataset, direction: 'push', base: session.hello.current?.digest ?? null, jobBound: session.env.jobBound === true, ...(scope ? { scope } : {}) });
    requireThat(begun.job === job && begun.direction === 'push' && begun.generation === job && sameScope(begun.scope, scope), 'REMOTE_PROTOCOL', 'VPS 上传任务回执不一致。');
    await onBegin?.(begun);
    const recovery = createUploadRecovery(session, device, job, begun, { scope, onInterrupted: () => onProgress?.({ stage: 'interrupted', incompleteNetworkStats: true }) });
    return finalizeUpload(session, device, job, payload, manifest, undefined, onProgress, begun.phase, { scope, base: begun.base, recovery, onPlan });
}
export async function finalizeUpload(session, device, job, payload, manifest, stats, onProgress, phase = 'transfer', options = {}) {
    const scope = normalizeScope(options.scope);
    const recovery = options.recovery ?? createUploadRecovery(session, device, job, { phase, base: options.base ?? session.hello.current?.digest ?? null }, { scope, onInterrupted: () => onProgress?.({ stage: 'interrupted', incompleteNetworkStats: true }) });
    return recovery.run(async () => {
        if (!['done', 'finalizing'].includes(recovery.phase)) {
            const result = await session.control.request('hybrid-plan', { job, manifest });
            const plan = checkedHybridPlan(result.plan, manifest, job, device.remote.dataset, job, options.base ?? session.hello.current?.digest ?? null, scope);
            if (options.onPlan) await options.onPlan({ files: plan.groups.reduce((n, g) => n + g.length, 0) + plan.large.length,
                bytes: [...plan.groups.flat(), ...manifest.files.filter(f => plan.large.includes(f.path))].reduce((n, f) => n + f.size, 0) });
            const wire = path.join(path.dirname(payload), 'wire'); await noLinks(wire); await fs.mkdir(wire, { recursive: true });
            const descriptors = [];
            for (let i = 0; i < plan.groups.length; i++) descriptors.push(await createBundle(payload, path.join(wire, `${i}.bundle`), plan, manifest, i));
            await session.control.request('hybrid-descriptors', { job, descriptors });
            if (descriptors.length) stats = addStats(stats, await recovery.run(() => transfer(session.env, 'push', job, wire, onProgress, descriptors.map((_, i) => `${i}.bundle`), session.log, undefined, 'wire'), true));
            if (plan.large.length) {
                stats = addStats(stats, await recovery.run(() => transfer(session.env, 'push', job, payload, onProgress, undefined, session.log, plan.large), true));
                const diff = await session.control.request('inspect', { job, manifest });
                const correction = diff.changed.filter(name => plan.large.includes(name));
                if (correction.length) stats = addStats(stats, await recovery.run(() => transfer(session.env, 'push', job, payload, onProgress, correction, session.log), true));
            }
            await session.control.request('hybrid-apply', { job });
            await onProgress?.({ stage: 'transferred', stats: recovery.stats(stats) });
        }
        const published = await session.control.request('commit', { job, manifest });
        requireThat((scope ? published.snapshotDigest : published.digest) === manifest.digest && /^[a-f0-9]{64}$/.test(published.digest), 'REMOTE_PROTOCOL', 'VPS 发布回执与源快照不匹配。');
        return { ...published, stats: recovery.stats(stats) };
    });
}
export async function pull(session, device, job, payload, onProgress, onBegin, { scope = null, onPlan, resume = null } = {}) {
    scope = normalizeScope(scope);
    if (scope) return pullScoped(session, device, job, payload, onProgress, onBegin, scope, onPlan, resume);
    const begun = await beginDownload(session, device, job, scope, resume, payload);
    await onBegin?.(begun);
    const manifest = validateManifest(begun.manifest);
    session.log?.(`VPS 下载清单：${manifest.files.length} 个文件，${manifest.bytes} 字节；固定代次 ${begun.generation}`);
    await noLinks(payload);
    if (await exists(payload)) requireThat((await fs.lstat(payload)).isDirectory(), 'DOWNLOAD_BINDING', '原下载暂存不是有效目录。');
    if (begun.phase === 'done') {
        requireThat(await exists(payload), 'DOWNLOAD_BINDING', '已完成任务的本机暂存不存在，请重新拉取。');
        await partialCleanup(payload); await verify(payload, manifest);
        await atomicJson(path.join(path.dirname(payload), 'manifest.json'), manifest);
        await atomicJson(path.join(path.dirname(payload), 'download.json'), {
            format: 1, job, dataset: device.remote.dataset, generation: begun.generation, digest: manifest.digest,
        });
        if (session.env.jobBound) await saveDownloadState(device, job, payload, begun, scope, 'verified');
        session.control.close();
        return { ...begun, manifest, stats: { note: '先前完成的下载已重新校验，本次没有传输文件。' } };
    }
    await enoughSpace(device.state, manifest.bytes);
    const cache = path.join(device.state, 'cache/payload');
    if (!await exists(payload)) {
        if (resume) await fs.mkdir(payload, { recursive: false, mode: 0o700 });
        else if (await exists(cache)) await copyTree(cache, payload);
        else {
            await fs.mkdir(payload, { recursive: true, mode: 0o700 });
            const basis = await seedDownloadBasis(device, payload, manifest);
            session.log?.(`下载缓存缺失，已从本机共享目录建立 ${basis.files} 个文件的差分基础；下载后仍执行完整校验。`);
        }
    }
    if (begun.phase !== 'done') await cleanHybridStage(payload, manifest);
    if (onPlan) await onPlan(transferSummary(manifest, difference(manifest, await scan(payload, { ignorePartials: true }))));
    const recovery = createDownloadRecovery(session, device, job, begun, { onInterrupted: () => onProgress?.({ stage: 'interrupted', incompleteNetworkStats: true }) });
    let stats = recovery.stats(await hybridDownload(session, device, job, payload, manifest, begun, scope, recovery, onProgress));
    await onProgress?.({ stage: 'transferred', stats });
    session.log?.('下载文件 SHA-256 全量校验通过');
    await atomicJson(path.join(path.dirname(payload), 'manifest.json'), manifest);
    await atomicJson(path.join(path.dirname(payload), 'download.json'), {
        format: 1, job, dataset: device.remote.dataset, generation: begun.generation, digest: manifest.digest,
    });
    if (session.env.jobBound) await saveDownloadState(device, job, payload, begun, scope, 'verified');
    // finish releases the read job and cleans obsolete data. A lost ACK cannot invalidate bytes
    // already checked against the manifest pinned by this authenticated session.
    try { begun.maintenance = (await session.control.request('finish', { job }, 15_000)).maintenance; }
    catch (error) {
        if (!['SSH', 'SSH_TIMEOUT'].includes(error.code)) throw error;
        session.log?.('VPS 结束回执未收到；下载文件已全量校验，继续准备应用。控制连接关闭后 VPS 会释放占用。');
    } finally { session.control.close(); }
    return { ...begun, manifest, stats };
}
function requireScoped(session) {
    requireThat(session.hello.capabilities?.includes('scoped-sync-v1'), 'UPGRADE_REQUIRED', '分类增量同步需要更新 VPS 的 TavernSyn 服务程序；本次未停止酒馆或传输文件。');
}
export async function catalog(session, _device, scope) {
    requireScoped(session);
    try { return await session.control.request('catalog', { scope: normalizeScope(scope) }); }
    catch (error) {
        if (error.message.includes('EMPTY_REMOTE')) throw new SyncError('EMPTY_REMOTE', 'VPS 尚无完整同步副本，请先完成一次完整推送，再使用分类增量同步。');
        throw error;
    }
}
async function pullScoped(session, device, job, payload, onProgress, onBegin, scope, onPlan, resume) {
    requireScoped(session);
    const begun = await beginDownload(session, device, job, scope, resume, payload);
    await onBegin?.(begun);
    const manifest = validateManifest(begun.manifest);
    requireThat(sameScope(begun.scope, scope) && uuidPattern.test(begun.generation) && /^[a-f0-9]{64}$/.test(begun.publicationDigest ?? '')
        && typeof begun.environment === 'string' && manifest.files.every(file => file.path === 'environment.json' || inScope(file.path, scope)),
    'REMOTE_PROTOCOL', 'VPS 分类清单与本次选择不一致。');
    await enoughSpace(device.state, manifest.bytes);
    await noLinks(payload);
    const payloadExists = await exists(payload);
    if (payloadExists) requireThat((await fs.lstat(payload)).isDirectory(), 'DOWNLOAD_BINDING', '原下载暂存不是有效目录。');
    else {
        requireThat(begun.phase !== 'done', 'DOWNLOAD_BINDING', '已完成任务的本机暂存不存在，请重新拉取。');
        await fs.mkdir(payload, { recursive: false, mode: 0o700 });
        if (!resume) await seedDownloadBasis(device, payload, manifest);
    }
    if (begun.phase !== 'done') await writeScopedEnvironment(payload, begun.environment);
    else {
        const target = path.join(payload, 'environment.json'), expected = manifest.files.find(file => file.path === 'environment.json');
        await noLinks(target);
        const info = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        requireThat(info?.isFile() && !info.isSymbolicLink() && expected && info.size === expected.size && await hashFile(target) === expected.sha256,
            'REMOTE_PROTOCOL', '已完成分类任务的元数据与清单不一致。');
    }
    if (begun.phase !== 'done') await cleanHybridStage(payload, manifest);
    if (onPlan) await onPlan(transferSummary(manifest, difference(manifest, await scan(payload, { ignorePartials: true }))));
    const recovery = createDownloadRecovery(session, device, job, begun, { scope, onInterrupted: () => onProgress?.({ stage: 'interrupted', incompleteNetworkStats: true }) });
    let stats = { sentBytes: 0, receivedBytes: 0, literalBytes: 0, matchedBytes: 0, transferredFiles: 0 };
    if (begun.phase !== 'done') stats = recovery.stats(await hybridDownload(session, device, job, payload, manifest, begun, scope, recovery, onProgress));
    else { await partialCleanup(payload); await verify(payload, manifest); }
    await onProgress?.({ stage: 'transferred', stats });
    await atomicJson(path.join(path.dirname(payload), 'manifest.json'), manifest);
    await atomicJson(path.join(path.dirname(payload), 'download.json'), { format: 1, job, dataset: device.remote.dataset, generation: begun.generation, digest: manifest.digest, scope, publicationDigest: begun.publicationDigest });
    if (session.env.jobBound) await saveDownloadState(device, job, payload, begun, scope, 'verified');
    try { if (begun.phase !== 'done') begun.maintenance = (await session.control.request('finish', { job }, 15_000)).maintenance; }
    catch (error) { if (!['SSH', 'SSH_TIMEOUT'].includes(error.code)) throw error; }
    finally { session.control.close(); }
    return { ...begun, digest: begun.publicationDigest, manifest, stats };
}

async function saveDownloadState(device, job, payload, begun, scope, state) {
    const record = { format: 1, job, direction: 'pull', connection: connectionId(device), dataset: device.remote.dataset,
        generation: begun.generation, base: begun.base ?? null, scope, manifest: begun.manifest, state,
        ...(scope ? { publicationDigest: begun.publicationDigest, environment: begun.environment } : {}) };
    validateDownloadBinding(device, job, record);
    const file = path.join(path.dirname(payload), 'download-resume.json');
    await noLinks(file);
    await atomicJson(file, record);
    return record;
}
async function beginDownload(session, device, job, scope, resume, payload) {
    requireThat(path.resolve(payload) === path.resolve(device.state, 'jobs', job, 'payload'), 'DOWNLOAD_BINDING', '下载暂存路径与任务不一致。');
    if (resume) requireThat(session.env.jobBound === true, 'UPGRADE_REQUIRED', '下载恢复需要更新 VPS。');
    else if (!session.env.jobBound) session.log?.('VPS 不支持任务绑定；本次下载可以完成校验，但中断后不能继续原下载。');
    if (scope) requireScoped(session);
    if (resume) { const saved = await loadDownloadBinding(device, job); requireThat(canonical(saved) === canonical(resume) && sameScope(saved.scope, scope), 'DOWNLOAD_BINDING', '恢复记录或范围不一致。'); resume = saved; }
    const begun = await session.control.request('begin', { job, dataset: device.remote.dataset, direction: 'pull', jobBound: session.env.jobBound === true,
        ...(scope ? { scope } : {}), ...(resume ? { resumeOnly: true } : {}) });
    const candidate = { format: 1, job, direction: 'pull', connection: connectionId(device), dataset: device.remote.dataset,
        generation: begun.generation, base: begun.base ?? null, scope, manifest: begun.manifest, state: 'transferring',
        ...(scope ? { publicationDigest: begun.publicationDigest, environment: begun.environment } : {}) };
    validateDownloadBinding(device, job, candidate);
    requireThat(bindingMatches(resume ?? candidate, begun), 'DOWNLOAD_BINDING', 'VPS 下载回执与固定任务不一致。');
    if (session.env.jobBound) await saveDownloadState(device, job, payload, begun, scope, 'transferring');
    return begun;
}
