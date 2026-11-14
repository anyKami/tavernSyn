import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
    const daemon = q(process.platform === 'win32' ? await posix(binary) : binary);
    const configure = `${q(await posix(process.execPath))} ${q(await posix(path.join(PROJECT, 'tests/scoped-rsync-shell.mjs')))}`;
    await fs.writeFile(script, [
        '#!/bin/sh', `config=$(${configure} "$@") || exit 1`,
        'case "$config" in', '*.cut)',
        `  ${daemon} --server --daemon --config="$config" . | while IFS= read -r line; do`,
        '    printf \'%s\\n\' "$line"',
        '    case "$line" in *"@RSYNCD: OK"*) exit 12;; esac',
        '  done', '  exit 12;;', 'esac',
        `exec ${daemon} --server --daemon --config="$config" .`, '',
    ].join('\n'));
    const shell = process.platform === 'win32' ? `"${await posix(path.join(path.dirname(binary), 'bash.exe'))}" "${await posix(script)}"` : `sh "${script}"`;
    const controls = [], logs = [];
    context.after(() => controls.forEach(control => control.close()));
    const store = { ...transport, root, pushes: 0, pulls: 0,
        async connect(device) {
            const child = spawn(process.env.PYTHON ?? 'python', ['-B', path.join(PROJECT, 'tests/scoped-store-fixture.py'), root, device.deviceId, device.remote.dataset], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            const control = new transport.Control(child); controls.push(control);
            const hello = await control.request('hello', { requiredProtocol: 'hybrid-v2' });
            const env = { rsync: binary, posix, rsh: shell, jobBound: true, deviceId: device.deviceId,
                authEnv: { TAVERNSYN_FIXTURE_STORE: root, TAVERNSYN_FIXTURE_RSYNC: binary, LC_ALL: 'C', RSYNC_PROTECT_ARGS: '0', RSYNC_OLD_ARGS: '0' } };
            const session = { hello, control, env, log: message => logs.push(message), async reconnect() {
                if (!session.control.closed) {
                    const stopped = once(session.control.child, 'close');
                    session.control.child.stdin.end();
                    await stopped;
                }
                const next = await store.connect(device);
                session.control = next.control;
                session.env = next.env;
            } };
            return session;
        },
        async push(...args) { this.pushes++; try { return await transport.push(...args); } catch (error) { error.message += '\n' + logs.slice(-12).join('\n'); throw error; } },
        async pull(...args) { this.pulls++; try { return await transport.pull(...args); } catch (error) { error.message += '\n' + logs.slice(-12).join('\n'); throw error; } },
    };
    return store;
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
async function runHandoff(manager) {
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
    const large = randomBytes(4 * 1024 * 1024), largeFile = path.join(source.dataRoot, source.profile, 'characters/large.png');
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
    const nativePush = remote.push.bind(remote);
    let plannedWithPartial = false;
    remote.push = async (session, device, job, payload, manifest, progress, onBegin, options) => {
        const partial = path.join(remote.root, 'incoming', job, 'upload/profile/characters/.tavernsyn-partial/large.png');
        return nativePush(session, device, job, payload, manifest, progress, async receipt => {
            await fs.mkdir(path.dirname(partial), { recursive: true });
            await fs.writeFile(partial, large.subarray(0, 8192));
            await onBegin(receipt);
        }, { ...options, onPlan: async plan => {
            assert.deepEqual(await fs.readFile(partial), large.subarray(0, 8192));
            plannedWithPartial = true;
            // Use the complete seeded file as the delta basis in this scenario.
            await fs.unlink(partial);
            await options.onPlan(plan);
        } });
    };
    await manager.start({ direction: 'push', scope, tab: randomUUID() });
    const preview = await phase(manager, 'AWAITING_SAVE', 30000); assert.ok(preview.summary.deleted >= 3);
    const pushed = await runHandoff(manager);
    assert.equal(plannedWithPartial, true);
    assert.ok(pushed.stats.sentBytes < 64 * 1024 && pushed.stats.matchedBytes > large.length - 64 * 1024, JSON.stringify(pushed.stats));
    assert.equal(pushed.scope.length, 3); assert.ok(pushed.remote.snapshotDigest);
    assert.deepEqual(await readJson(baselineFile), { sentinel: 'full baseline' });
    const current = await readJson(path.join(remote.root, 'current.json')), payload = path.join(remote.root, 'generations', current.generation, 'payload');
    assert.equal(await exists(path.join(path.dirname(payload), 'upload')), false);
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
    const pulled = await runHandoff(puller);
    assert.equal(pulled.summary.deleted >= 2, true);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/local.png')), false);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/[B].png')), true);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'worlds/book.json')), false);
    assert.deepEqual(await Promise.all(localFiles.map(hashFile)), localHashes);
    assert.ok(pulled.stats.receivedBytes < 64 * 1024 && pulled.stats.matchedBytes > large.length - 64 * 1024, JSON.stringify(pulled.stats));
    assert.equal((await recoveryStatus(target)).available, false);
    assert.equal(await exists(path.join(target.state, 'recovery')), false);
    const pulls = remote.pulls, targetStarts = targetLifecycle.starts;
    await puller.start({ direction: 'pull', scope, tab: randomUUID() }); await puller.done;
    assert.equal((await puller.status()).noChanges, true); assert.equal(remote.pulls, pulls); assert.equal(targetLifecycle.starts, targetStarts);
    await puller.start({ direction: 'restore', tab: randomUUID() }); await puller.done;
    assert.equal((await puller.status()).error.code, 'NO_RECOVERY');
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/local.png')), false);
    assert.equal(await exists(path.join(target.dataRoot, target.profile, 'characters/[B].png')), true);
    assert.deepEqual(await Promise.all(localFiles.map(hashFile)), localHashes);
    context.diagnostic(JSON.stringify({ upload: pushed.stats, download: pulled.stats }));
});

test('native rsync correction handles literal bracket paths under the production daemon option restrictions', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const source = await fixture(); await populate(source);
    const expected = randomBytes(3 * 1024 * 1024 + 1);
    const original = path.join(source.dataRoot, source.profile, 'characters/[literal].png');
    await fs.writeFile(original, expected);
    await fs.utimes(original, 1700000000, 1700000000);
    await publish(source, remote);
    const device = await fixture(); device.remote = source.remote;
    const bad = path.join(device.dataRoot, device.profile, 'characters/[literal].png');
    await fs.writeFile(bad, Buffer.alloc(expected.length));
    await fs.utimes(bad, 1700000000, 1700000000);
    const job = randomUUID(), session = await remote.connect(device), payload = path.join(device.state, 'jobs', job, 'payload');
    const result = await remote.pull(session, device, job, payload, undefined, undefined, { scope: ['characters'] });
    assert.equal(result.stats.corrected, true);
    await verify(payload, result.manifest);
    assert.deepEqual(await fs.readFile(path.join(payload, 'profile/characters/[literal].png')), expected);
});

test('full hybrid push and pull use one generation and handle file-directory conversions', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const source = await fixture(), profile = path.join(source.dataRoot, source.profile);
    const target = await fixture(); target.remote = source.remote;
    const targetProfile = path.join(target.dataRoot, target.profile);
    for (const root of [profile, targetProfile]) {
        await fs.mkdir(path.join(root, 'worlds/to-file'), { recursive: true });
        await fs.writeFile(path.join(root, 'worlds/to-file/old.json'), '{}');
        await fs.writeFile(path.join(root, 'worlds/to-directory'), '{}');
    }
    await publish(source, remote);
    await fs.unlink(path.join(profile, 'worlds/to-file/old.json'));
    await fs.rmdir(path.join(profile, 'worlds/to-file'));
    await fs.writeFile(path.join(profile, 'worlds/to-file'), '{"new":true}');
    await fs.unlink(path.join(profile, 'worlds/to-directory'));
    await fs.mkdir(path.join(profile, 'worlds/to-directory'));
    await fs.writeFile(path.join(profile, 'worlds/to-directory/large.bin'), randomBytes(3 * 1024 * 1024 + 1));
    const upload = randomUUID(), staged = path.join(source.root, upload, 'payload');
    const { manifest } = await snapshot(source, staged);
    const sender = await remote.connect(source);
    let commits = 0;
    const request = sender.control.request.bind(sender.control);
    sender.control.request = (...args) => { if (args[0] === 'commit') commits++; return request(...args); };
    try {
        const result = await remote.push(sender, source, upload, staged, manifest, undefined, async () => {
            const incoming = path.join(remote.root, 'incoming', upload, 'payload/profile/worlds/to-file/.tavernsyn-partial');
            await fs.mkdir(incoming, { recursive: true }); await fs.writeFile(path.join(incoming, 'old.json'), 'partial');
        });
        assert.equal(result.generation, upload); assert.equal(commits, 1);
    } finally { sender.control.close(); }
    const download = randomUUID(), receiver = await remote.connect(target);
    const received = path.join(target.state, 'jobs', download, 'payload');
    const longName = 'x'.repeat(115) + '.json';
    const residue = path.join(received, 'profile/worlds', `${longName}.${randomUUID()}.tmp`);
    await fs.mkdir(path.dirname(residue), { recursive: true });
    await fs.writeFile(residue, 'interrupted unpacking residue');
    const result = await remote.pull(receiver, target, download, received);
    assert.equal(await exists(residue), false);
    assert.equal(result.generation, upload);
    await verify(received, manifest);
    assert.equal(await fs.readFile(path.join(received, 'profile/worlds/to-file'), 'utf8'), '{"new":true}');
    assert.equal(await hashFile(path.join(received, 'profile/worlds/to-directory/large.bin')),
        await hashFile(path.join(profile, 'worlds/to-directory/large.bin')));
});

test('interrupted real rsync wire and lost commit acknowledgement recover the same frozen upload', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture();
    const job = randomUUID(), payload = path.join(device.root, job, 'payload');
    const { manifest } = await snapshot(device, payload), session = await remote.connect(device);
    const marker = path.join(device.root, 'cut-rsync-once');
    await fs.writeFile(marker, '');
    session.env.authEnv.TAVERNSYN_FIXTURE_CUT = marker;
    const plans = [], resumes = [];
    const unauthorized = path.join(device.root, 'unauthorized-wire');
    await fs.mkdir(unauthorized); await fs.writeFile(path.join(unauthorized, '99.bundle'), 'outside the frozen descriptors');
    const wire = path.join(remote.root, 'private', 'hybrid', job, 'wire');
    const attach = () => {
        const control = session.control, request = control.request.bind(control);
        control.request = async (op, fields, ...rest) => {
            if (op === 'begin' && fields.resumeOnly) resumes.push(fields.job);
            const response = await request(op, fields, ...rest);
            if (op === 'hybrid-plan') plans.push(response.plan);
            if (op === 'hybrid-descriptors') {
                const env = session.env, { TAVERNSYN_FIXTURE_CUT: _cut, ...authEnv } = env.authEnv;
                const args = ['-r', `--rsync-path=tavernsyn-rsync-v3 ${device.deviceId} ${job} wire`, `--rsh=${env.rsh}`,
                    `${await env.posix(unauthorized)}/`, 'tavernsyn-vps::wire/'];
                await assert.rejects(run(env.rsync, args, { env: authEnv }), error => [23, 24].includes(error.exitCode));
                assert.equal(await exists(path.join(wire, '99.bundle')), false);
            }
            if (op === 'commit' && !lost) {
                lost = true;
                const stopped = once(control.child, 'close');
                control.child.stdin.end();
                await stopped;
                throw Object.assign(Error('fixture lost publication ACK'), { code: 'SSH' });
            }
            return response;
        };
    };
    let lost = false;
    attach();
    const reconnect = session.reconnect;
    session.reconnect = async () => { await reconnect(); attach(); };
    const result = await remote.push(session, device, job, payload, manifest);
    assert.equal(lost, true); assert.equal(result.generation, job);
    assert.deepEqual(resumes, [job, job]);
    assert.equal(plans.length, 1);
    assert.equal(result.stats.reconnects, 2);
    assert.equal(result.stats.interruptedTransfers, 1);
    await verify(path.join(remote.root, 'generations', job, 'payload'), manifest);
});

test('real hybrid downloads distinguish a refused finish from a lost finish acknowledgement', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture();
    await publish(device, remote);
    for (const mode of ['refused', 'lost']) {
        const job = randomUUID(), payload = path.join(device.state, 'jobs', job, 'payload');
        const session = await remote.connect(device);
        const request = session.control.request.bind(session.control);
        let finishes = 0;
        session.control.request = async (op, ...args) => {
            if (op !== 'finish') return request(op, ...args);
            finishes++;
            if (mode === 'refused') throw Object.assign(Error('fixture refusal'), { code: 'PERMISSION' });
            await request(op, ...args);
            throw Object.assign(Error('fixture lost finish ACK'), { code: 'SSH' });
        };
        if (mode === 'refused') {
            await assert.rejects(remote.pull(session, device, job, payload), { code: 'PERMISSION' });
            if (!session.control.closed) {
                const stopped = once(session.control.child, 'close');
                session.control.child.stdin.end();
                await stopped;
            }
        } else {
            const result = await remote.pull(session, device, job, payload);
            await verify(payload, result.manifest);
            assert.equal((await readJson(path.join(path.dirname(payload), 'download-resume.json'))).state, 'verified');
        }
        assert.equal(finishes, 1);
    }
});

test('unmanaged classification pull resumes once without another confirmation', { timeout: 60000 }, async context => {
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
    await runHandoff(manager);
    assert.equal(remote.pulls, pulls);
});

test('a lost scoped publication acknowledgement reconciles the exact merged generation without reuploading', { timeout: 60000 }, async context => {
    const remote = await storeTransport(context); if (!remote) return;
    const device = await fixture(); await publish(device, remote);
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { changed: true });
    const original = remote.push;
    remote.push = async (...args) => { await original.apply(remote, args); throw Object.assign(Error('synthetic lost ACK'), { code: 'SSH' }); };
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', scope: ['worlds'], tab: randomUUID() });
    await handoff(manager); await manager.done;
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
