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
test('managed USB reserves the real ST port as a token-gated, read-only progress bridge', async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-usb-monitor-'));
    const port = await choosePort();
    const token = 'a'.repeat(48);
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
        const authorized = await fetch(address, { headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal(authorized.status, 200);
        assert.equal(authorized.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await authorized.json(), { stage: 'transferring', selection: { direction: 'push' },
            job: { phase: 'DOWNLOADING', bytes: 2097152, progress: { bytes: 1048576 } } });
        bytes = 2097152;
        const complete = await fetch(address, { headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal((await complete.json()).job.progress.bytes, 2097152);
        const unauthorized = await fetch(address);
        assert.equal(unauthorized.status, 403); await unauthorized.arrayBuffer();
        const wrong = await fetch(address, { headers: { 'X-TavernSyn-USB-Watch': 'b'.repeat(48) } });
        assert.equal(wrong.status, 403); await wrong.arrayBuffer();
        const write = await fetch(address, { method: 'POST', headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal(write.status, 403); await write.arrayBuffer();
        const otherPath = await fetch(device.origin + '/', { headers: { 'X-TavernSyn-USB-Watch': token } });
        assert.equal(otherPath.status, 403); await otherPath.arrayBuffer();
    } finally {
        await session.releasePort();
        await fs.rm(state, { recursive: true, force: true });
    }
    const listener = http.createServer((req, res) => res.end('ST has restarted'));
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
    });
    assert.equal(await (await fetch(device.origin)).text(), 'ST has restarted');
    await new Promise(resolve => listener.close(resolve));
});
test('offline USB mode continues reserving the port without exposing the monitor API', async () => {
    const port = await choosePort(), state = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-usb-no-monitor-'));
    const session = new UsbSession({ origin: 'http://127.0.0.1:' + port, state });
    try {
        await session.reservePort();
        await assert.rejects(fetch('http://127.0.0.1:' + port + '/api/plugins/tavernsyn/usb/status'));
    } finally {
        await session.releasePort();
        await fs.rm(state, { recursive: true, force: true });
    }
});
