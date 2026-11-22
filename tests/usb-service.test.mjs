import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startUsbServer, connectUsbPeer, syncUsb, USB_PROTOCOL } from '../helper/usb-service.mjs';
import { encodeUsb, receiveUsb } from '../lib/usb-stream.mjs';
import { scan } from '../lib/manifest.mjs';

const tempRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
const TOKEN = '01'.repeat(16);
class Session {
    constructor(root, deviceName, events) {
        this.root = root; this.device = { deviceId: randomUUID(), deviceName }; this.events = events;
        this.stage = 'idle'; this.job = null; this.applyCount = 0;
    }
    status() { return { protocol: USB_PROTOCOL, ...this.device, stage: this.stage, job: this.job, ...(this.result ? { result: this.result } : {}) }; }
    async export(peer, id) {
        this.stage = 'exporting'; this.job = { id, phase: 'SNAPSHOT' }; this.peer = peer;
        await this.beforeExport?.();
        this.payload = path.join(this.root, 'source');
        this.frozen = { id, payload: this.payload, manifest: await scan(this.payload), metadata: {} };
        this.stage = 'exported'; this.events.push(`${this.device.deviceName}:export`); return this.frozen;
    }
    async receive(readable, peer, id) {
        this.stage = 'receiving'; this.job = { id, phase: 'DOWNLOADING' }; this.peer = peer;
        this.payload = path.join(this.root, 'received');
        this.manifest = await receiveUsb(readable, this.payload);
        this.stage = 'received'; this.events.push(`${this.device.deviceName}:receive`);
        return { id, digest: this.manifest.digest, files: this.manifest.files.length, bytes: this.manifest.bytes };
    }
    async apply() {
        this.stage = 'applying'; this.applyCount++;
        await this.beforeApply?.();
        this.applied = await fs.readFile(path.join(this.payload, 'settings.json'), 'utf8');
        this.result = { jobId: this.job.id, digest: this.manifest.digest, deviceId: this.device.deviceId, applied: true, maintenancePending: false };
        this.stage = 'completed'; this.job.phase = 'SUCCEEDED'; this.events.push(`${this.device.deviceName}:apply`); return this.result;
    }
    async acknowledge(result) {
        this.result = result; this.stage = 'completed'; this.job.phase = 'SUCCEEDED';
        this.events.push(`${this.device.deviceName}:ack`); return result;
    }
    async fail(error) { if (this.stage === 'completed') return; this.stage = 'failed'; this.job = { ...this.job, phase: 'FAILED', error: { code: error.code, message: error.message } }; }
}
async function fixtures(t) {
    await fs.mkdir(tempRoot, { recursive: true }); const root = await fs.mkdtemp(path.join(tempRoot, 'usb-http-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const events = [], pc = new Session(path.join(root, 'pc'), '电脑', events), phone = new Session(path.join(root, 'phone'), '手机', events);
    for (const device of [pc, phone]) {
        await fs.mkdir(path.join(device.root, 'source'), { recursive: true });
        await fs.writeFile(path.join(device.root, 'source/settings.json'), JSON.stringify({ source: device.device.deviceName }));
    }
    return { root, events, pc, phone };
}
async function serve(t, session, options = {}) {
    const server = await startUsbServer(session, { port: 0, token: TOKEN, ...options });
    t.after(() => server.close()); return { ...server, origin: `http://127.0.0.1:${server.port}` };
}
async function raw(server, method, route, { headers = {}, json, body } = {}) {
    const payload = json === undefined ? body : Buffer.from(JSON.stringify(json));
    return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: server.port, method, path: route, agent: false,
            headers: { authorization: `Bearer ${TOKEN}`, ...(json === undefined ? {} : { 'content-type': 'application/json' }),
                ...(payload ? { 'content-length': payload.length } : {}), ...headers } }, response => {
            const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
            response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
        }); request.once('error', reject); request.end(payload);
    });
}
async function until(check) {
    const end = Date.now() + 2000;
    while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for USB fixture'); await delay(5); }
}
async function select(server, pc, direction) {
    const result = await raw(server, 'POST', '/select', { json: { peer: pc.device, direction } });
    assert.equal(result.status, 200); return JSON.parse(result.text);
}
async function connect(t, pc, server, options = {}) {
    const link = await connectUsbPeer(pc, { origin: server.origin, pollMs: 5, ...options });
    t.after(() => link.close()); return link;
}

test('USB HTTP push streams real files and only acknowledges after the target applies', async t => {
    const { pc, phone, events } = await fixtures(t), server = await serve(t, phone);
    let confirmed = false;
    const result = await syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'push', pollMs: 5,
        confirmPeer: peer => { assert.equal(peer.deviceName, '手机'); assert.equal(pc.stage, 'idle'); confirmed = true; } });
    assert.equal(confirmed, true); assert.equal(result.result.applied, true); assert.equal(result.cleanupPending, false);
    assert.equal(phone.applied, '{"source":"电脑"}'); assert.equal(pc.applied, undefined);
    assert.deepEqual(events, ['电脑:export', '手机:receive', '手机:apply', '电脑:ack']);
    await server.closed;
});

test('USB HTTP pull uses the same tunnel and acknowledges the applied desktop snapshot', async t => {
    const { pc, phone, events } = await fixtures(t), server = await serve(t, phone);
    const result = await syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'pull', pollMs: 5 });
    assert.equal(result.result.deviceId, pc.device.deviceId); assert.equal(pc.applied, '{"source":"手机"}');
    assert.deepEqual(events, ['手机:export', '电脑:receive', '电脑:apply', '手机:ack']); await server.closed;
});

test('USB automatic connection exchanges its private credential without a supplied code or a confirmation', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    const link = await connect(t, pc, server);
    assert.deepEqual(link.peer, phone.device); assert.equal(link.token, TOKEN);
    assert.deepEqual(await server.connected, pc.device);
    assert.equal(pc.stage, 'idle'); assert.equal(phone.stage, 'idle');
    const hello = await raw(server, 'GET', '/hello'), state = await raw(server, 'GET', '/selection');
    for (const response of [hello, state]) {
        assert.equal(response.status, 200); assert.doesNotMatch(response.text, new RegExp(TOKEN));
        assert.equal(JSON.parse(response.text).selection, null); assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
});

for (const direction of ['push', 'pull']) {
    test(`USB phone chooses ${direction} before connection and the computer follows that direction without confirmation`, async t => {
        const { pc, phone, events } = await fixtures(t), server = await serve(t, phone);
        const choice = server.chooseDirection(direction);
        assert.equal(choice.selectedBy, 'phone'); assert.equal(choice.direction, direction);
        const link = await connect(t, pc, server);
        assert.deepEqual(await link.waitForSelection(), choice);
        assert.deepEqual(await link.chooseDirection(direction === 'push' ? 'pull' : 'push'), choice);
        link.close();
        const result = await syncUsb(pc, { origin: server.origin, token: link.token, direction: choice.direction, pollMs: 5 });
        assert.equal(result.result.jobId, choice.id); assert.equal(result.result.applied, true); assert.equal(result.cleanupPending, false);
        assert.equal(pc.applyCount + phone.applyCount, 1);
        assert.equal(direction === 'push' ? phone.applied : pc.applied, direction === 'push' ? '{"source":"电脑"}' : '{"source":"手机"}');
        assert.deepEqual(events, direction === 'push' ? ['电脑:export', '手机:receive', '手机:apply', '电脑:ack'] : ['手机:export', '电脑:receive', '电脑:apply', '手机:ack']);
        await server.closed;
    });
}

test('USB concurrent opposite computer choices resolve the same first selection on both terminals', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone), link = await connect(t, pc, server);
    const waiting = link.waitForSelection();
    const choices = await Promise.all([link.chooseDirection('push'), link.chooseDirection('pull')]);
    assert.deepEqual(choices[0], choices[1]); assert.equal(choices[0].selectedBy, 'computer');
    assert.deepEqual(await waiting, choices[0]); assert.deepEqual(await server.selection, choices[0]);
    assert.deepEqual(server.chooseDirection(choices[0].direction === 'push' ? 'pull' : 'push'), choices[0]);
    assert.equal(phone.stage, 'idle'); assert.equal(pc.stage, 'idle');
    const result = await syncUsb(pc, { origin: server.origin, token: link.token, direction: choices[0].direction, pollMs: 5 });
    assert.equal(result.result.jobId, choices[0].id); assert.equal(pc.applyCount + phone.applyCount, 1); await server.closed;
});

test('USB automatic bootstrap is POST-only, local, Origin-free JSON with a compatible protocol and a distinct peer', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    const valid = { protocol: USB_PROTOCOL, peer: pc.device, nonce: 'ef'.repeat(16) };
    for (const headers of [{ origin: 'https://example.invalid' }, { origin: '' }, { host: 'localhost:1234' }, { host: 'evil.invalid' }]) {
        const response = await raw(server, 'POST', '/connect', { headers: { authorization: '', ...headers }, json: valid });
        assert.equal(response.status, 403); assert.doesNotMatch(response.text, new RegExp(TOKEN));
    }
    for (const [method, route] of [['GET', '/connect'], ['OPTIONS', '/connect'], ['POST', '/connect?extra=1']]) {
        const response = await raw(server, method, route, { headers: { authorization: '' } });
        assert.equal(response.status, 403); assert.doesNotMatch(response.text, new RegExp(TOKEN));
    }
    for (const body of [{ ...valid, protocol: 'tavernsyn-usb-v1' }, { ...valid, peer: phone.device },
        { ...valid, peer: { ...pc.device, deviceId: 'invalid' } }, { ...valid, nonce: 'bad' }, { ...valid, extra: true }]) {
        const response = await raw(server, 'POST', '/connect', { headers: { authorization: '' }, json: body });
        assert.equal(response.status, 409); assert.doesNotMatch(response.text, new RegExp(TOKEN));
    }
    const text = await raw(server, 'POST', '/connect', { headers: { authorization: '', 'content-type': 'text/plain' }, body: Buffer.from(JSON.stringify(valid)) });
    assert.equal(text.status, 409); assert.equal(phone.stage, 'idle');
    const link = await connect(t, pc, server); assert.deepEqual(link.peer, phone.device);
});

test('USB bootstrap retries bind the same nonce and peer; another connection cannot replace them', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    const body = { protocol: USB_PROTOCOL, peer: pc.device, nonce: 'ab'.repeat(16) };
    for (let attempt = 0; attempt < 2; attempt++) {
        const response = await raw(server, 'POST', '/connect', { headers: { authorization: '' }, json: body });
        assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).token, TOKEN);
    }
    assert.deepEqual(await server.connected, pc.device);
    for (const other of [{ ...body, nonce: 'cd'.repeat(16) }, { ...body, peer: { ...pc.device, deviceId: randomUUID() } },
        { ...body, peer: { ...pc.device, deviceName: '其他设备' } }]) {
        const response = await raw(server, 'POST', '/connect', { headers: { authorization: '' }, json: other });
        assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error, 'USB_BUSY');
        assert.doesNotMatch(response.text, new RegExp(TOKEN));
    }
    const replacement = await raw(server, 'POST', '/select', { json: { peer: { ...pc.device, deviceId: randomUUID() }, direction: 'push' } });
    assert.equal(replacement.status, 409); assert.equal(JSON.parse(replacement.text).error, 'USB_PEER');
    assert.equal(phone.stage, 'idle');
});

test('USB transfer refuses an unselected direction, a different peer, or a different job before changing files', async t => {
    const { pc, phone, events } = await fixtures(t), server = await serve(t, phone), link = await connect(t, pc, server);
    let response = await raw(server, 'POST', '/export', { json: { peer: pc.device, id: randomUUID() } });
    assert.equal(JSON.parse(response.text).error, 'USB_DIRECTION');
    const selected = await link.chooseDirection('pull');
    response = await raw(server, 'POST', '/receive', { body: Buffer.from('no data'), headers: { 'content-type': 'application/octet-stream',
        'x-tavernsyn-peer': Buffer.from(JSON.stringify(pc.device)).toString('base64url'), 'x-tavernsyn-job': selected.id } });
    assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error, 'USB_DIRECTION');
    response = await raw(server, 'POST', '/export', { json: { peer: pc.device, id: randomUUID() } });
    assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error, 'USB_JOB');
    response = await raw(server, 'POST', '/export', { json: { peer: { ...pc.device, deviceId: randomUUID() }, id: selected.id } });
    assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error, 'USB_PEER');
    assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0); assert.deepEqual(events, []);
});

test('USB explicit sync cannot replace a phone-selected opposite direction or create a snapshot', async t => {
    const { pc, phone, events } = await fixtures(t), server = await serve(t, phone), link = await connect(t, pc, server);
    const selected = server.chooseDirection('pull');
    await assert.rejects(syncUsb(pc, { origin: server.origin, token: link.token, direction: 'push', pollMs: 5 }), { code: 'USB_DIRECTION' });
    assert.deepEqual(await server.selection, selected); assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0);
    assert.deepEqual(events, []); assert.equal(pc.frozen, undefined);
});

test('USB direction wait cancellation and connection closure cancel pending control waits', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone), link = await connect(t, pc, server);
    const abort = new AbortController(), reason = new Error('terminal selection was superseded');
    const cancelled = assert.rejects(link.waitForSelection({ signal: abort.signal }), error => error === reason);
    abort.abort(reason); await cancelled;
    const pending = assert.rejects(link.waitForSelection(), { code: 'USB_CANCELLED' });
    link.close(); await pending;
    assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0);
    const selected = server.chooseDirection('push'); assert.deepEqual(await server.selection, selected);
    await server.close();
});

test('USB cancelling one terminal choice still permits selection through the same automatic connection', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone), link = await connect(t, pc, server);
    const abort = new AbortController();
    const cancelled = assert.rejects(link.waitForSelection({ signal: abort.signal }), { name: 'AbortError' });
    abort.abort(); await cancelled;
    const waiting = link.waitForSelection(), selected = await link.chooseDirection('pull');
    assert.deepEqual(await waiting, selected); assert.deepEqual(await server.selection, selected);
    assert.equal(selected.direction, 'pull'); assert.equal(phone.stage, 'idle');
});

test('USB server closure resolves unconnected and unselected terminal waits without starting a task', async t => {
    const { phone } = await fixtures(t), server = await serve(t, phone);
    await server.close();
    assert.equal(await server.connected, null); assert.equal(await server.selection, null); await server.closed;
    assert.throws(() => server.chooseDirection('push'), { code: 'USB_CLOSING' });
    assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0);
});

test('USB closure rejects a partially received control request before it can start another operation', async t => {
    const { pc, phone, events } = await fixtures(t), server = await serve(t, phone), { id } = await select(server, pc, 'pull');
    const body = Buffer.from(JSON.stringify({ peer: pc.device, id }));
    const request = http.request({ hostname: '127.0.0.1', port: server.port, method: 'POST', path: '/export', agent: false,
        headers: { authorization: `Bearer ${TOKEN}`, expect: '100-continue', 'content-type': 'application/json', 'content-length': body.length } });
    const received = new Promise((resolve, reject) => {
        request.once('error', reject);
        request.once('response', response => {
            const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
            response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        });
    });
    await new Promise((resolve, reject) => { request.once('continue', resolve); request.once('error', reject); request.flushHeaders(); });
    request.write(body.subarray(0, 1));
    const closing = server.close(); request.end(body.subarray(1));
    const result = await received; assert.equal(result.status, 409); assert.equal(result.body.error, 'USB_CLOSING');
    await closing; assert.equal(phone.stage, 'idle'); assert.deepEqual(events, []);
});

test('USB automatic connection cancels before transfer and explains how to update old peers', async t => {
    const { pc } = await fixtures(t); let mode = 'auth';
    const old = http.createServer((request, response) => {
        request.resume();
        const body = mode === 'auth' ? { error: 'USB_AUTH', message: 'old server requires a code' } : { protocol: 'tavernsyn-usb-v1', stage: 'idle' };
        response.writeHead(mode === 'auth' ? 403 : mode === 'missing' ? 404 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    });
    await new Promise(resolve => old.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => old.close(resolve)));
    for (mode of ['auth', 'missing', 'v1']) {
        await assert.rejects(connectUsbPeer(pc, { origin: `http://127.0.0.1:${old.address().port}` }),
            error => error.code === 'USB_PROTOCOL' && /电脑和手机.*更新/.test(error.message));
    }
    const controller = new AbortController(), reason = new Error('cancelled before connection'); controller.abort(reason);
    await assert.rejects(connectUsbPeer(pc, { origin: `http://127.0.0.1:${old.address().port}`, signal: controller.signal }), error => error === reason);
    assert.equal(pc.stage, 'idle'); assert.equal(pc.applyCount, 0);
});

test('USB HTTP rejects missing/wrong token, cross-origin calls, invalid hosts, and unknown methods', async t => {
    const { phone } = await fixtures(t), server = await serve(t, phone);
    for (const headers of [{ authorization: '' }, { authorization: `Bearer ${'ab'.repeat(16)}` }, { origin: 'https://example.invalid' }, { host: 'evil.invalid' }]) {
        assert.equal((await raw(server, 'GET', '/hello', { headers })).status, 403);
    }
    assert.equal((await raw(server, 'OPTIONS', '/receive')).status, 409);
    const hello = await raw(server, 'GET', '/hello');
    assert.equal(hello.status, 200); assert.doesNotMatch(hello.text, new RegExp(TOKEN));
    assert.equal(hello.headers['access-control-allow-origin'], undefined); assert.equal(phone.stage, 'idle');
});

test('USB HTTP binds one task and refuses concurrent export, mismatched IDs, and forged acknowledgements', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone), { id } = await select(server, pc, 'pull');
    let release; phone.beforeExport = () => new Promise(resolve => { release = resolve; });
    assert.equal((await raw(server, 'POST', '/export', { json: { peer: pc.device, id } })).status, 202);
    await until(() => !!release);
    assert.equal((await raw(server, 'POST', '/export', { json: { peer: pc.device, id: randomUUID() } })).status, 409);
    release(); await until(() => phone.stage === 'exported');
    assert.equal((await raw(server, 'GET', '/payload', { headers: { 'x-tavernsyn-job': randomUUID() } })).status, 409);
    assert.equal((await raw(server, 'POST', '/ack', { json: { jobId: id, deviceId: randomUUID(), digest: phone.frozen.manifest.digest, applied: true, maintenancePending: false } })).status, 409);
    assert.equal((await raw(server, 'POST', '/finish', { json: { id } })).status, 409);
    assert.equal(phone.stage, 'exported');
});

test('USB corrupted uploads never advance to apply', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone), { id } = await select(server, pc, 'push');
    const frozen = await pc.export(phone.device, id), chunks = [];
    for await (const chunk of encodeUsb(frozen.payload, frozen.manifest)) chunks.push(chunk);
    const packet = Buffer.concat(chunks); packet[packet.length - 1] ^= 1;
    await raw(server, 'POST', '/receive', { body: packet, headers: { 'content-type': 'application/octet-stream',
        'x-tavernsyn-peer': Buffer.from(JSON.stringify(pc.device)).toString('base64url'), 'x-tavernsyn-job': id } }).catch(error => {
        assert(['ECONNRESET', 'EPIPE'].includes(error.code));
    });
    await until(() => phone.stage === 'failed');
    assert.equal((await raw(server, 'POST', '/apply', { json: { id } })).status, 409);
    assert.equal(phone.applyCount, 0); assert.equal(phone.applied, undefined);
    assert.equal(JSON.parse((await raw(server, 'GET', '/status')).text).job.error.code, 'INTEGRITY');
});

test('USB close waits for an in-flight apply; client reports an unknown result after disconnect', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    let release; phone.beforeApply = () => new Promise(resolve => { release = resolve; });
    const sync = syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'push', pollMs: 10 });
    const observed = assert.rejects(sync, { code: 'USB_RESULT_UNKNOWN' });
    await until(() => !!release);
    let closed = false; const closing = server.close().then(() => { closed = true; });
    await observed; assert.equal(closed, false); assert.equal(phone.stage, 'applying');
    release(); await closing;
    assert.equal(phone.stage, 'completed'); assert.equal(phone.applied, '{"source":"电脑"}');
    assert.equal(pc.stage, 'failed'); assert.doesNotMatch(pc.job.error.message, /已回滚/);
});

test('USB rejects self-sync and an explicitly declined peer before transferring', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    await assert.rejects(syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'push', confirmPeer: () => false }), { code: 'USB_CANCELLED' });
    assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0);
    const clone = new Session(path.join(pc.root, 'clone'), '同一设备', []); clone.device.deviceId = phone.device.deviceId;
    await assert.rejects(syncUsb(clone, { origin: server.origin, token: TOKEN, direction: 'pull' }), { code: 'USB_SELF' });
});

test('USB client only permits literal loopback HTTP and a valid internal session token', async t => {
    const { pc } = await fixtures(t);
    for (const origin of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.com:1234', 'http://127.0.0.1:1234/path', 'http://user@127.0.0.1:1234']) {
        await assert.rejects(syncUsb(pc, { origin, token: TOKEN, direction: 'push' }), { code: 'USB_ORIGIN' });
    }
    await assert.rejects(syncUsb(pc, { origin: 'http://127.0.0.1:1234', token: 'bad', direction: 'push' }), { code: 'USB_TOKEN' });
});

test('USB idle service closes without starting or applying a task', async t => {
    const { phone } = await fixtures(t), server = await serve(t, phone, { idleMs: 30 });
    await server.closed; assert.equal(phone.stage, 'idle'); assert.equal(phone.applyCount, 0);
});

test('USB heartbeats keep a connected source alive during long local dependency preparation', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone, { idleMs: 500 });
    pc.beforeApply = () => delay(1500);
    const result = await syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'pull', pollMs: 10, heartbeatMs: 50 });
    assert.equal(result.result.applied, true); assert.equal(result.cleanupPending, false); assert.equal(phone.stage, 'completed');
    await server.closed;
});

test('USB control timeout closes its request without leaving a pending stream', async t => {
    const { pc } = await fixtures(t);
    const silent = http.createServer(() => {});
    await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => silent.close(resolve)));
    await assert.rejects(syncUsb(pc, { origin: `http://127.0.0.1:${silent.address().port}`, token: TOKEN, direction: 'push', requestTimeoutMs: 20 }), { code: 'USB_TIMEOUT' });
    assert.equal(pc.stage, 'failed');
    await assert.rejects(syncUsb(pc, { origin: `http://127.0.0.1:${silent.address().port}`, token: TOKEN, direction: 'push',
        timeoutMs: 20, requestTimeoutMs: 1000 }), { code: 'USB_TIMEOUT' });
});

test('USB keeps a known remote application failure distinct from a lost result', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    phone.beforeApply = () => { throw Object.assign(new Error('Synthetic dependency failure before replacing files'), { code: 'DEPENDENCY' }); };
    await assert.rejects(syncUsb(pc, { origin: server.origin, token: TOKEN, direction: 'push', pollMs: 5 }), { code: 'DEPENDENCY' });
    assert.equal(pc.stage, 'failed'); assert.equal(phone.stage, 'failed'); assert.equal(phone.applied, undefined);
});

test('USB rejects oversized JSON control bodies and responses', async t => {
    const { pc, phone } = await fixtures(t), server = await serve(t, phone);
    const result = await raw(server, 'POST', '/export', { body: Buffer.alloc(1024 * 1024 + 1, 32), headers: { 'content-type': 'application/json' } }).catch(() => null);
    if (result) assert.equal(result.status, 409);
    assert.equal(phone.stage, 'idle');
    const bad = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 1024 * 1024 + 1 }); response.end(Buffer.alloc(1024 * 1024 + 1, 32)); });
    await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => bad.close(resolve)));
    await assert.rejects(syncUsb(pc, { origin: `http://127.0.0.1:${bad.address().port}`, token: TOKEN, direction: 'push' }), { code: 'USB_JSON_SIZE' });
});
