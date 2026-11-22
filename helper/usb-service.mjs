import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeUsb } from '../lib/usb-stream.mjs';
import { requireThat, SyncError } from '../lib/io.mjs';

export const USB_PROTOCOL = 'tavernsyn-usb-v2';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const JSON_LIMIT = 1024 * 1024;
const IO_TIMEOUT = 120000;
const UPGRADE_MESSAGE = 'USB 服务版本不兼容，请将电脑和手机都更新至最新版本，再重新打开两端的 USB 同步入口。';

function peerIdentity(value, self) {
    requireThat(value && UUID.test(value.deviceId ?? '') && typeof value.deviceName === 'string'
        && value.deviceName.length > 0 && value.deviceName.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.deviceName),
    'USB_PEER', 'USB 设备身份无效。');
    requireThat(value.deviceId !== self, 'USB_SELF', '两端设备 ID 相同，禁止向自身同步；请重新安装其中一端的独立设备配置。');
    return { deviceId: value.deviceId, deviceName: value.deviceName };
}
function jobId(value) { requireThat(UUID.test(value ?? ''), 'USB_JOB', 'USB 任务编号无效。'); return value; }
function validResult(value, expectedId, expectedDevice, expectedDigest) {
    requireThat(value && value.jobId === expectedId && value.deviceId === expectedDevice && value.digest === expectedDigest
        && SHA.test(value.digest ?? '') && value.applied === true && typeof value.maintenancePending === 'boolean',
    'USB_RESULT', 'USB 应用回执与目标设备、任务或文件摘要不匹配。');
    return value;
}
function tokenValue(token) { requireThat(typeof token === 'string' && /^[a-f0-9]{32}$/.test(token), 'USB_TOKEN', 'USB 自动连接凭据无效，请重新打开两端的 USB 同步入口。'); return token; }
function directionValue(direction) { requireThat(['push', 'pull'].includes(direction), 'USB_DIRECTION', 'USB 同步方向必须是 push 或 pull。'); return direction; }
function selectionValue(value) {
    requireThat(value && UUID.test(value.id ?? '') && ['push', 'pull'].includes(value.direction)
        && ['phone', 'computer'].includes(value.selectedBy), 'USB_SELECTION', 'USB 同步方向回执无效，请重新连接。');
    return Object.freeze({ id: value.id, direction: value.direction, selectedBy: value.selectedBy });
}
function onlyKeys(value, keys) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), 'USB_INPUT', 'USB 请求包含不支持的参数。');
}
async function jsonBody(readable) {
    const chunks = []; let size = 0;
    const length = readable.headers?.['content-length'];
    requireThat(length === undefined || (/^\d+$/.test(length) && Number(length) <= JSON_LIMIT), 'USB_JSON_SIZE', 'USB 控制请求或响应过大。');
    for await (const chunk of readable) {
        size += chunk.length;
        requireThat(size <= JSON_LIMIT, 'USB_JSON_SIZE', 'USB 控制请求或响应过大。'); chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new SyncError('USB_JSON', 'USB 控制请求或响应不是有效 JSON。'); }
}
function reply(response, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
        'cache-control': 'no-store', 'connection': 'close', 'x-content-type-options': 'nosniff' }); response.end(body);
}
function endpointOrigin(origin) {
    let url;
    try { url = new URL(origin); } catch { throw new SyncError('USB_ORIGIN', 'USB 地址必须是本机 ADB 转发端口。'); }
    requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port)
        && Number(url.port) > 0 && Number(url.port) <= 65535 && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password,
    'USB_ORIGIN', 'USB 地址必须是 http://127.0.0.1:端口，不允许网络地址或重定向。');
    return url;
}

/** A single local ADB session. The CLI retains ownership of session.close(). */
export async function startUsbServer(session, { port = 17653, token = randomBytes(16).toString('hex'), idleMs = 15 * 60 * 1000 } = {}) {
    tokenValue(token);
    requireThat(Number.isInteger(port) && port >= 0 && port <= 65535 && Number.isFinite(idleMs) && idleMs > 0, 'USB_CONFIG', 'USB 监听端口或空闲时限无效。');
    const auth = Buffer.from(`Bearer ${token}`), pending = new Set();
    let active = null, boundPeer = null, connectNonce = null, selected = null, closing = false, closePromise, idleTimer, closedResolve, connectedResolve, selectionResolve;
    const closed = new Promise(resolve => { closedResolve = resolve; });
    const connected = new Promise(resolve => { connectedResolve = resolve; });
    const selection = new Promise(resolve => { selectionResolve = resolve; });
    const failure = async error => { try { await session.fail(error); } catch { /* Preserve the original operation error. */ } };
    const run = work => {
        requireThat(!closing, 'USB_CLOSING', 'USB 会话正在关闭。');
        requireThat(!active, 'USB_BUSY', 'USB 任务正在执行，不能并发开始另一项操作。');
        const task = Promise.resolve().then(work).catch(async error => { await failure(error); throw error; });
        active = task; pending.add(task);
        const done = () => { pending.delete(task); if (active === task) active = null; };
        task.then(done, done); return task;
    };
    const status = () => ({ ...session.status(), selection: selected });
    const expectStage = stage => {
        requireThat(!closing, 'USB_CLOSING', 'USB 会话正在关闭。');
        requireThat(!active && status().stage === stage, 'USB_STAGE', 'USB 任务阶段已经改变，请检查当前终端状态。');
    };
    const matchJob = id => requireThat(jobId(id) === status().job?.id, 'USB_JOB', 'USB 请求不属于当前任务。');
    const matchPeer = value => {
        const peer = peerIdentity(value, session.device.deviceId);
        requireThat(boundPeer && peer.deviceId === boundPeer.deviceId && peer.deviceName === boundPeer.deviceName,
            'USB_PEER', 'USB 连接的设备身份发生变化，请重新连接。');
        return boundPeer;
    };
    const bindPeer = value => {
        requireThat(!closing, 'USB_CLOSING', 'USB 会话正在关闭。');
        if (boundPeer) return matchPeer(value);
        boundPeer = Object.freeze(peerIdentity(value, session.device.deviceId)); connectedResolve(boundPeer); return boundPeer;
    };
    const chooseDirection = (direction, selectedBy = 'phone') => {
        directionValue(direction);
        requireThat(!closing, 'USB_CLOSING', 'USB 会话正在关闭。');
        if (selected) return selected;
        expectStage('idle');
        selected = Object.freeze({ id: randomUUID(), direction, selectedBy }); selectionResolve(selected); return selected;
    };
    const matchSelection = (direction, id, peer) => {
        requireThat(selected && selected.direction === direction, 'USB_DIRECTION', 'USB 操作与两端已选定的同步方向不一致。');
        requireThat(jobId(id) === selected.id, 'USB_JOB', 'USB 请求不属于已选定的同步任务。');
        return matchPeer(peer);
    };
    let server;
    const close = () => {
        if (closePromise) return closePromise;
        closing = true; clearTimeout(idleTimer); connectedResolve(null); selectionResolve(null);
        closePromise = (async () => {
            const stopped = new Promise(resolve => server.close(() => resolve()));
            server.closeIdleConnections?.();
            await Promise.all([...pending].map(task => task.catch(() => {})));
            await stopped; closedResolve();
        })();
        return closePromise;
    };
    const resetIdle = () => {
        clearTimeout(idleTimer);
        if (closing) return;
        idleTimer = setTimeout(() => { if (pending.size) resetIdle(); else void close(); }, idleMs); idleTimer.unref?.();
    };
    server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
        request.setTimeout(IO_TIMEOUT, () => request.destroy(new SyncError('USB_TIMEOUT', 'USB 接收空闲超时。')));
        response.setTimeout(IO_TIMEOUT, () => response.destroy(new SyncError('USB_TIMEOUT', 'USB 发送空闲超时。')));
        try {
            requireThat(!closing, 'USB_CLOSING', 'USB 会话正在关闭。');
            const host = request.headers.host ?? '';
            requireThat(request.headers.origin === undefined && /^127\.0\.0\.1:[1-9]\d{0,4}$/.test(host)
                && Number(host.split(':')[1]) <= 65535 && request.socket.remoteAddress === '127.0.0.1',
            'USB_AUTH', 'USB 连接校验失败，请通过数据线重新连接两端。');
            const route = `${request.method} ${request.url}`;
            if (route === 'POST /connect') {
                requireThat(request.headers['content-type']?.split(';')[0] === 'application/json', 'USB_INPUT', 'USB 控制请求必须使用 JSON。');
                const body = await jsonBody(request);
                onlyKeys(body, ['protocol', 'peer', 'nonce']);
                requireThat(body.protocol === USB_PROTOCOL, 'USB_PROTOCOL', UPGRADE_MESSAGE);
                const peer = peerIdentity(body.peer, session.device.deviceId);
                requireThat(typeof body.nonce === 'string' && /^[a-f0-9]{32}$/.test(body.nonce), 'USB_INPUT', 'USB 自动连接请求无效。');
                expectStage('idle');
                requireThat(!boundPeer || (connectNonce === body.nonce && peer.deviceId === boundPeer.deviceId && peer.deviceName === boundPeer.deviceName),
                    'USB_BUSY', 'USB 已连接另一会话，请先关闭原有 USB 同步入口。');
                bindPeer(peer); connectNonce = body.nonce; resetIdle();
                reply(response, 200, { ...status(), token }); return;
            }
            const supplied = Buffer.from(typeof request.headers.authorization === 'string' ? request.headers.authorization : '');
            requireThat(supplied.length === auth.length && timingSafeEqual(supplied, auth),
                'USB_AUTH', 'USB 自动连接已失效，请重新打开两端的 USB 同步入口。');
            resetIdle();
            if (route === 'GET /hello' || route === 'GET /status' || route === 'GET /selection') {
                requireThat(!request.headers['transfer-encoding'] && (!request.headers['content-length'] || request.headers['content-length'] === '0'), 'USB_INPUT', 'USB 查询不能包含请求正文。');
                reply(response, 200, status()); return;
            }
            if (route === 'GET /payload') {
                expectStage('exported'); matchJob(request.headers['x-tavernsyn-job']);
                const frozen = session.frozen;
                requireThat(frozen?.manifest && (frozen.payload || session.payload), 'USB_STAGE', 'USB 快照尚未准备好。');
                await run(async () => {
                    response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'connection': 'close',
                        'x-tavernsyn-job': status().job.id, 'x-tavernsyn-digest': frozen.manifest.digest });
                    await pipeline(Readable.from(encodeUsb(frozen.payload || session.payload, frozen.manifest)), response);
                }); return;
            }
            if (route === 'POST /receive') {
                expectStage('idle');
                requireThat(request.headers['content-type'] === 'application/octet-stream', 'USB_INPUT', 'USB 文件传输内容类型无效。');
                const encoded = request.headers['x-tavernsyn-peer'];
                requireThat(typeof encoded === 'string' && encoded.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(encoded), 'USB_PEER', 'USB 来源设备身份缺失。');
                let peer;
                try { peer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'))); }
                catch { throw new SyncError('USB_PEER', 'USB 来源设备身份无效。'); }
                const id = jobId(request.headers['x-tavernsyn-job']);
                const source = matchSelection('push', id, peer);
                const staged = await run(() => session.receive(request, source, id));
                reply(response, 200, staged); return;
            }
            requireThat(['POST /select', 'POST /export', 'POST /apply', 'POST /ack', 'POST /finish'].includes(route), 'USB_ROUTE', '不支持的 USB 操作。');
            requireThat(request.headers['content-type']?.split(';')[0] === 'application/json', 'USB_INPUT', 'USB 控制请求必须使用 JSON。');
            const body = await jsonBody(request);
            if (route === 'POST /select') {
                onlyKeys(body, ['peer', 'direction']); directionValue(body.direction);
                if (!selected) expectStage('idle');
                bindPeer(body.peer);
                reply(response, 200, chooseDirection(body.direction, 'computer')); return;
            }
            if (route === 'POST /export') {
                expectStage('idle'); onlyKeys(body, ['peer', 'id']);
                const id = jobId(body.id), target = matchSelection('pull', id, body.peer);
                void run(() => session.export(target, id)).catch(() => {});
                reply(response, 202, { accepted: true, id }); return;
            }
            if (route === 'POST /apply') {
                expectStage('received'); onlyKeys(body, ['id']); matchJob(body.id);
                void run(() => session.apply()).catch(() => {});
                reply(response, 202, { accepted: true, id: body.id }); return;
            }
            if (route === 'POST /ack') {
                expectStage('exported');
                onlyKeys(body, ['jobId', 'digest', 'deviceId', 'applied', 'maintenancePending']);
                validResult(body, status().job?.id, boundPeer?.deviceId, session.frozen?.manifest?.digest);
                reply(response, 200, await run(() => session.acknowledge(body))); return;
            }
            expectStage('completed'); onlyKeys(body, ['id']); matchJob(body.id);
            reply(response, 200, { complete: true });
            response.once('finish', () => { void close(); });
        } catch (error) {
            if (!response.headersSent && !response.destroyed) reply(response, error.code === 'USB_AUTH' ? 403 : 409,
                { error: error instanceof SyncError ? error.code : 'USB_FAILED', message: error instanceof SyncError ? error.message : 'USB 操作失败，请查看目标设备终端。' });
            else if (!response.destroyed) response.destroy();
        }
    });
    server.headersTimeout = 15000; server.requestTimeout = 0; server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.off('error', reject); resolve(); });
    });
    resetIdle();
    return { port: server.address().port, token, connected, chooseDirection: direction => chooseDirection(direction), selection, close, closed };
}

function client(origin, token, signal, timeout) {
    const url = endpointOrigin(origin); if (token !== null) tokenValue(token);
    const responses = new Set(), requests = new Set();
    const request = async (method, route, { json, stream, headers = {} } = {}) => {
        requireThat(token !== null || (method === 'POST' && route === '/connect'), 'USB_AUTH', 'USB 连接尚未完成。');
        const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
        let req;
        const response = new Promise((resolve, reject) => {
            req = http.request({ hostname: '127.0.0.1', port: Number(url.port), path: route, method, agent: false, signal,
                headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), connection: 'close', ...headers,
                    ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, res => {
                responses.add(res); res.once('close', () => responses.delete(res)); resolve(res);
            });
            req.setTimeout(timeout, () => req.destroy(new SyncError('USB_TIMEOUT', 'USB 连接空闲超时，请检查数据线与手机终端。')));
            requests.add(req); req.once('close', () => requests.delete(req));
            req.once('error', reject);
        });
        // Both promises receive rejection handlers immediately; a disconnect or
        // an encoder error must not leave an unhandled upload promise behind.
        const sent = stream ? pipeline(Readable.from(stream), req) : Promise.resolve(req.end(body ?? undefined));
        let res;
        try {
            [res] = await Promise.all([response, sent]);
            if (res.statusCode < 200 || res.statusCode >= 300) {
                const problem = await jsonBody(res).catch(() => null);
                const error = new SyncError(/^[A-Z][A-Z0-9_]{0,63}$/.test(problem?.error ?? '') ? problem.error : 'USB_HTTP',
                    typeof problem?.message === 'string' && problem.message.length <= 1000 ? problem.message
                        : `USB 设备拒绝操作（HTTP ${res.statusCode}）。请检查对方终端及连接状态。`);
                error.httpStatus = res.statusCode; throw error;
            }
            return res;
        } catch (error) { req.destroy(); res?.destroy(); throw error; }
    };
    const json = async (method, route, body) => {
        const res = await request(method, route, body === undefined ? {} : { json: body });
        try {
            requireThat(res.headers['content-type']?.split(';')[0] === 'application/json', 'USB_PROTOCOL', 'USB 设备返回了不兼容的控制响应。');
            return await jsonBody(res);
        } catch (error) { res.destroy(); throw error; }
    };
    return { request, json, close: () => { for (const req of requests) req.destroy(); for (const res of responses) res.destroy(); } };
}

function followAbort(controller, signal) {
    if (!signal) return () => {};
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
}

/** Automatically connect through the local ADB tunnel; either terminal may choose the direction. */
export async function connectUsbPeer(session, { origin, pollMs = 500, requestTimeoutMs = IO_TIMEOUT,
    timeoutMs = 30 * 60 * 1000, signal } = {}) {
    requireThat(Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0
        && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0, 'USB_CONFIG', 'USB 等待时限无效。');
    const local = peerIdentity(session.device), controller = new AbortController();
    const unfollow = followAbort(controller, signal);
    let bootstrap, connection, selected = null, peer, token, timer;
    const close = (reason = new SyncError('USB_CANCELLED', 'USB 连接等待已结束。')) => {
        clearTimeout(timer); unfollow(); controller.abort(reason); bootstrap?.close(); connection?.close();
    };
    timer = setTimeout(() => close(new SyncError('USB_TIMEOUT', '等待选择 USB 同步方向超时，请重新打开两端的 USB 同步入口。')), timeoutMs); timer.unref?.();
    const remember = value => {
        const next = selectionValue(value);
        requireThat(!selected || (next.id === selected.id && next.direction === selected.direction && next.selectedBy === selected.selectedBy),
            'USB_SELECTION', 'USB 已选定的同步任务发生变化，请重新连接。');
        selected ??= next; return selected;
    };
    try {
        controller.signal.throwIfAborted();
        bootstrap = client(origin, null, controller.signal, requestTimeoutMs);
        let hello;
        try { hello = await bootstrap.json('POST', '/connect', { protocol: USB_PROTOCOL, peer: local, nonce: randomBytes(16).toString('hex') }); }
        catch (error) {
            if (['USB_AUTH', 'USB_ROUTE'].includes(error.code) || error.httpStatus === 404) throw new SyncError('USB_PROTOCOL', UPGRADE_MESSAGE);
            throw error;
        }
        requireThat(hello.protocol === USB_PROTOCOL, 'USB_PROTOCOL', UPGRADE_MESSAGE);
        requireThat(hello.stage === 'idle', 'USB_STAGE', '对方 USB 已有任务，请等待任务结束后重新打开两端入口。');
        peer = Object.freeze(peerIdentity(hello, local.deviceId)); token = tokenValue(hello.token);
        if (hello.selection !== null && hello.selection !== undefined) remember(hello.selection);
        connection = client(origin, token, controller.signal, requestTimeoutMs);
        const chooseDirection = async direction => {
            controller.signal.throwIfAborted(); directionValue(direction);
            try { return remember(await connection.json('POST', '/select', { peer: local, direction })); }
            catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
        };
        const waitForSelection = async ({ signal: waitSignal } = {}) => {
            const waiter = new AbortController();
            const detach = [followAbort(waiter, controller.signal), followAbort(waiter, waitSignal)];
            const polling = client(origin, token, waiter.signal, requestTimeoutMs);
            try {
                for (;;) {
                    waiter.signal.throwIfAborted();
                    if (selected) return selected;
                    const state = await polling.json('GET', '/selection');
                    requireThat(state.protocol === USB_PROTOCOL && state.deviceId === peer.deviceId && state.deviceName === peer.deviceName,
                        'USB_PEER', 'USB 对方设备身份发生变化，请重新连接。');
                    if (state.selection !== null && state.selection !== undefined) return remember(state.selection);
                    await delay(pollMs, undefined, { signal: waiter.signal });
                }
            } catch (error) { if (waiter.signal.aborted) throw waiter.signal.reason; throw error; }
            finally { for (const stop of detach) stop(); polling.close(); }
        };
        return { peer, token, chooseDirection, waitForSelection, close: () => close() };
    } catch (error) {
        const reported = controller.signal.aborted ? controller.signal.reason : error;
        close(); throw reported;
    } finally { bootstrap?.close(); }
}

/** The PC transfers the direction selected on either terminal; the target acknowledges each apply. */
export async function syncUsb(session, { origin, token, direction, confirmPeer = async () => {}, onProgress = () => {},
    pollMs = 1000, timeoutMs = 30 * 60 * 1000, requestTimeoutMs = IO_TIMEOUT, heartbeatMs = 60000 } = {}) {
    directionValue(direction);
    requireThat(Number.isFinite(pollMs) && pollMs > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0
        && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 && Number.isFinite(heartbeatMs) && heartbeatMs > 0,
    'USB_CONFIG', 'USB 等待时限无效。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new SyncError('USB_TIMEOUT', 'USB 同步等待超时，请检查目标终端中的实际结果。')), timeoutMs);
    timer.unref?.();
    let remoteApplyRequested = false, remoteReportedFailure = false, confirmedResult, peer, connection, heartbeat, heartbeatBusy = false;
    try {
        connection = client(origin, token, controller.signal, requestTimeoutMs);
        const hello = await connection.json('GET', '/hello');
        requireThat(hello.protocol === USB_PROTOCOL, 'USB_PROTOCOL', UPGRADE_MESSAGE);
        requireThat(hello.stage === 'idle', 'USB_STAGE', '对方 USB 已有任务，请等待任务结束后重新打开两端入口。');
        peer = peerIdentity(hello, session.device.deviceId);
        // Snapshot creation and target-side dependency preparation are local
        // operations; keep the connected service alive while they take place.
        heartbeat = setInterval(() => {
            if (heartbeatBusy) return;
            heartbeatBusy = true;
            connection.json('GET', '/status').catch(() => {}).finally(() => { heartbeatBusy = false; });
        }, heartbeatMs); heartbeat.unref?.();
        requireThat(await confirmPeer(peer) !== false, 'USB_CANCELLED', '已取消 USB 同步，未传输或覆盖数据。');
        const local = peerIdentity(session.device, peer.deviceId);
        const selected = selectionValue(await connection.json('POST', '/select', { peer: local, direction }));
        requireThat(selected.direction === direction, 'USB_DIRECTION', '另一端已选择不同的同步方向，请使用两端已选定的方向。');
        const id = selected.id;
        const poll = async wanted => {
            for (;;) {
                const status = await connection.json('GET', '/status');
                requireThat(status.protocol === USB_PROTOCOL && status.deviceId === peer.deviceId, 'USB_PEER', 'USB 对方设备身份发生变化。');
                requireThat(!status.job?.id || status.job.id === id, 'USB_JOB', 'USB 对方任务编号发生变化。');
                await onProgress(status);
                if (status.stage === 'failed') {
                    remoteReportedFailure = true;
                    throw new SyncError(status.job?.error?.code ?? 'USB_REMOTE_FAILED', status.job?.error?.message ?? '对方 USB 任务失败，请检查目标终端。');
                }
                if (status.stage === wanted) return status;
                await delay(pollMs, undefined, { signal: controller.signal });
            }
        };
        let digest, localResult;
        if (direction === 'push') {
            await onProgress({ stage: 'exporting' });
            const frozen = await session.export(peer, id); digest = frozen.manifest.digest;
            await onProgress({ stage: 'sending', bytes: frozen.manifest.bytes, files: frozen.manifest.files.length });
            const response = await connection.request('POST', '/receive', {
                stream: encodeUsb(frozen.payload || session.payload, frozen.manifest), headers: { 'content-type': 'application/octet-stream',
                    'x-tavernsyn-peer': Buffer.from(JSON.stringify(local)).toString('base64url'), 'x-tavernsyn-job': id },
            });
            const staged = await jsonBody(response);
            requireThat(staged.id === id && staged.digest === digest, 'USB_RESULT', 'USB 目标暂存回执与发送快照不一致。');
            remoteApplyRequested = true;
            await connection.json('POST', '/apply', { id });
            const completed = await poll('completed');
            confirmedResult = validResult(completed.result, id, peer.deviceId, digest);
            localResult = await session.acknowledge(confirmedResult);
        } else {
            await connection.json('POST', '/export', { peer: local, id });
            await poll('exported');
            const response = await connection.request('GET', '/payload', { headers: { 'x-tavernsyn-job': id } });
            requireThat(response.headers['content-type'] === 'application/octet-stream' && response.headers['x-tavernsyn-job'] === id
                && SHA.test(response.headers['x-tavernsyn-digest'] ?? ''), 'USB_PROTOCOL', 'USB 来源快照响应不匹配。');
            const received = await session.receive(response, peer, id); digest = received.digest;
            requireThat(digest === response.headers['x-tavernsyn-digest'], 'USB_RESULT', 'USB 来源摘要与收到的快照不匹配。');
            await onProgress({ stage: 'applying' });
            localResult = await session.apply();
            confirmedResult = validResult(localResult, id, session.device.deviceId, digest);
            await connection.json('POST', '/ack', confirmedResult);
        }
        let cleanupPending = false;
        try { await connection.json('POST', '/finish', { id }); } catch { cleanupPending = true; }
        await onProgress({ stage: 'completed', result: confirmedResult, cleanupPending });
        return { direction, peer, result: confirmedResult, localResult, cleanupPending };
    } catch (error) {
        let reported = controller.signal.aborted && controller.signal.reason instanceof SyncError ? controller.signal.reason : error;
        if (remoteApplyRequested && !confirmedResult && !remoteReportedFailure) {
            reported = new SyncError('USB_RESULT_UNKNOWN', 'USB 目标已收到应用请求，但当前未能核实最终结果。请查看手机终端和恢复记录，勿直接重复覆盖；不能据此认定已经回滚。');
        } else if (confirmedResult) {
            reported = new SyncError('USB_ACK_PENDING', '目标已应用并确认快照，但 USB 完成回执尚未全部交接。请查看两端终端；已应用的数据不会自动回滚。');
        } else if (!(reported instanceof SyncError) && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ABORT_ERR', 'ETIMEDOUT'].includes(error.code)) {
            reported = new SyncError('USB_NETWORK', 'USB 连接中断或超时，未核实同步完成。请检查数据线及两端终端的任务状态。');
        }
        if (session.status().stage !== 'completed') await Promise.resolve().then(() => session.fail(reported)).catch(() => {});
        throw reported;
    } finally {
        clearTimeout(timer); clearInterval(heartbeat); controller.abort(); connection?.close();
    }
}
