import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { waitForUsbPeer } from '../helper/usb-connect-wait.mjs';
import { startUsbServer, USB_PROTOCOL } from '../helper/usb-service.mjs';

function session(deviceName) {
    const device = { deviceId: randomUUID(), deviceName };
    return { device, status: () => ({ protocol: USB_PROTOCOL, ...device, stage: 'idle', job: null }),
        fail: async () => { throw new Error('Readiness must not start a transfer'); } };
}
async function availablePort() {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address();
    await new Promise(resolve => listener.close(resolve)); return port;
}
async function httpFixture(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}
function json(response, status, value) {
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); response.end(JSON.stringify(value));
}

test('USB computer entry waits through a refusal and connects when the actual phone HTTP service starts', async t => {
    const pc = session('电脑'), phone = session('手机'), port = await availablePort();
    let server, notifications = 0;
    t.after(() => server?.close());
    const link = await waitForUsbPeer(pc, { origin: `http://127.0.0.1:${port}`, waitMs: 2000, intervalMs: 5,
        onWaiting: async () => { notifications++; server = await startUsbServer(phone, { port }); } });
    t.after(() => link.close());
    assert.equal(notifications, 1); assert.deepEqual(link.peer, phone.device); assert.deepEqual(await server.connected, pc.device);
    const selection = await link.chooseDirection('pull'); assert.deepEqual(await server.selection, selection);
    assert.equal(phone.status().stage, 'idle');
});

test('USB phone entry opened first connects without a waiting notification', async t => {
    const phone = session('手机'), server = await startUsbServer(phone, { port: 0 });
    t.after(() => server.close()); let notifications = 0;
    const link = await waitForUsbPeer(session('电脑'), { origin: `http://127.0.0.1:${server.port}`,
        onWaiting: () => { notifications++; } });
    t.after(() => link.close()); assert.equal(notifications, 0); assert.deepEqual(link.peer, phone.device);
});

test('USB prebootstrap reset through a listening tunnel retries only the read-only readiness probe', async t => {
    const phone = session('手机'); let probes = 0, bootstraps = 0, notifications = 0;
    const origin = await httpFixture(t, (request, response) => {
        request.resume();
        if (request.url === '/hello') {
            probes++; assert.equal(request.method, 'GET'); assert.equal(request.headers.authorization, undefined);
            if (probes < 3) request.socket.destroy(); else json(response, 403, { error: 'USB_AUTH' });
        } else {
            bootstraps++; assert.equal(request.url, '/connect'); assert.equal(request.method, 'POST');
            json(response, 200, { ...phone.status(), selection: null, token: '12'.repeat(16) });
        }
    });
    const link = await waitForUsbPeer(session('电脑'), { origin, waitMs: 2000, intervalMs: 5, onWaiting: () => { notifications++; } });
    t.after(() => link.close()); assert.equal(probes, 3); assert.equal(bootstraps, 1); assert.equal(notifications, 1);
});

test('USB readiness wait is cancellable during its pause and expires within its bounded deadline', { timeout: 5000 }, async () => {
    const port = await availablePort(), origin = `http://127.0.0.1:${port}`, controller = new AbortController();
    const reason = new Error('User closed the terminal'); let notifications = 0;
    await assert.rejects(waitForUsbPeer(session('电脑'), { origin, signal: controller.signal, waitMs: 1000, intervalMs: 1000,
        onWaiting: () => { notifications++; controller.abort(reason); } }), error => error === reason);
    assert.equal(notifications, 1); notifications = 0;
    await assert.rejects(waitForUsbPeer(session('电脑'), { origin, waitMs: 40, intervalMs: 5,
        onWaiting: () => { notifications++; } }), { code: 'USB_TIMEOUT' });
    assert.equal(notifications, 1);
});

test('USB cancelling an active read-only probe closes its request without beginning bootstrap', async t => {
    const controller = new AbortController(), reason = new Error('Stop waiting'); let requests = 0;
    const origin = await httpFixture(t, request => {
        requests++; assert.equal(request.url, '/hello'); controller.abort(reason);
    });
    await assert.rejects(waitForUsbPeer(session('电脑'), { origin, signal: controller.signal }), error => error === reason);
    assert.equal(requests, 1);
});

test('USB protocol, authorization, and already-bound responses are never retried', async t => {
    for (const code of ['USB_PROTOCOL', 'USB_AUTH', 'USB_BUSY']) {
        let probes = 0, bootstraps = 0, notifications = 0;
        const origin = await httpFixture(t, (request, response) => {
            request.resume();
            if (request.url === '/hello') { probes++; json(response, 403, { error: 'USB_AUTH' }); }
            else { bootstraps++; json(response, code === 'USB_AUTH' ? 403 : 409, { error: code, message: code }); }
        });
        await assert.rejects(waitForUsbPeer(session('电脑'), { origin, intervalMs: 5, onWaiting: () => { notifications++; } }),
            { code: code === 'USB_AUTH' ? 'USB_PROTOCOL' : code });
        assert.equal(probes, 1); assert.equal(bootstraps, 1); assert.equal(notifications, 0);
    }
});

test('USB lost bootstrap response after a possible peer binding is not automatically repeated', async t => {
    let probes = 0, bootstraps = 0, boundPeer, notifications = 0;
    const origin = await httpFixture(t, (request, response) => {
        if (request.url === '/hello') { probes++; request.resume(); json(response, 403, { error: 'USB_AUTH' }); return; }
        bootstraps++; const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => { boundPeer = JSON.parse(Buffer.concat(chunks).toString('utf8')).peer; request.socket.destroy(); });
    });
    const pc = session('电脑');
    await assert.rejects(waitForUsbPeer(pc, { origin, intervalMs: 5, onWaiting: () => { notifications++; } }), { code: 'ECONNRESET' });
    assert.deepEqual(boundPeer, pc.device); assert.equal(probes, 1); assert.equal(bootstraps, 1); assert.equal(notifications, 0);
});

test('USB readiness probing rejects nonlocal origins and invalid waiting limits before networking', async () => {
    for (const origin of ['http://localhost:1234', 'http://example.invalid:1234', 'https://127.0.0.1:1234', 'http://127.0.0.1:1234/path']) {
        await assert.rejects(waitForUsbPeer(session('电脑'), { origin }), { code: 'USB_ORIGIN' });
    }
    for (const options of [{ waitMs: 0 }, { waitMs: 120001 }, { intervalMs: 0 }, { onWaiting: null }]) {
        await assert.rejects(waitForUsbPeer(session('电脑'), { origin: 'http://127.0.0.1:1234', ...options }), { code: 'USB_CONFIG' });
    }
});
