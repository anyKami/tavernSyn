import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDevice, uuidPattern } from '../lib/device.mjs';
import { digest, exists, readJson, requireThat, SyncError } from '../lib/io.mjs';
import { hashFile, portablePath } from '../lib/manifest.mjs';
import { connect } from '../helper/transport.mjs';
import { configuration, configureDevice, withDeviceLock } from '../lib/connection.mjs';
import { recoveryStatus } from '../helper/apply.mjs';
import { progressDetail } from '../ui/progress.js';

export const info = { id: 'tavernsyn', name: 'TavernSyn', description: '跨设备同步与受控重启' };
let lease;
function plainName(value) { portablePath(value); requireThat(!value.includes('/'), 'INPUT', '文件标识无效。'); return value; }
export async function savedReceipt(device, body) {
    requireThat(uuidPattern.test(body.nonce) && /^[a-f0-9]{64}$/.test(body.settingsDigest), 'INPUT', '保存确认格式无效。');
    const file = path.join(device.dataRoot, device.profile, 'settings.json');
    const settings = await readJson(file);
    requireThat(settings.extension_settings?.tavernsyn?.flushReceipt === body.nonce, 'SAVE_PENDING', '设置尚未完成落盘。');
    const projection = { extension_settings: settings.extension_settings, power_user: settings.power_user,
        oai_settings: settings.oai_settings, textgenerationwebui_settings: settings.textgenerationwebui_settings };
    requireThat(digest(JSON.parse(JSON.stringify(projection))) === body.settingsDigest, 'SAVE_PENDING', '设置保存内容尚未与页面一致。');
    const files = [{ path: file, sha256: await hashFile(file) }];
    if (body.chat) {
        requireThat(['single', 'group'].includes(body.chat.type) && /^[a-f0-9]{64}$/.test(body.chat.digest), 'INPUT', '聊天保存确认格式无效。');
        const id = plainName(body.chat.id);
        const chatFile = body.chat.type === 'group' ? path.join(device.dataRoot, device.profile, 'group chats', `${id}.jsonl`)
            : path.join(device.dataRoot, device.profile, 'chats', plainName(body.chat.avatar).replace(/\.png$/i, ''), `${id}.jsonl`);
        const lines = (await fsp.readFile(chatFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        requireThat(digest({ messages: lines.slice(1), metadata: lines[0]?.chat_metadata ?? {} }) === body.chat.digest, 'SAVE_PENDING', '聊天内容或元数据尚未与页面一致。');
        files.push({ path: chatFile, sha256: await hashFile(chatFile) });
    }
    return { nonce: body.nonce, created: Date.now(), files };
}
export async function init(router) {
    const managed = globalThis.tavernsynRuntime;
    const device = managed?.device ?? await loadDevice(process.env.TAVERNSYN_STATE);
    const nonce = managed?.nonce ?? randomUUID();
    const leaseFile = path.join(device.state, 'instance.lock');
    const handle = await fsp.open(leaseFile, 'wx', 0o600).catch(() => { throw new SyncError('INSTANCE_LOCK', '另一个实例或未处理的实例锁存在，TavernSyn 不会接管它。'); });
    await handle.writeFile(JSON.stringify({ nonce, pid: process.pid, install: device.install })); await handle.close();
    lease = { file: leaseFile, nonce };
    process.once('exit', releaseLease);
    let worker = null;
    async function helper(action, payload) {
        if (managed) return managed.helper(action, payload);
        if (action === 'configuration') return configuration(device);
        if (action === 'recovery') return recoveryStatus(device);
        if (action === 'configure') return configureDevice(device, action, payload);
        if (action === 'status') return await exists(path.join(device.state, 'status.json')) ? readJson(path.join(device.state, 'status.json')) : { phase: 'IDLE' };
        if (action === 'check') return withDeviceLock(device, async () => { const session = await connect(device); try { return { ok: true, ...session.hello }; } finally { session.control.close(); } });
        requireThat(action === 'start' && payload.direction === 'pull', 'UNMANAGED', '当前实例未受控；只可下载待应用数据，请通过 TavernSyn 入口启动后同步。');
        requireThat(!worker, 'BUSY', '下载助手仍在运行。');
        const log = fs.openSync(path.join(device.state, 'worker.log'), 'a');
        worker = fork(fileURLToPath(new URL('../helper/worker.mjs', import.meta.url)), [], {
            windowsHide: true, detached: true, stdio: ['ignore', log, log, 'ipc'],
            env: { ...process.env, TAVERNSYN_STATE: device.state, TAVERNSYN_TASK: JSON.stringify(payload) },
        });
        fs.closeSync(log);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new SyncError('WORKER', '下载助手未能启动。')), 15000);
            worker.once('message', message => { clearTimeout(timer); if (message.error) reject(new SyncError(message.error.code, message.error.message)); else resolve(message.result); });
            worker.once('exit', () => { worker = null; clearTimeout(timer); });
            worker.once('error', () => { worker = null; clearTimeout(timer); reject(new SyncError('WORKER', '无法创建下载助手。')); });
        });
    }
    router.use((request, response, next) => {
        const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
        if (!loopback || request.user?.profile?.admin !== true || request.user.profile.handle !== device.profile || globalThis.COMMAND_LINE_ARGS?.disableCsrf) return response.status(403).json({ error: 'ADMIN_LOCAL_ONLY', message: '同步管理要求本机管理员、绑定用户及已启用的 CSRF 保护。' });
        if (request.headers.origin) {
            try {
                const origin = new URL(request.headers.origin);
                if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || (origin.port || '80') !== new URL(device.origin).port) return response.sendStatus(403);
            } catch { return response.sendStatus(403); }
        }
        response.setHeader('cache-control', 'no-store'); next();
    });
    const endpoint = fn => async (request, response) => {
        try { await fn(request, response); }
        catch (error) { response.status(error.code === 'INPUT' || error.code === 'FILENAME' ? 400 : 409).json({ error: error.code ?? 'FAILED', message: error.code ? error.message : '操作失败，请检查本机日志；未输出敏感数据。' }); }
    };
    router.get('/status', endpoint(async (_req, res) => {
        const history = await exists(path.join(device.state, 'history.json')) ? await readJson(path.join(device.state, 'history.json')) : {};
        res.json({ ...await helper('status'), managed: !!managed, deviceName: device.deviceName, host: device.remote?.host ?? '', configured: (await helper('configuration')).configured, epoch: nonce, history, recovery: await helper('recovery'), ...(managed?.drain ? { drain: managed.drain.summary() } : {}) });
    }));
    router.post('/check', endpoint(async (_req, res) => res.json(await helper('check'))));
    router.get('/configuration', endpoint(async (_req, res) => res.json(await helper('configuration'))));
    for (const action of ['configure']) router.post(`/${action}`, endpoint(async (req, res) => {
        const result = await helper(action, req.body);
        if (action === 'configure') device.remote = (await loadDevice(device.state)).remote;
        res.json(result);
    }));
    router.post('/tabs', endpoint(async (req, res) => {
        requireThat(uuidPattern.test(req.body.tab), 'INPUT', '标签页标识无效。');
        if (managed) {
            for (const [tab, time] of managed.tabs) if (Date.now() - time > 15000) managed.tabs.delete(tab);
            managed.tabs.set(req.body.tab, Date.now());
        }
        res.json({ ok: true });
    }));
    router.post('/flush', endpoint(async (req, res) => {
        requireThat(managed, 'UNMANAGED', '严格保存回执需要受控启动。');
        const receipt = await savedReceipt(device, req.body);
        if (managed.receipts.size > 64) managed.receipts.clear(); managed.receipts.set(receipt.nonce, receipt);
        res.json({ receipt: receipt.nonce });
    }));
    router.post('/start', endpoint(async (req, res) => {
        const body = req.body;
        requireThat(Object.keys(body).every(k => ['direction', 'tab', 'preview'].includes(k)), 'INPUT', '不接受未定义的同步参数。');
        if (managed) {
            const others = [...managed.tabs].filter(([tab, time]) => tab !== body.tab && Date.now() - time < 15000);
            requireThat(!others.length, 'OTHER_TABS', '请先关闭其他正在打开的酒馆标签页，再执行同步。');
        }
        res.status(202).json(await helper('start', body));
    }));
    for (const action of ['ready', 'page', 'confirm', 'cancel', 'resume-pending', 'resume-upload']) {
        router.post(`/${action}`, endpoint(async (req, res) => {
            requireThat(Object.keys(req.body).every(k => ['id', 'receipt', 'tab', 'ticket', 'token'].includes(k)), 'INPUT', '不接受未定义的任务参数。');
            if (action === 'confirm' && managed && req.body.tab) {
                requireThat(uuidPattern.test(req.body.tab), 'INPUT', '标签页标识无效。');
                const others = [...managed.tabs].filter(([tab, time]) => tab !== req.body.tab && Date.now() - time < 15000);
                requireThat(!others.length, 'OTHER_TABS', '请先关闭其他正在打开的酒馆标签页，再确认覆盖。');
            }
            res.json(await helper(action, req.body));
        }));
    }
    router.get('/wait', endpoint(async (req, res) => {
        const { id, tab, ticket } = req.query;
        requireThat([id, tab, ticket].every(v => uuidPattern.test(v)), 'INPUT', '等待页参数无效。');
        res.type('html').send(waitPage({ id, tab, ticket, epoch: nonce }));
    }));
    if (managed) process.serverEvents.once('server-started', () => process.send?.({ channel: 'tavernsyn', type: 'ready', nonce, install: device.install, profile: device.profile, stateRoot: device.state, pluginErrors: managed.pluginErrors }));
}
function releaseLease() {
    if (!lease) return;
    try { if (JSON.parse(fs.readFileSync(lease.file, 'utf8')).nonce === lease.nonce) fs.unlinkSync(lease.file); } catch { /* A mismatched lease is never removed. */ }
    lease = null;
}
export async function exit() { releaseLease(); }
function waitPage(config) {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TavernSyn 同步</title><style>body{font:17px system-ui;background:#171b22;color:#eee;max-width:640px;margin:15vh auto;padding:24px}button{padding:12px}pre{white-space:pre-wrap;color:#b7c7da}</style><h1>正在同步酒馆</h1><p id="state">正在交接任务，请保留此页面。</p><pre id="detail"></pre><button id="back" hidden>返回酒馆</button><script>const progressDetail = ${progressDetail.toString()}; (${waitingDocument.toString()})(${JSON.stringify(config)})</script></html>`;
}
function waitingDocument(config) {
    const base = '/api/plugins/tavernsyn/';
    const labels = { QUIESCING: '正在安全停止酒馆', SNAPSHOT: '正在创建独立快照', UPLOADING: '正在上传到 VPS', APPLYING: '正在应用更新', RESTORING: '正在恢复上一版数据', STARTING: '正在重新启动', ROLLING_BACK: '正在恢复更新前的数据', SUCCEEDED: '同步完成', FAILED: '同步未完成', RECOVERY_REQUIRED: '需要恢复处理' };
    document.getElementById('back').onclick = () => location.replace('/');
    async function poll() {
        try {
            const response = await fetch(base + 'status', { cache: 'no-store' });
            if (!response.ok) throw Error();
            const status = await response.json();
            if (status.id !== config.id) { document.getElementById('state').textContent = '任务已改变，请返回酒馆检查。'; document.getElementById('back').hidden = false; return; }
            document.getElementById('state').textContent = labels[status.phase] || '正在同步';
            document.getElementById('detail').textContent = [status.error?.message || status.note || '', progressDetail(status)].filter(Boolean).join('\n');
            if (status.phase === 'SUCCEEDED') { location.replace('/'); return; }
            if (['FAILED', 'RECOVERY_REQUIRED', 'PENDING_APPLY'].includes(status.phase)) { document.getElementById('back').hidden = false; return; }
        } catch { document.getElementById('state').textContent = '酒馆正在应用或重启，等待重新连接……'; }
        setTimeout(poll, 1200);
    }
    (async () => {
        try {
            const csrf = await (await fetch('/csrf-token')).json();
            const result = await fetch(base + 'page', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.token, 'x-tavernsyn-epoch': config.epoch }, body: JSON.stringify({ id: config.id, tab: config.tab, ticket: config.ticket }) });
            if (!result.ok) throw Error();
            poll();
        } catch { document.getElementById('state').textContent = '无法确认等待页，未执行替换。请返回酒馆查看。'; document.getElementById('back').hidden = false; }
    })();
}
