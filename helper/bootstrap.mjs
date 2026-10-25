import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { browserEpoch, isReadOnlyScript } from './epoch.mjs';
import { createDrainTracker } from './drain.mjs';
import { loadDevice } from '../lib/device.mjs';
import { requireThat } from '../lib/io.mjs';
import { checkCompatibility } from '../adapters/release-1.19.mjs';

const device = await loadDevice(process.env.TAVERNSYN_STATE);
await checkCompatibility(device.install);
requireThat(process.send && process.env.TAVERNSYN_NONCE, 'OWNERSHIP', 'Bootstrap 必须由受控启动器创建。');
const nonce = process.env.TAVERNSYN_NONCE;
const state = { paused: false, active: 0, uncertain: false, stopping: false };
const drain = createDrainTracker(state);
const pending = new Map(), servers = new Set();
const reply = (message, value) => { if (process.connected) process.send({ channel: 'tavernsyn', type: 'reply', id: message.id, nonce, ...value }); };
const pluginErrors = [];
const originalError = console.error;
console.error = function (...args) {
    if (/^(Plugin loading failed\.|Failed to load plugin)/.test(String(args[0]))) pluginErrors.push('native-plugin-load-failed');
    originalError.apply(console, args);
};
const runtime = globalThis.tavernsynRuntime = { device, nonce, state, drain, pluginErrors, receipts: new Map(), tabs: new Map(),
    helper(action, payload = {}) {
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('启动器未响应。')); }, 30000);
            pending.set(id, { resolve, reject, timer });
            process.send({ channel: 'tavernsyn', type: 'request', nonce, id, action, payload });
        });
    },
};
function decorateHtml(request, response) {
    const pathname = new URL(request.url, device.origin).pathname;
    if (!['GET', 'HEAD'].includes(request.method) || !['/', '/index.html', '/login'].includes(pathname)) return;
    // Cached HTML may belong to Start.bat or a previous launcher epoch. A 304 or
    // partial response would reuse that stale document without running this injection.
    for (const header of ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range']) delete request.headers[header];
    // Compression middleware observes this before selecting an encoding.
    request.headers['accept-encoding'] = 'identity';
    const write = response.write.bind(response), end = response.end.bind(response), writeHead = response.writeHead.bind(response);
    // compression/sendFile may call _implicitHeader before write(). Defer the actual
    // header emission too, so Content-Length and ETag can be corrected at end().
    response.writeHead = function (status, reason, headers) {
        response.statusCode = status;
        if (typeof reason === 'string') response.statusMessage = reason;
        else headers = reason;
        if (headers) {
            if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) response.setHeader(headers[i], headers[i + 1]);
            else for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
        }
        return response;
    };
    const chunks = []; let length = 0;
    response.write = function (chunk, encoding, callback) {
        if (chunk) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined); chunks.push(buffer); length += buffer.length; }
        if (typeof encoding === 'function') encoding(); else callback?.();
        return true;
    };
    response.end = function (chunk, encoding, callback) {
        if (chunk) response.write(chunk, encoding);
        let body = Buffer.concat(chunks);
        if (request.method !== 'HEAD' && response.statusCode === 200 && String(response.getHeader('content-type')).includes('text/html') && length < 16 * 1024 * 1024) {
            const html = body.toString('utf8');
            requireThat(/<head[^>]*>/i.test(html), 'HTML_ADAPTER', '酒馆页面缺少 head，无法安装写入屏障。');
            body = Buffer.from(html.replace(/<head[^>]*>/i, match => `${match}<script>${browserEpoch(nonce)}</script>`));
            response.setHeader('content-length', body.length);
        }
        response.removeHeader('etag'); response.removeHeader('last-modified'); response.removeHeader('accept-ranges');
        response.setHeader('cache-control', 'no-store');
        if (request.method === 'HEAD') response.removeHeader('content-length');
        response.write = write; response.end = end; response.writeHead = writeHead;
        return end(body, typeof encoding === 'function' ? encoding : callback);
    };
}
for (const module of [http, https]) {
    const original = module.createServer;
    module.createServer = function (...args) {
        const index = args.length - 1, listener = args[index];
        if (typeof listener === 'function') args[index] = (request, response) => {
            response.setHeader('x-tavernsyn-epoch', nonce);
            const url = new URL(request.url, device.origin), pathname = url.pathname;
            // Browser script/module/worker requests cannot carry our fetch/XHR header.
            // Only the reviewed read-only Cocktail+ assets bypass the epoch gate.
            const readable = ['/api/plugins/tavernsyn/status', '/api/plugins/tavernsyn/wait', '/api/users/login'].includes(pathname)
                || isReadOnlyScript(request.method, url);
            if (pathname.startsWith('/api/') && !readable && request.headers['x-tavernsyn-epoch'] !== nonce) {
                response.writeHead(409, { 'content-type': 'application/json' }); response.end('{"error":"TAVERNSYN_STALE_PAGE","message":"请刷新页面后重试。"}'); return;
            }
            if (state.paused) { response.writeHead(503, { 'retry-after': '2' }); response.end('TavernSyn 正在安全重启'); return; }
            drain.track(request, response);
            decorateHtml(request, response);
            listener(request, response);
        };
        const server = original.apply(this, args); servers.add(server); return server;
    };
}
process.on('message', async message => {
    if (message?.channel !== 'tavernsyn' || message.nonce !== nonce) return;
    if (message.type === 'response') {
        const request = pending.get(message.id); if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else request.resolve(message.result);
        return;
    }
    if (message.type !== 'command') return;
    try {
        if (message.op === 'pause') {
            state.paused = true; const deadline = Date.now() + 15000;
            while (state.active && Date.now() < deadline) await delay(20);
            const error = drain.failure();
            reply(message, { ok: !error, active: state.active, uncertain: state.uncertain, ...(error ? { error } : {}) });
        } else if (message.op === 'resume') { state.paused = false; reply(message, { ok: true }); }
        else if (message.op === 'shutdown') {
            requireThat(state.paused && !state.active && !state.uncertain && !state.stopping && process.listenerCount('SIGTERM'), 'DRAIN', '存在未结束或状态不明的请求，拒绝停机。');
            state.stopping = true; for (const server of servers) server.close(); reply(message, { ok: true }); process.emit('SIGTERM');
        } else if (message.op === 'receipt') {
            const receipt = runtime.receipts.get(message.receipt);
            requireThat(receipt && Date.now() - receipt.created < 120000, 'SAVE_ACK', '保存回执已过期，请重新保存。');
            reply(message, { ok: true, receipt });
        } else if (message.op === 'ping') reply(message, { ok: true, install: device.install, profile: device.profile, stateRoot: device.state });
    } catch (error) { reply(message, { ok: false, error: { code: error.code, message: error.message } }); }
});
let terminalClosing = false;
async function closeWithTerminal() {
    if (terminalClosing) return;
    terminalClosing = true; state.paused = true;
    // A closed terminal must not leave an orphan, even after an aborted browser request.
    setTimeout(() => { console.error('启动终端已关闭；酒馆清理超时，退出并保留恢复记录。'); process.exit(1); }, 8000).unref();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('启动终端已关闭。')); }
    pending.clear();
    const deadline = Date.now() + 3000;
    while (state.active && Date.now() < deadline) await delay(20);
    for (const server of servers) server.close();
    if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
    else process.exit(0);
}
process.once('disconnect', closeWithTerminal);
process.once('SIGHUP', closeWithTerminal);
if (!process.connected) await closeWithTerminal();
// Keep ST's own argument parser untouched; the device config remains the source of port/dataRoot.
process.argv = [process.execPath, path.join(device.install, 'server.js')];
await import(pathToFileURL(path.join(device.install, 'server.js')).href);
