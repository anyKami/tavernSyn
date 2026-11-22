import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UsbSession } from '../helper/usb-sync.mjs';

const choosePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(error => error ? reject(error) : resolve(port));
    });
});
const request = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    // Explicit connection:close/agent:false; neither tests nor the bridge
    // should retain Undici or HTTP keepalive handles across a port swap.
    const req = http.request(url, { method, headers: { connection: 'close', ...headers }, agent: false }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.once('end', () => resolve({
            status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
        }));
        res.once('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP monitor request timed out')));
    req.once('error', reject); req.end();
});
test('managed USB reserves the original ST port as a token-gated read-only progress bridge', { timeout: 15000 }, async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-usb-monitor-'));
    const port = await choosePort(), token = 'a'.repeat(48);
    let bytes = 1048576;
    const device = { state, origin: 'http://127.0.0.1:' + port, deviceId: '00000000-0000-0000-0000-000000000011',
        deviceName: 'Test phone' };
    const session = new UsbSession(device, { monitor: {
        token,
        read: () => ({ stage: 'transferring', selection: { direction: 'push' },
            job: { phase: 'DOWNLOADING', bytes: 2097152, progress: { bytes } } }),
    } });
    const address = device.origin + '/api/plugins/tavernsyn/usb/status';
    try {
        await session.reservePort();
        const authorized = await request(address, { headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal(authorized.status, 200);
        assert.equal(authorized.headers['cache-control'], 'no-store');
        assert.deepEqual(JSON.parse(authorized.text), { stage: 'transferring', selection: { direction: 'push' },
            job: { phase: 'DOWNLOADING', bytes: 2097152, progress: { bytes: 1048576 } } });
        bytes = 2097152;
        const complete = await request(address, { headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal(JSON.parse(complete.text).job.progress.bytes, 2097152);
        for (const options of [
            {}, { headers: { 'X-TavernSyn-USB-Watch': 'b'.repeat(48) } },
            { method: 'POST', headers: { 'X-TavernSyn-USB-Watch': token } },
        ]) assert.equal((await request(address, options)).status, 403);
        assert.equal((await request(device.origin + '/', { headers: { 'X-TavernSyn-USB-Watch': token } })).status, 403);
    } finally {
        await session.releasePort();
        await fs.rm(state, { recursive: true, force: true });
    }
    const listener = http.createServer((req, res) => { res.setHeader('Connection', 'close'); res.end('ST restarted'); });
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
    });
    try { assert.equal((await request(device.origin)).text, 'ST restarted'); }
    finally {
        listener.closeAllConnections?.();
        await new Promise(resolve => listener.close(resolve));
    }
});
test('offline USB keeps the same reservation without exposing a monitoring endpoint', { timeout: 15000 }, async () => {
    const port = await choosePort(), state = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-usb-no-monitor-'));
    const session = new UsbSession({ origin: 'http://127.0.0.1:' + port, state });
    try {
        await session.reservePort();
        await assert.rejects(request('http://127.0.0.1:' + port + '/api/plugins/tavernsyn/usb/status'));
    } finally {
        await session.releasePort();
        await fs.rm(state, { recursive: true, force: true });
    }
});
