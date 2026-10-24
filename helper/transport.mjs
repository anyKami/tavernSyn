import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkRemoteConfig, uuidPattern } from '../lib/device.mjs';
import { readPassword } from '../lib/connection.mjs';
import { atomicJson, exists, noLinks, readJson, requireThat, run, SyncError, removeOwned } from '../lib/io.mjs';
import { copyTree, difference, scan, validateManifest, verify } from '../lib/manifest.mjs';
import { enoughSpace } from '../lib/content.mjs';
import { rsyncOutputLog } from './sync-log.mjs';

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
        this.log = log;
        child.stdin.on('error', () => {});
        const stderr = rsyncOutputLog(line => this.log(`SSH: ${line.slice('rsync: '.length)}`));
        child.stderr.setEncoding('utf8'); child.stderr.on('data', text => stderr.write(text)); child.stderr.once('end', () => stderr.end());
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
        child.once('error', () => this.fail(new SyncError('SSH', '无法启动 SSH。')));
        child.once('close', () => { stderr.end(); this.closed = true; this.fail(new SyncError('SSH', 'SSH 连接已结束，请检查 Tailscale、账号密码和 VPS 密码登录配置；服务器身份改变也会阻止连接。')); });
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
    close() { this.child.stdin.end(); this.child.kill(); }
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
        const hello = await control.request('hello');
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
        return { control, env, hello, log };
    } catch (error) { control.close(); throw error; }
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
async function transfer(env, direction, job, payload, onProgress, correction, log = () => {}) {
    const local = `${(await env.posix(payload)).replace(/\/$/, '')}/`, remote = `${ALIAS}::payload/`;
    const args = [...RSYNC_ARGS];
    if (correction) {
        const list = path.join(path.dirname(payload), `correction-${randomUUID()}.txt`);
        await fs.writeFile(list, `${correction.join('\0')}\0`, { mode: 0o600 });
        args.splice(args.indexOf('--delete-delay'), 1);
        args.push('--from0', `--files-from=${await env.posix(list)}`, '--ignore-times');
    }
    args.push(`--rsync-path=${env.jobBound ? `tavernsyn-rsync-v2 ${env.deviceId} ${job}` : `tavernsyn-rsync-v1 ${env.deviceId}`}`, `--rsh=${env.rsh}`, '--', ...(direction === 'push' ? [local, remote] : [remote, local]));
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
        } }); } finally { output.end(); }
    log(`rsync ${direction === 'push' ? '上传' : '下载'}结束`);
    return parseStats(result.stdout);
}
function addStats(first, second) {
    if (!second) return first;
    return { ...first, ...Object.fromEntries(['sentBytes', 'receivedBytes', 'literalBytes', 'matchedBytes', 'transferredFiles'].map(k => [k, first[k] + second[k]])), corrected: true };
}
export async function push(session, device, job, payload, manifest, onProgress, onBegin) {
    validateManifest(manifest); const { control, env } = session;
    const begun = await control.request('begin', { job, dataset: device.remote.dataset, direction: 'push', base: session.hello.current?.digest ?? null, jobBound: env.jobBound === true });
    await onBegin?.(begun);
    if (['done', 'finalizing'].includes(begun.phase)) return control.request('commit', { job, manifest });
    let stats = await transfer(env, 'push', job, payload, onProgress, undefined, session.log);
    const diff = await control.request('inspect', { job, manifest });
    session.log?.(`VPS 内容校验：待补传 ${diff.changed.length} 个文件，额外 ${diff.extra.length} 个文件`);
    requireThat(!diff.extra.length, 'INTEGRITY', '上传目录仍含额外文件，拒绝发布。');
    if (diff.changed.length) stats = addStats(stats, await transfer(env, 'push', job, payload, onProgress, diff.changed, session.log));
    session.log?.('逐文件 SHA-256 校验后发布 VPS 快照');
    const published = await control.request('commit', { job, manifest });
    requireThat(published.digest === manifest.digest, 'REMOTE_PROTOCOL', 'VPS 发布回执与源快照不匹配。');
    return { ...published, stats };
}
export async function pull(session, device, job, payload, onProgress, onBegin) {
    const { control, env } = session;
    const begun = await control.request('begin', { job, dataset: device.remote.dataset, direction: 'pull', jobBound: env.jobBound === true });
    await onBegin?.(begun);
    const manifest = validateManifest(begun.manifest);
    requireThat(uuidPattern.test(begun.generation), 'REMOTE_PROTOCOL', 'VPS 下载代次无效。');
    session.log?.(`VPS 下载清单：${manifest.files.length} 个文件，${manifest.bytes} 字节；固定代次 ${begun.generation}`);
    if (begun.phase === 'done') {
        await verify(payload, manifest);
        await atomicJson(path.join(path.dirname(payload), 'manifest.json'), manifest);
        await atomicJson(path.join(path.dirname(payload), 'download.json'), {
            format: 1, job, dataset: device.remote.dataset, generation: begun.generation, digest: manifest.digest,
        });
        control.close();
        return { ...begun, manifest, stats: { note: '先前完成的下载已重新校验，本次没有传输文件。' } };
    }
    await enoughSpace(device.state, manifest.bytes);
    const cache = path.join(device.state, 'cache/payload');
    if (!await exists(payload)) {
        if (await exists(cache)) await copyTree(cache, payload);
        else await fs.mkdir(payload, { recursive: true, mode: 0o700 });
    }
    let stats = await transfer(env, 'pull', job, payload, onProgress, undefined, session.log);
    await partialCleanup(payload);
    const diff = difference(manifest, await scan(payload));
    requireThat(!diff.extra.length, 'INTEGRITY', '下载暂存区仍含额外文件。');
    const correction = [...diff.missing, ...diff.changed];
    session.log?.(`本机内容校验：缺失 ${diff.missing.length}，不一致 ${diff.changed.length}，额外 ${diff.extra.length} 个文件`);
    if (correction.length) stats = addStats(stats, await transfer(env, 'pull', job, payload, onProgress, correction, session.log));
    await partialCleanup(payload); await verify(payload, manifest);
    session.log?.('下载文件 SHA-256 全量校验通过');
    await atomicJson(path.join(path.dirname(payload), 'manifest.json'), manifest);
    await atomicJson(path.join(path.dirname(payload), 'download.json'), {
        format: 1, job, dataset: device.remote.dataset, generation: begun.generation, digest: manifest.digest,
    });
    // finish only releases a read job. A lost cleanup ACK cannot invalidate bytes
    // already checked against the manifest pinned by this authenticated session.
    try { await control.request('finish', { job }, 15_000); }
    catch (error) {
        if (!['SSH', 'SSH_TIMEOUT'].includes(error.code)) throw error;
        session.log?.('VPS 结束回执未收到；下载文件已全量校验，继续准备应用。控制连接关闭后 VPS 会释放占用。');
    } finally { control.close(); }
    return { ...begun, manifest, stats };
}
