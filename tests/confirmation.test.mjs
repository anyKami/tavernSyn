import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { portableState, snapshot } from '../lib/snapshot.mjs';
import { Manager } from '../helper/manager.mjs';
import { prepare, buildPlan, applyPlan, preserveSyncCode, rollback } from '../helper/apply.mjs';

async function published() {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps'));
    await fs.mkdir(remote.root);
    const manager = new Manager(device, new FakeLifecycle(), remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    return { device, remote };
}

test('pull inventories the current local data after preparation finishes', async () => {
    const { device, remote } = await published();
    // A genuinely new remote publication must take the preparation path; an
    // identical publication now correctly completes without preparing anything.
    const incoming = await fixture(); incoming.stConfig.backups.common.numberOfBackups = 4;
    await fs.writeFile(incoming.yamlPath, incoming.YAML.stringify(incoming.stConfig));
    const payload = path.join(remote.root, randomUUID());
    const frozen = await snapshot(incoming, payload);
    remote.last = { payload, manifest: frozen.manifest };
    remote.current = { generation: randomUUID(), digest: frozen.manifest.digest };
    let changed = false;
    const file = path.join(device.dataRoot, device.profile, 'worlds/book.json');
    const manager = new Manager(device, new FakeLifecycle(), remote, (_job, line) => {
        if (!changed && line.includes('(PREPARING)')) { changed = true; writeFileSync(file, '{"savedDuringPreparation":true}'); }
    });
    await manager.start({ direction: 'pull', tab: randomUUID() });
    const saving = await phase(manager, 'AWAITING_SAVE');
    assert.equal(saving.localDigest, (await portableState(device)).digest);
    assert.equal(saving.summary.changed, 1);
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
});

test('a reloaded sole page can automatically save and own the handoff without another confirmation', async () => {
    const { device, remote } = await published();
    const book = path.join(device.dataRoot, device.profile, 'worlds/book.json');
    await atomicJson(book, { local: true });
    const manager = new Manager(device, new FakeLifecycle(), remote);
    await manager.start({ direction: 'pull', tab: randomUUID() });
    const saving = await phase(manager, 'AWAITING_SAVE');
    await assert.rejects(manager.action('ready', { id: saving.id, tab: 'invalid', receipt: randomUUID() }), { code: 'INPUT' });
    const reloadedTab = randomUUID();
    await manager.action('ready', { id: saving.id, tab: reloadedTab, receipt: randomUUID() });
    const page = await phase(manager, 'WAITING_PAGE');
    assert.equal(page.tab, reloadedTab);
    await assert.rejects(manager.action('page', { id: page.id, tab: saving.tab, ticket: page.ticket }), { code: 'JOB' });
    await manager.action('page', { id: page.id, tab: reloadedTab, ticket: page.ticket }); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    const journal = await readJson(path.join(device.state, 'last-apply.json'));
    const oldProfile = journal.steps.find(s => s.live === path.join(device.dataRoot, device.profile)).old;
    assert.equal(await exists(oldProfile), false);
});

test('first overwrite and clearing the worldbook category proceed with only the initial sync consent', async () => {
    const { device, remote } = await published();
    const other = await fixture(), phases = [];
    const replacement = new Manager(other, new FakeLifecycle(), remote, job => phases.push(job.phase));
    await fs.unlink(path.join(other.dataRoot, other.profile, 'worlds/book.json'));
    // No baseline on this device, and the VPS already contains another copy.
    await replacement.start({ direction: 'push', tab: randomUUID() }); await handoff(replacement); await replacement.done;
    assert.equal((await replacement.status()).phase, 'SUCCEEDED');
    const pull = new Manager(device, new FakeLifecycle(), remote, job => phases.push(job.phase));
    await pull.start({ direction: 'pull', tab: randomUUID() }); await handoff(pull); await pull.done;
    assert.equal((await pull.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(path.join(device.dataRoot, device.profile, 'worlds/book.json')), false);
    assert.ok(!phases.includes('AWAITING_CONFIRMATION'));
});

test('apply and restore preserve the original case of installed TavernSyn directories', async () => {
    const device = await fixture();
    const root = path.join(device.install, 'public/scripts/extensions/third-party');
    await fs.rename(path.join(root, 'tavernsyn'), path.join(root, 'temporary-sync'));
    await fs.rename(path.join(root, 'temporary-sync'), path.join(root, 'tavernSyn'));
    const frontend = path.join(root, 'tavernSyn');
    await run('git', ['init', '--initial-branch=main', frontend]);
    await run('git', ['-C', frontend, 'add', '.']);
    await run('git', ['-C', frontend, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'local sync frontend']);
    await run('git', ['-C', frontend, 'remote', 'add', 'origin', 'https://example.invalid/tavernsyn.git']);
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const frozen = await snapshot(device, payload);
    assert.ok(!frozen.manifest.files.some(f => /extensions\/tavernsyn\//i.test(f.path)));
    assert.equal(frozen.metadata.plugins.length, 0);
    const prepared = await prepare(device, payload, frozen.manifest, job);
    const plan = await buildPlan(device, prepared, job); await applyPlan(device, plan);
    assert.ok((await fs.readdir(root)).includes('tavernSyn'));
    const ui = path.join(root, 'tavernSyn/local.txt'); await fs.writeFile(ui, 'updated local UI');
    await preserveSyncCode(device, plan); await rollback(device, plan);
    assert.ok((await fs.readdir(root)).includes('tavernSyn'));
    assert.equal(await fs.readFile(ui, 'utf8'), 'updated local UI');
});
