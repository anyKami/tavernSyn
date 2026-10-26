import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, temporary, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { snapshot, portableState } from '../lib/snapshot.mjs';
import { hashFile, verify } from '../lib/manifest.mjs';
import { normalizeScope, scopedPaths } from '../lib/scope.mjs';
import { prepare, buildPlan, applyPlan, rollback, recoveryStatus } from '../helper/apply.mjs';
import { Manager } from '../helper/manager.mjs';
import * as transport from '../helper/transport.mjs';
import { PROJECT } from '../lib/device.mjs';

async function storeTransport(context) {
    const root = path.join(await temporary('scoped-store'), 'store');
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.resolve('.local/msys64');
    const binary = process.platform === 'win32' ? path.join(runtime, 'usr/bin/rsync.exe') : 'rsync';
    if (process.platform === 'win32' && !await exists(binary)) { context.skip('Prepared rsync runtime required'); return null; }
    const posix = async file => process.platform === 'win32' ? (await run(path.join(path.dirname(binary), 'cygpath.exe'), ['-u', file])).stdout.trim() : file;
    const q = value => `'${value.replaceAll("'", "'\\''")}'`;
    const script = path.join(path.dirname(root), 'rsh.sh');
    await fs.writeFile(script, `#!/bin/sh\nconfig=$(${q(await posix(process.execPath))} ${q(await posix(path.join(PROJECT, 'tests/scoped-rsync-shell.mjs')))}) || exit 1\nexec ${q(process.platform === 'win32' ? await posix(binary) : binary)} --server --daemon --config="$config" .\n`);
    const shell = process.platform === 'win32' ? `"${await posix(path.join(path.dirname(binary), 'bash.exe'))}" "${await posix(script)}"` : `sh "${script}"`;
    const controls = [], logs = [];
    context.after(() => controls.forEach(control => control.close()));
    return { ...transport, root, pushes: 0, pulls: 0,
        async connect(device) {
            const child = spawn(process.env.PYTHON ?? 'python', ['-B', path.join(PROJECT, 'tests/scoped-store-fixture.py'), root, device.deviceId, device.remote.dataset], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            const control = new transport.Control(child); controls.push(control);
            const hello = await control.request('hello');
            const env = { rsync: binary, posix, rsh: shell, jobBound: true, deviceId: device.deviceId,
                authEnv: { TAVERNSYN_FIXTURE_STORE: root, TAVERNSYN_FIXTURE_RSYNC: binary, LC_ALL: 'C', RSYNC_PROTECT_ARGS: '0', RSYNC_OLD_ARGS: '0' } };
            return { hello, control, env, log: message => logs.push(message) };
        },
        async push(...args) { this.pushes++; try { return await transport.push(...args); } catch (error) { error.message += '\n' + logs.slice(-12).join('\n'); throw error; } },
        async pull(...args) { this.pulls++; try { return await transport.pull(...args); } catch (error) { error.message += '\n' + logs.slice(-12).join('\n'); throw error; } },
    };
}
async function populate(device) {
    const profile = path.join(device.dataRoot, device.profile);
    for (const [name, content] of Object.entries({ 'characters/A.png': 'synthetic card', 'chats/A/old.jsonl': '{"mes":"old"}\n', 'group chats/g.jsonl': '{"mes":"group"}\n', 'groups/g.json': '{"id":"g"}' })) {
        await fs.mkdir(path.dirname(path.join(profile, name)), { recursive: true }); await fs.writeFile(path.join(profile, name), content);
    }
}
async function publish(device, remote) {
    const job = randomUUID(), payload = path.join(device.root, job, 'payload');
    const frozen = await snapshot(device, payload), session = await remote.connect(device);
    try { return await remote.push(session, device, job, payload, frozen.manifest); } finally { session.control.close(); }
}
async function confirmAndRun(manager) {
    const confirmation = await phase(manager, 'AWAITING_CONFIRMATION', 30000);
    await manager.action('confirm', { id: confirmation.id, token: confirmation.confirmationToken });
    await handoff(manager); await manager.done;
    const status = await manager.status(); assert.equal(status.phase, 'SUCCEEDED', JSON.stringify(status.error));
    return status;
}

test('category selection rejects empty, duplicate and out-of-range input', () => {
    for (const value of [[], [['chats']], ['worlds', 'worlds'], ['settings'], ['__proto__'], 'worlds']) assert.throws(() => normalizeScope(value), { code: 'INPUT' });
    assert.deepEqual(scopedPaths(['chats']), ['profile/chats', 'profile/group chats', 'profile/groups']);
});

test('partial snapshots contain only selected data and can represent a deliberate empty category', async () => {
    const device = await fixture(); await populate(device);
    const unused = path.join(device.install, 'plugins/unrelated'); await fs.mkdir(unused);
    await fs.writeFile(path.join(unused, 'package.json'), 'malformed dependency manifest must not be read');
    const frozen = await snapshot(device, path.join(device.root, 'cards'), { scope: ['characters'] });
    assert.deepEqual(frozen.manifest.files.map(file => file.path), ['environment.json', 'profile/characters/A.png']);
    assert.equal(frozen.metadata.sourceState.digest, (await portableState(device, { scope: ['characters'] })).digest);
    for (const name of ['backups', 'tavernsyn']) {
        const file = path.join(device.dataRoot, device.profile, 'chats', name, 'session.jsonl');
        await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{"mes":"valid character name"}\n');
    }
    const chats = await snapshot(device, path.join(device.root, 'chat-names'), { scope: ['chats'] });
    for (const name of ['backups', 'tavernsyn']) assert.ok(chats.manifest.files.some(file => file.path === `profile/chats/${name}/session.jsonl`));
    const empty = await snapshot(device, path.join(device.root, 'empty'), { scope: ['worlds'] });
    await fs.unlink(path.join(device.dataRoot, device.profile, 'worlds/book.json'));
    const deleted = await snapshot(device, path.join(device.root, 'deleted'), { scope: ['worlds'] });
    assert.ok(empty.manifest.files.length > deleted.manifest.files.length);
    assert.deepEqual(deleted.manifest.files.map(file => file.path), ['environment.json']);
});

test('classification apply and interrupted rollback leave settings, cards and plugins untouched', async () => {
    const device = await fixture(); await populate(device);
    const original = await fs.readFile(path.join(device.dataRoot, device.profile, 'worlds/book.json'));
    const preserved = [path.join(device.dataRoot, device.profile, 'settings.json'), path.join(device.dataRoot, device.profile, 'characters/A.png'), path.join(device.install, 'plugins/tavernsyn/index.mjs'), device.yamlPath];
    const hashes = await Promise.all(preserved.map(hashFile));
    const root = path.join(device.state, 'jobs', randomUUID());
    const frozen = await snapshot(device, path.join(root, 'payload'), { scope: ['worlds'] });
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { local: 'keep after rollback' });
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/local.json'), { localOnly: true });
    const prepared = await prepare(device, path.join(root, 'payload'), frozen.manifest, root, { scope: ['worlds'] });
    const plan = await buildPlan(device, prepared, root);
    assert.equal(plan.format, 3);
    assert.ok(plan.steps.every(step => step.live.endsWith('worlds') || step.live.endsWith('file-attributes.json')));
    await assert.rejects(applyPlan(device, plan, { afterRename(_step, phase) { if (phase === 'new') throw Error('synthetic interruption'); } }));
    await rollback(device, plan);
    assert.equal((await readJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'))).local, 'keep after rollback');
    assert.ok(await exists(path.join(device.dataRoot, device.profile, 'worlds/local.json')));
    assert.deepEqual(await Promise.all(preserved.map(hashFile)), hashes);
    assert.notDeepEqual(await fs.readFile(path.join(device.dataRoot, device.profile, 'worlds/book.json')), original);
});

test('real protocol and rsync mirror selected categories both ways with deletions and no-change fast exit', { timeout: 120000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const source = await fixture(); await populate(source);
    const large = randomBytes(2 * 1024 * 1024), largeFile = path.join(source.dataRoot, source.profile, 'characters/large.png');
    await fs.writeFile(largeFile, large); await publish(source, remote);
    const fullBefore = await readJson(path.join(remote.root, 'current.json'));
    const beforeManifest = await readJson(path.join(remote.root, 'generations', fullBefore.generation, 'manifest.json'));
    await fs.unlink(path.join(source.dataRoot, source.profile, 'characters/A.png'));
    await fs.writeFile(path.join(source.dataRoot, source.profile, 'characters/[B].png'), 'new synthetic card');
    const changed = Buffer.from(large), stat = await fs.stat(largeFile); changed.fill(88, 70000, 74096);
    await fs.writeFile(largeFile, changed); await fs.utimes(largeFile, stat.atime, new Date(stat.mtimeMs + 3000));
    await fs.unlink(path.join(source.dataRoot, source.profile, 'worlds/book.json'));
    await fs.unlink(path.join(source.dataRoot, source.profile, 'chats/A/old.jsonl'));
    await fs.writeFile(path.join(source.dataRoot, source.profile, 'chats/A/new.jsonl'), '{"mes":"new"}\n');
    const lifecycle = new FakeLifecycle(), manager = new Manager(source, lifecycle, remote);
    const baselineFile = path.join(source.state, 'baseline.json'); await atomicJson(baselineFile, { sentinel: 'full baseline' });
    const scope = ['chats', 'characters', 'worlds'];
    await manager.start({ direction: 'push', scope, tab: randomUUID() });
    const preview = await phase(manager, 'AWAITING_CONFIRMATION', 30000); assert.ok(preview.summary.deleted >= 3);
    const pushed = await confirmAndRun(manager);
    assert.ok(pushed.stats.sentBytes < 64 * 1024 && pushed.stats.matchedBytes > 1.9 * 1024 * 1024, JSON.stringify(pushed.stats));
    assert.equal(pushed.scope.length, 3); assert.ok(pushed.remote.snapshotDigest);
    assert.deepEqual(await readJson(baselineFile), { sentinel: 'full baseline' });
    const current = await readJson(path.join(remote.root, 'current.json')), payload = path.join(remote.root, 'generations', current.generation, 'payload');
    const afterManifest = await readJson(path.join(path.dirname(payload), 'manifest.json'));
    for (const file of beforeManifest.files.filter(file => file.path !== 'environment.json' && !/^profile\/(?:chats|group chats|groups|characters|worlds)\//.test(file.path))) assert.equal(await hashFile(path.join(payload, file.path)), file.sha256);
    assert.equal(await exists(path.join(payload, 'profile/characters/A.png')), false);
    await verify(payload, afterManifest);
    assert.equal((await readJson(path.join(payload, 'environment.json'))).sourceState.digest, (await portableState(source)).digest);
    const pushes = remote.pushes, starts = lifecycle.starts;
    await manager.start({ direction: 'push', scope, tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).noChanges, true); assert.equal(remote.pushes, pushes); assert.equal(lifecycle.starts, starts);
    const target = await fixture(); target.remote = source.remote; await populate(target);
    await fs.writeFile(path.join(target.dataRoot, target.profile, 'characters/large.png'), large);
    await fs.writeFile(path.join(target.dataRoot, target.profile, 'characters/local.png'), 'delete locally');
    const localFiles = [path.join(target.dataRoot, target.profile, 'settings.json'), path.join(target.dataRoot, target.profile, 'secrets.json'), target.yamlPath, path.join(target.install, 'plugins/tavernsyn/index.mjs')];
    const localHashes = await Promise.all(localFiles.map(hashFile));
    const targetLifecycle = new FakeLifecycle(), puller = new Manager(target, targetLifecycle, remote);
    await puller.start({ direction: 'pull', scope, tab: randomUUID() });
    const pulled = await confirmAndRun(puller);
    assert.equal(pulled.summary.deleted >= 2, true);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/local.png')), false);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/[B].png')), true);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'worlds/book.json')), false);
    assert.deepEqual(await Promise.all(localFiles.map(hashFile)), localHashes);
    assert.ok(pulled.stats.receivedBytes < 64 * 1024 && pulled.stats.matchedBytes > 1.9 * 1024 * 1024, JSON.stringify(pulled.stats));
    assert.deepEqual((await recoveryStatus(target)).scope, [...scope].sort());
    const pulls = remote.pulls, targetStarts = targetLifecycle.starts;
    await puller.start({ direction: 'pull', scope, tab: randomUUID() }); await puller.done;
    assert.equal((await puller.status()).noChanges, true); assert.equal(remote.pulls, pulls); assert.equal(targetLifecycle.starts, targetStarts);
    await puller.start({ direction: 'restore', tab: randomUUID() }); await handoff(puller); await puller.done;
    assert.equal((await puller.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/local.png')), true);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/[B].png')), false);
    assert.deepEqual(await Promise.all(localFiles.map(hashFile)), localHashes);
    context.diagnostic(JSON.stringify({ upload: pushed.stats, download: pulled.stats }));
});

test('native rsync correction handles literal bracket paths under the production daemon option restrictions', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture(); await populate(device);
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'characters/[literal].png'), 'correct fixture bytes');
    await publish(device, remote);
    const session = await remote.connect(device), payload = path.join(device.state, 'jobs', randomUUID(), 'payload');
    let corrupted = false;
    session.log = message => {
        if (!corrupted && message === 'rsync 下载结束') {
            corrupted = true; writeFileSync(path.join(payload, 'profile/characters/[literal].png'), 'corrupted fixture bytes');
        }
    };
    const result = await remote.pull(session, device, randomUUID(), payload, undefined, undefined, { scope: ['characters'] });
    assert.equal(corrupted, true); assert.equal(result.stats.corrected, true);
    await verify(payload, result.manifest);
    assert.equal(await fs.readFile(path.join(payload, 'profile/characters/[literal].png'), 'utf8'), 'correct fixture bytes');
});

test('unmanaged classification pull prepares once when resumed, and autosaves require fresh confirmation', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const source = await fixture(); await publish(source, remote);
    const target = await fixture(); target.remote = source.remote;
    await atomicJson(path.join(target.dataRoot, target.profile, 'worlds/local.json'), { local: true });
    const unmanaged = new Manager(target, null, remote);
    await unmanaged.start({ direction: 'pull', scope: ['worlds'], tab: randomUUID() }); await unmanaged.done;
    const pending = await unmanaged.status(); assert.equal(pending.phase, 'PENDING_APPLY');
    assert.equal(await exists(path.join(pending.jobRoot, 'candidate')), false);
    const pulls = remote.pulls, manager = new Manager(target, new FakeLifecycle(), remote);
    await manager.action('resume-pending', { tab: randomUUID() });
    const waiting = await phase(manager, 'AWAITING_CONFIRMATION');
    await atomicJson(path.join(target.dataRoot, target.profile, 'worlds/autosave.json'), { local: 'changed during confirmation' });
    assert.deepEqual(await manager.action('confirm', { id: waiting.id, token: waiting.confirmationToken }), { ok: false, refreshed: true });
    assert.ok((await manager.status()).summary.deleted >= 2);
    await confirmAndRun(manager);
    assert.equal(remote.pulls, pulls);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'worlds/autosave.json')), false);
});

test('a lost scoped publication acknowledgement reconciles the exact merged generation without reuploading', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture(); await publish(device, remote);
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { changed: true });
    const original = remote.push;
    remote.push = async (...args) => { await original.apply(remote, args); throw Object.assign(Error('synthetic lost ACK'), { code: 'SSH' }); };
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', scope: ['worlds'], tab: randomUUID() });
    const waiting = await phase(manager, 'AWAITING_CONFIRMATION', 30000);
    await manager.action('confirm', { id: waiting.id, token: waiting.confirmationToken }); await handoff(manager); await manager.done;
    const failed = await manager.status(); assert.equal(failed.phase, 'FAILED'); assert.equal(failed.snapshotReady, true);
    const pushes = remote.pushes, starts = lifecycle.starts;
    const reconciled = await manager.reconcile(failed.id);
    assert.equal(reconciled.phase, 'SUCCEEDED'); assert.equal(reconciled.remote.generation, failed.id);
    assert.equal(remote.pushes, pushes); assert.equal(lifecycle.starts, starts);
});

test('unsupported VPS capability fails before stopping ST or sending a partial snapshot', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture(); await publish(device, remote);
    const connect = remote.connect.bind(remote), pushes = remote.pushes;
    remote.connect = async device => { const session = await connect(device); session.hello.capabilities = []; return session; };
    const lifecycle = new FakeLifecycle(); lifecycle.stop = async () => assert.fail('must not stop for an unsupported server');
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', scope: ['worlds'], tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'UPGRADE_REQUIRED'); assert.equal(remote.pushes, pushes);
});
