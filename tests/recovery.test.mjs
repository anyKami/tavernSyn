import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { Manager } from '../helper/manager.mjs';
import { recoveryStatus } from '../helper/apply.mjs';
import { recoverStopped } from '../bin/recover.mjs';
import { atomicJson, exists, readJson } from '../lib/io.mjs';

async function withRecovery() {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    const local = path.join(device.dataRoot, device.profile, 'worlds/before-pull.json'); await fs.writeFile(local, '{"previous":true}');
    await manager.start({ direction: 'pull', tab: randomUUID() });
    await handoff(manager); await manager.done; assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(local), false); assert.equal((await recoveryStatus(device)).available, true);
    return { device, remote, lifecycle, manager, local };
}

test('healthy pull retains the latest recovery point and removes transferred payload', async () => {
    const { device, manager } = await withRecovery(), status = await manager.status();
    assert.equal(status.maintenancePending, false);
    assert.equal(await exists(path.join(device.state, 'recovery')), true);
    const journal = await readJson(path.join(device.state, 'apply.json'));
    assert.equal(journal.phase, 'committed');
    assert.equal((await recoveryStatus(device)).available, true);
    const job = path.join(device.state, 'jobs', status.id);
    assert.equal(await exists(path.join(job, 'candidate')), true);
    for (const step of journal.steps) assert.equal(await exists(step.next), false, 'candidate contains no duplicate live roots');
    assert.equal(await exists(path.join(job, 'payload')), false);
    assert.equal(await exists(path.join(job, 'outcome.json')), true);
});

test('next overwrite replaces the previous backup and restore uses only the latest pre-apply data', async () => {
    const { device, manager, local } = await withRecovery();
    const file = path.join(device.state, 'apply.json'), previous = await readJson(file);
    const previousProfile = previous.steps.find(step => step.live === path.join(device.dataRoot, device.profile)).old;
    const second = path.join(device.dataRoot, device.profile, 'worlds/second-pull.json');
    await fs.writeFile(second, '{"latestBackup":true}');
    await manager.start({ direction: 'pull', tab: randomUUID() });
    await phase(manager, 'AWAITING_SAVE');
    assert.equal(await exists(path.join(previousProfile, 'worlds/before-pull.json')), true, 'preflight keeps the last usable restore point');
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    const latest = await readJson(file), profile = latest.steps.find(step => step.live === path.join(device.dataRoot, device.profile)).old;
    assert.notEqual(latest.jobRoot, previous.jobRoot);
    assert.equal(await exists(previous.jobRoot), false, 'retired backup staging is pruned');
    assert.equal(await exists(path.join(profile, 'worlds/before-pull.json')), false);
    assert.deepEqual(await readJson(path.join(profile, 'worlds/second-pull.json')), { latestBackup: true });
    assert.equal((await recoveryStatus(device)).available, true);
    assert.equal(await exists(second), false);
    await manager.start({ direction: 'restore', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(local), false);
    assert.deepEqual(await readJson(second), { latestBackup: true });
    assert.equal((await recoveryStatus(device)).available, false);
    assert.equal(await exists(latest.jobRoot), false, 'consumed restore staging is removed');
});

test('pushes, previews and no-change checks preserve the latest recovery point', async () => {
    const { device, manager } = await withRecovery();
    const file = path.join(device.state, 'apply.json'), original = await readJson(file);
    const unchanged = async () => {
        assert.deepEqual(await readJson(file), original);
        assert.equal((await recoveryStatus(device)).available, true);
        assert.equal(await exists(original.jobRoot), true);
    };
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).noChanges, true); await unchanged();
    for (const direction of ['push', 'pull']) {
        await manager.start({ direction, preview: true, tab: randomUUID() }); await manager.done;
        assert.equal((await manager.status()).phase, 'PREVIEW'); await unchanged();
    }
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/new-upload.json'), '{"uploaded":true}');
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); await unchanged();
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).noChanges, true); await unchanged();
});

test('cancelled preparation and failed download do not discard the last recovery point', async () => {
    const { device, manager, remote, local } = await withRecovery();
    const file = path.join(device.state, 'apply.json'), original = await readJson(file);
    await fs.writeFile(local, '{"currentLocal":true}');
    await manager.start({ direction: 'pull', tab: randomUUID() });
    const waiting = await phase(manager, 'AWAITING_SAVE');
    await manager.action('cancel', { id: waiting.id }); await manager.done;
    assert.equal((await manager.status()).error.code, 'CANCELLED');
    assert.deepEqual(await readJson(file), original);
    remote.pull = async () => { throw Object.assign(Error('USB or network disconnected'), { code: 'TRANSFER_INTERRUPTED' }); };
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'TRANSFER_INTERRUPTED');
    assert.deepEqual(await readJson(file), original);
    assert.deepEqual(await readJson(local), { currentLocal: true });
    assert.equal((await recoveryStatus(device)).available, true);
});

test('completion cleanup refuses to delete an unfinished transaction recovery point', async () => {
    const { device, manager } = await withRecovery();
    const file = path.join(device.state, 'apply.json'), journal = await readJson(file);
    await atomicJson(file, { ...journal, phase: 'applying' });
    const outcome = await readJson(path.join(journal.jobRoot, 'outcome.json'));
    await assert.rejects(manager.cleanupCompleted(outcome), { code: 'RECOVERY_REQUIRED' });
    assert.equal((await readJson(file)).phase, 'applying');
    for (const step of journal.steps) assert.equal(await exists(step.old), step.hadOld);
    assert.equal(await exists(path.join(journal.jobRoot, 'candidate')), true);
});

test('manual restore returns pre-pull data, keeps current sync code and leaves the VPS unchanged', async () => {
    const { device, remote, manager, local } = await withRecovery(), published = structuredClone(remote.current);
    const later = path.join(device.dataRoot, device.profile, 'worlds/after-pull.json'); await fs.writeFile(later, '{"later":true}');
    const syncCode = path.join(device.install, 'public/scripts/extensions/third-party/tavernsyn/local.txt'); await fs.writeFile(syncCode, 'current synchronization version');
    manager.transport = { connect() { throw Error('restore must be fully local'); } };
    await manager.start({ direction: 'restore', tab: randomUUID() });
    await phase(manager, 'AWAITING_SAVE');
    await fs.writeFile(later, '{"lastSave":true}');
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.ok((await manager.status()).history.restore);
    assert.equal(await exists(local), true); assert.equal(await exists(later), false);
    assert.equal(await fs.readFile(syncCode, 'utf8'), 'current synchronization version');
    assert.deepEqual(remote.current, published); assert.equal((await recoveryStatus(device)).available, false);
    assert.equal(await exists(path.join(device.state, 'baseline.json')), false);
    assert.equal((await readJson(path.join(device.state, 'last-apply.json'))).phase, 'rolled-back');
});

test('failed restored startup returns to the data from before restore and preserves the recovery option', async () => {
    const { device, manager, lifecycle, local } = await withRecovery();
    const later = path.join(device.dataRoot, device.profile, 'worlds/after-pull.json'); await fs.writeFile(later, '{"keep":true}');
    lifecycle.failNext = true;
    await manager.start({ direction: 'restore', tab: randomUUID() });
    await phase(manager, 'AWAITING_SAVE');
    await fs.writeFile(later, '{"lastSave":true}');
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED'); assert.equal((await manager.status()).error.code, 'HEALTH');
    assert.equal(lifecycle.stopped, false); assert.equal(await exists(local), false); assert.equal(await fs.readFile(later, 'utf8'), '{"lastSave":true}');
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
    const { device, manager, lifecycle } = await withRecovery(), file = path.join(device.state, 'apply.json');
    const journal = await readJson(file); journal.steps[0].old = path.join(device.root, 'outside'); await atomicJson(file, journal);
    assert.equal((await recoveryStatus(device)).available, false); const starts = lifecycle.starts;
    await manager.start({ direction: 'restore', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'NO_RECOVERY'); assert.equal(lifecycle.starts, starts);
});

test('automatic recovery keeps locks for a live process or occupied port', async t => {
    const device = await fixture(), server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    device.origin = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => server.listening ? server.close(resolve) : resolve()));
    const file = path.join(device.state, 'instance.lock'), lock = { nonce: randomUUID(), pid: process.pid };
    await atomicJson(file, lock);
    await assert.rejects(recoverStopped(device), /端口仍被占用/);
    assert.deepEqual(await readJson(file), lock);
    await new Promise(resolve => server.close(resolve));
    await assert.rejects(recoverStopped(device), { code: 'LIVE_PROCESS' });
    assert.deepEqual(await readJson(file), lock);
});
