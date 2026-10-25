import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { Manager } from '../helper/manager.mjs';
import { atomicJson, exists, readJson } from '../lib/io.mjs';
import { completionPath } from '../lib/completion.mjs';
import { recoverStopped } from '../bin/recover.mjs';

async function setup() {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps'));
    await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    return { device, remote, lifecycle, manager };
}
async function push(manager) {
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
}
async function pull(manager) {
    await manager.start({ direction: 'pull', tab: randomUUID() });
    const confirm = await phase(manager, 'AWAITING_CONFIRMATION');
    await manager.action('confirm', { id: confirm.id, token: confirm.confirmationToken });
    await handoff(manager); await manager.done;
}
const noRemote = { connect() { throw Error('local completion repair must not publish or download'); } };

test('a published push survives cache ENOSPC and repairs maintenance without another transfer', async () => {
    const { device, remote, lifecycle, manager } = await setup(), cache = manager.cache.bind(manager);
    manager.cache = async () => { throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }); };
    await push(manager);
    const status = await manager.status(), generation = remote.current.generation;
    assert.equal(status.phase, 'SUCCEEDED'); assert.equal(status.commit.kind, 'published');
    assert.deepEqual(status.maintenance.pending, ['cache']);
    assert.equal(await exists(path.join(device.state, 'jobs', status.id, 'payload')), true);
    assert.equal((await readJson(completionPath(device, status.id))).remote.generation, generation);
    await assert.rejects(manager.start({ direction: 'pull', tab: randomUUID() }), { code: 'FINALIZATION_PENDING' });
    await assert.rejects(manager.action('resume-upload', { id: status.id, tab: randomUUID() }), { code: 'JOB' });
    manager.cache = cache; manager.transport = noRemote;
    await manager.action('reconcile', { id: status.id });
    assert.equal((await manager.status()).maintenancePending, false); assert.equal(lifecycle.starts, 1);
    assert.equal(remote.current.generation, generation);
});

test('history failure after moving payload does not offer an impossible upload resume', async () => {
    const { device, manager, remote } = await setup(), history = path.join(device.state, 'history.json');
    await fs.mkdir(history); await push(manager);
    const status = await manager.status();
    assert.equal(status.phase, 'SUCCEEDED'); assert.ok(status.maintenance.pending.includes('history'));
    assert.equal(await exists(path.join(device.state, 'jobs', status.id, 'payload')), false);
    assert.equal(await exists(path.join(device.state, 'cache/payload')), true);
    await fs.rmdir(history);
    const restarted = new Manager(device, new FakeLifecycle(), noRemote);
    const repaired = await restarted.action('reconcile', { id: status.id });
    assert.equal(repaired.maintenancePending, false); assert.equal(repaired.snapshotReady, false);
    assert.equal((await readJson(history)).push, status.commit.at);
    assert.equal(remote.current.generation, status.id);
});

test('failed final status persistence is recovered from the durable outcome on a fresh manager', async () => {
    const { device, manager } = await setup(), write = manager.write.bind(manager);
    manager.write = async (phase, fields) => {
        if (phase === 'SUCCEEDED') throw Object.assign(new Error('synthetic locked status'), { code: 'EPERM' });
        return write(phase, fields);
    };
    await push(manager);
    assert.equal((await readJson(path.join(device.state, 'status.json'))).phase, 'UPLOADING');
    const restarted = new Manager(device, null, noRemote), recovered = await restarted.status();
    assert.equal(recovered.phase, 'SUCCEEDED'); assert.equal(recovered.commit.kind, 'published');
    assert.equal(recovered.maintenancePending, true);
    assert.equal((await restarted.action('reconcile', { id: recovered.id })).maintenancePending, false);
});

test('applied pull remains committed when history fails and repair does not replace data again', async () => {
    const { device, manager, lifecycle, remote } = await setup(); await push(manager);
    const local = path.join(device.dataRoot, device.profile, 'worlds/local.json'); await fs.writeFile(local, '{"old":true}');
    const start = lifecycle.start.bind(lifecycle);
    lifecycle.start = async () => {
        await start();
        const history = path.join(device.state, 'history.json'); await fs.unlink(history); await fs.mkdir(history);
    };
    await pull(manager);
    const status = await manager.status();
    assert.equal(status.phase, 'SUCCEEDED'); assert.equal(status.commit.kind, 'applied'); assert.equal(status.maintenancePending, true);
    assert.equal(await exists(local), false); assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'committed');
    await fs.rmdir(path.join(device.state, 'history.json'));
    const restarted = new Manager(device, new FakeLifecycle(), noRemote);
    assert.equal((await restarted.action('reconcile', { id: status.id })).maintenancePending, false);
    assert.equal(lifecycle.starts, 2); assert.equal(remote.current.generation, status.remote.generation);
});

test('lost publication acknowledgement can be rechecked against the exact remote generation', async () => {
    const { device, manager, remote, lifecycle } = await setup(), send = remote.push.bind(remote);
    let uploads = 0;
    remote.push = async (...args) => { uploads++; await send(...args); throw Object.assign(Error('lost commit ACK'), { code: 'SSH' }); };
    await push(manager); const failed = await manager.status();
    assert.equal(failed.phase, 'FAILED'); assert.equal(remote.current.generation, failed.id);
    const repaired = await new Manager(device, null, remote).action('reconcile', { id: failed.id });
    assert.equal(repaired.phase, 'SUCCEEDED'); assert.equal(uploads, 1); assert.equal(lifecycle.starts, 1);
});

test('a different remote generation cannot be mistaken for a committed failed push', async () => {
    const { device, manager, remote } = await setup();
    remote.push = async () => { throw Object.assign(Error('interrupted'), { code: 'SSH' }); };
    await push(manager); const failed = await manager.status();
    remote.current = { generation: randomUUID(), digest: failed.snapshotDigest };
    await assert.rejects(new Manager(device, null, remote).action('reconcile', { id: failed.id }), { code: 'COMMIT_NOT_CONFIRMED' });
    assert.equal((await manager.status()).phase, 'FAILED'); assert.equal(await exists(path.join(device.state, 'jobs', failed.id, 'payload')), true);
});

test('a committed apply journal recovers a crash before the separate outcome/status record', async () => {
    const { device, manager, lifecycle } = await setup(); await push(manager);
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/local.json'), '{"old":true}');
    await pull(manager); const success = await manager.status();
    await fs.unlink(completionPath(device, success.id));
    await atomicJson(path.join(device.state, 'status.json'), { ...success, phase: 'STARTING', commit: undefined });
    const oldOrigin = device.origin; device.origin = 'http://127.0.0.1:0';
    await recoverStopped(device); device.origin = oldOrigin;
    const recovered = await readJson(path.join(device.state, 'status.json'));
    assert.equal(recovered.phase, 'SUCCEEDED'); assert.equal(recovered.commit.kind, 'applied'); assert.equal(recovered.maintenancePending, true);
    const restarted = new Manager(device, new FakeLifecycle(), noRemote);
    assert.equal((await restarted.action('reconcile', { id: recovered.id })).maintenancePending, false);
    assert.equal(lifecycle.starts, 2);
});

test('one failed status write does not permanently poison the serialized write queue', async () => {
    const { device, manager } = await setup(); manager.job = { id: randomUUID(), phase: 'IDLE' };
    const file = path.join(device.state, 'status.json'); await fs.mkdir(file);
    await assert.rejects(manager.write('PREFLIGHT'));
    await fs.rmdir(file); await manager.write('PREVIEW');
    assert.equal((await manager.status()).phase, 'PREVIEW');
});

test('post-commit lock release failure cannot reject completion or leave the live result as failed', async () => {
    const { manager, remote } = await setup(), send = remote.push.bind(remote);
    remote.push = async (...args) => {
        const result = await send(...args), handle = manager.ownedOperation.handle;
        let first = true;
        manager.ownedOperation.handle = { async close() {
            if (first) { first = false; throw Object.assign(Error('synthetic handle close failure'), { code: 'EIO' }); }
            return handle.close();
        } };
        return result;
    };
    await push(manager); const status = await manager.status();
    assert.equal(status.phase, 'SUCCEEDED'); assert.equal(status.commit.kind, 'published');
    assert.ok(status.maintenance.pending.includes('lock')); assert.equal(manager.busy, false);
    manager.transport = noRemote;
    const repaired = await manager.action('reconcile', { id: status.id });
    assert.equal(repaired.phase, 'SUCCEEDED'); assert.equal(repaired.maintenancePending, false);
    assert.equal(manager.ownedOperation, null);
});
