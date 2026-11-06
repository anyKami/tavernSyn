import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { Manager } from '../helper/manager.mjs';
import { recoveryStatus } from '../helper/apply.mjs';
import { atomicJson, exists, readJson } from '../lib/io.mjs';

async function withRecovery({ legacy = false } = {}) {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    const local = path.join(device.dataRoot, device.profile, 'worlds/before-pull.json'); await fs.writeFile(local, '{"previous":true}');
    // Model a retained backup from an older installation for legacy restore tests.
    const cleanup = manager.cleanupCompleted;
    if (legacy) manager.cleanupCompleted = async () => {};
    await manager.start({ direction: 'pull', tab: randomUUID() });
    await handoff(manager); await manager.done; assert.equal((await manager.status()).phase, 'SUCCEEDED');
    manager.cleanupCompleted = cleanup;
    assert.equal(await exists(local), false); assert.equal((await recoveryStatus(device)).available, legacy);
    return { device, remote, lifecycle, manager, local };
}

test('healthy pull deletes recovery and staging after durable completion', async () => {
    const { device, manager } = await withRecovery(), status = await manager.status();
    assert.equal(status.maintenancePending, false);
    assert.equal(await exists(path.join(device.state, 'recovery')), false);
    assert.equal(await exists(path.join(device.state, 'apply.json')), false);
    assert.equal((await readJson(path.join(device.state, 'last-apply.json'))).phase, 'committed');
    const job = path.join(device.state, 'jobs', status.id);
    assert.equal(await exists(path.join(job, 'candidate')), false);
    assert.equal(await exists(path.join(job, 'payload')), false);
    assert.equal(await exists(path.join(job, 'outcome.json')), true);
});

test('manual restore returns pre-pull data, keeps current sync code and leaves the VPS unchanged', async () => {
    const { device, remote, manager, local } = await withRecovery({ legacy: true }), published = structuredClone(remote.current);
    const later = path.join(device.dataRoot, device.profile, 'worlds/after-pull.json'); await fs.writeFile(later, '{"later":true}');
    const syncCode = path.join(device.install, 'public/scripts/extensions/third-party/tavernsyn/local.txt'); await fs.writeFile(syncCode, 'current synchronization version');
    manager.transport = { connect() { throw Error('restore must be fully local'); } };
    await manager.start({ direction: 'restore', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.ok((await manager.status()).history.restore);
    assert.equal(await exists(local), true); assert.equal(await exists(later), false);
    assert.equal(await fs.readFile(syncCode, 'utf8'), 'current synchronization version');
    assert.deepEqual(remote.current, published); assert.equal((await recoveryStatus(device)).available, false);
    assert.equal(await exists(path.join(device.state, 'baseline.json')), false);
    assert.equal((await readJson(path.join(device.state, 'last-apply.json'))).phase, 'rolled-back');
});

test('failed restored startup returns to the data from before restore and preserves the recovery option', async () => {
    const { device, manager, lifecycle, local } = await withRecovery({ legacy: true });
    const later = path.join(device.dataRoot, device.profile, 'worlds/after-pull.json'); await fs.writeFile(later, '{"keep":true}');
    lifecycle.failNext = true;
    await manager.start({ direction: 'restore', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED'); assert.equal((await manager.status()).error.code, 'HEALTH');
    assert.equal(lifecycle.stopped, false); assert.equal(await exists(local), false); assert.equal(await fs.readFile(later, 'utf8'), '{"keep":true}');
    assert.equal((await recoveryStatus(device)).available, true); assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'committed');
});

test('missing backup or unmanaged instance refuses manual restore before stopping anything', async () => {
    const device = await fixture(), lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle);
    await manager.start({ direction: 'restore', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'NO_RECOVERY'); assert.equal(lifecycle.starts, 0); assert.equal(lifecycle.stopped, false);
    await assert.rejects(new Manager(device, null).start({ direction: 'restore', tab: randomUUID() }), { code: 'UNMANAGED' });
    await assert.rejects(manager.start({ direction: 'restore', tab: randomUUID(), preview: true }), { code: 'INPUT' });
});

test('tampered recovery paths cannot become restore targets', async () => {
    const { device, manager, lifecycle } = await withRecovery({ legacy: true }), file = path.join(device.state, 'apply.json');
    const journal = await readJson(file); journal.steps[0].old = path.join(device.root, 'outside'); await atomicJson(file, journal);
    assert.equal((await recoveryStatus(device)).available, false); const starts = lifecycle.starts;
    await manager.start({ direction: 'restore', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'NO_RECOVERY'); assert.equal(lifecycle.starts, starts);
});
