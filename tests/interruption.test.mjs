import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { Manager } from '../helper/manager.mjs';
import { Control, push } from '../helper/transport.mjs';
import { atomicJson, digest, exists, readJson, SyncError } from '../lib/io.mjs';
import { fixture, FakeLifecycle, handoff, MemoryTransport } from './fixtures.mjs';

async function interrupted(afterBegin) {
    const device = await fixture(), lifecycle = new FakeLifecycle();
    const remote = new MemoryTransport(path.join(device.root, 'vps'));
    await fs.mkdir(remote.root);
    remote.push = async (_session, _device, job, _payload, _manifest, _progress, onBegin) => {
        if (afterBegin) await onBegin({ job });
        throw new SyncError(afterBegin ? 'SSH' : 'BUSY', 'synthetic interruption');
    };
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() });
    await handoff(manager); await manager.done;
    return { device, lifecycle, manager, remote, status: await manager.status() };
}

test('begin rejected by VPS does not falsely mark a remote task as owned', async () => {
    const { device, status } = await interrupted(false);
    assert.equal(status.phase, 'FAILED'); assert.equal(status.error.code, 'BUSY');
    assert.equal(status.remoteJob ?? null, null);
    assert.equal(status.snapshotReady, true);
    assert.equal(await exists(path.join(device.state, 'operation.lock')), false);
});

test('interrupted upload resumes the same verified snapshot without stopping live ST again', async () => {
    const { device, lifecycle, manager, remote, status } = await interrupted(true);
    assert.equal(status.remoteJob, status.id);
    assert.equal(status.snapshotReady, true);
    assert.equal((await readJson(path.join(device.state, 'jobs', status.id, 'job.json'))).connection, status.connection);
    const manifest = await readJson(path.join(device.state, 'jobs', status.id, 'manifest.json'));
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { newer: 'after snapshot' });
    remote.push = MemoryTransport.prototype.push;
    await manager.action('resume-upload', { id: status.id, tab: randomUUID() });
    await manager.done;
    const done = await manager.status();
    assert.equal(done.id, status.id); assert.equal(done.phase, 'SUCCEEDED');
    assert.equal(done.remote.digest, manifest.digest); assert.equal(lifecycle.starts, 1);
    assert.equal(done.error, null); assert.equal(done.remoteJob, null); assert.equal(done.snapshotReady, false);
    assert.equal((await readJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'))).newer, 'after snapshot');
    assert.ok(done.history.push);
    assert.equal((await readJson(path.join(device.state, 'baseline.json'))).connection, manager.connectionId());
});

test('resume refuses an older remote base, a changed connection, and damaged snapshot', async () => {
    const { device, manager, remote, status } = await interrupted(true);
    remote.current = { generation: randomUUID(), digest: 'a'.repeat(64) };
    await manager.action('resume-upload', { id: status.id, tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'REMOTE_CHANGED');
    remote.current = null;
    device.remote.host = 'another-vps';
    await assert.rejects(manager.action('resume-upload', { id: status.id, tab: randomUUID() }), { code: 'CONFIG_CHANGED' });
    delete device.remote.host;
    await fs.writeFile(path.join(device.state, 'jobs', status.id, 'payload/profile/worlds/book.json'), 'damaged snapshot');
    await manager.action('resume-upload', { id: status.id, tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED');
    assert.equal(remote.current, null);
});

test('transport confirms begin before notifying caller and preserves finalizing recovery', async () => {
    const manifest = { format: 1, files: [], bytes: 0, digest: digest([]) };
    const events = [];
    const session = { env: { jobBound: true }, hello: { current: null }, control: {
        async request(op, fields) {
            events.push(op);
            if (op === 'begin') { assert.equal(fields.jobBound, true); return { phase: 'finalizing' }; }
            return { digest: manifest.digest };
        },
    } };
    await push(session, { remote: { dataset: randomUUID() } }, randomUUID(), 'unused', manifest, null, () => events.push('begun'));
    assert.deepEqual(events, ['begin', 'begun', 'commit']);
    let begun = false;
    session.control.request = async () => { throw new SyncError('BUSY', 'active transfer'); };
    await assert.rejects(push(session, { remote: {} }, randomUUID(), 'unused', manifest, null, () => { begun = true; }), { code: 'BUSY' });
    assert.equal(begun, false);
});

test('structured VPS error distinguishes a live transfer from permission and upgrade failures', async () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => {};
    const control = new Control(child);
    for (const code of ['BUSY', 'PERMISSION', 'UPGRADE_REQUIRED', 'REMOTE_CHANGED']) {
        const response = control.request('begin');
        child.stdout.write(JSON.stringify({ id: control.sequence, ok: false, error: 'synthetic', code }) + '\n');
        await assert.rejects(response, { code });
    }
    control.close();
});

test('short cleanup timeout clears its waiter without extending a verified download indefinitely', async () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => {};
    const control = new Control(child);
    await assert.rejects(control.request('finish', { job: randomUUID() }, 10), { code: 'SSH_TIMEOUT' });
    assert.equal(control.waiters.size, 0);
    control.close();
});

test('failure to save local status still closes the remote control connection', async () => {
    const device = await fixture(); let closed = false;
    const remote = {
        async connect() { return { hello: { current: null }, control: { close() { closed = true; } } }; },
        async pull(_session, _device, _job, _payload, _progress, onBegin) { await onBegin({}); },
    };
    const manager = new Manager(device, null, remote);
    manager.job = { id: randomUUID(), direction: 'pull', preview: true };
    manager.write = async (_phase, fields = {}) => {
        if (fields.remoteJob) throw Error('synthetic local disk failure');
    };
    await assert.rejects(manager.execute(), /local disk failure/);
    assert.equal(closed, true);
});
