import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, temporary, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { atomicJson, readJson, run } from '../lib/io.mjs';
import { scan, verify, difference, portablePath, copyTree } from '../lib/manifest.mjs';
import { sharedSettings, preserveSettings } from '../lib/settings.mjs';
import { snapshot, portableState } from '../lib/snapshot.mjs';
import { prepare, buildPlan, applyPlan, rollback } from '../helper/apply.mjs';
import { Manager } from '../helper/manager.mjs';
import { parseStats, RSYNC_ARGS } from '../helper/transport.mjs';
import { savedReceipt } from '../server/index.mjs';
import { digest } from '../lib/io.mjs';
import { validatePayloadPaths } from '../lib/content.mjs';

test('device fields are preserved precisely; unknown shared settings survive', () => {
    const incoming = { power_user: { chat_width: 10, theme: 'new' }, extension_settings: { tavernsyn: { key: 'remote' }, plugin: { api: 'fake' } }, other: [1, 2] };
    const local = { power_user: { chat_width: 90 }, extension_settings: { tavernsyn: { key: 'local' } } };
    const result = preserveSettings(incoming, local);
    assert.equal(result.power_user.chat_width, 90); assert.equal(result.power_user.theme, 'new');
    assert.equal(result.extension_settings.tavernsyn.key, 'local'); assert.deepEqual(result.other, [1, 2]);
    assert.equal(sharedSettings(result).extension_settings.tavernsyn, undefined);
    assert.throws(() => sharedSettings({}, ['/__proto__/polluted']), { code: 'POINTER' });
    assert.equal({}.polluted, undefined);
});
test('unsafe cross-platform paths, collisions and junctions are refused', async () => {
    for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'CON.txt', 'a./b', '.tavernsyn-partial/a', '__proto__/x']) assert.throws(() => portablePath(name));
    const directory = await temporary('collision');
    // Canonically equivalent spellings are different names on Windows too.
    await fs.writeFile(path.join(directory, '\u00e9.txt'), 'one'); await fs.writeFile(path.join(directory, 'e\u0301.txt'), 'two');
    await assert.rejects(scan(directory), { code: 'FILENAME_COLLISION' });
    const linked = await temporary('links'), outside = await temporary('outside');
    await fs.symlink(outside, path.join(linked, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(scan(linked), { code: 'LINK' });
});
test('same-length same-mtime corruption fails content verification', async () => {
    const source = await temporary('hash'), target = await temporary('hash-copy');
    await fs.writeFile(path.join(source, 'file.txt'), 'AAAA');
    await copyTree(source, target); const expected = await scan(source);
    await fs.writeFile(path.join(target, 'file.txt'), 'BBBB');
    await fs.utimes(path.join(target, 'file.txt'), new Date(), new Date(expected.files[0].mtime * 1000));
    assert.deepEqual(difference(expected, await scan(target)).changed, ['file.txt']);
    await assert.rejects(verify(target, expected), { code: 'INTEGRITY' });
});
test('snapshot includes custom persisted data and keys, excludes accounts/caches/helper', async () => {
    const device = await fixture();
    await fs.mkdir(path.join(device.dataRoot, device.profile, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'node_modules/native.node'), 'wrong platform');
    const before = await portableState(device), payload = path.join(device.root, 'payload');
    const result = await snapshot(device, payload);
    assert.equal(result.metadata.sourceState.digest, before.digest);
    const names = result.manifest.files.map(f => f.path);
    assert.ok(names.includes('profile/secrets.json')); assert.ok(names.includes('profile/vertex-paygo/state.json'));
    assert.ok(!names.some(f => f.includes('_storage') || f.includes('node_modules') || f.includes('/tavernsyn/')));
    const settings = await readJson(path.join(payload, 'profile/settings.json'));
    assert.equal(settings.power_user.chat_width, undefined); assert.equal(settings.extension_settings.tavernsyn, undefined);
    await verify(payload, result.manifest);
});
test('plugin Git version/branch/dirty files are restored without full history or network', async () => {
    const device = await fixture(), plugin = path.join(device.install, 'plugins/demo'); await fs.mkdir(plugin);
    await run('git', ['init', '--initial-branch=release', plugin]);
    await fs.writeFile(path.join(plugin, 'index.mjs'), 'export const version=1;\n');
    await run('git', ['-C', plugin, 'add', '.']);
    await run('git', ['-C', plugin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    await run('git', ['-C', plugin, 'remote', 'add', 'origin', 'https://example.invalid/fixture/plugin.git']);
    await fs.writeFile(path.join(plugin, 'index.mjs'), 'export const version=2; // local modification\n');
    await fs.writeFile(path.join(plugin, 'extra.txt'), 'untracked resource');
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const result = await snapshot(device, payload);
    assert.equal(result.metadata.plugins.length, 1);
    const prepared = await prepare(device, payload, result.manifest, job), restored = path.join(prepared.candidate, 'server-plugins/demo');
    assert.equal((await run('git', ['-C', restored, 'rev-parse', 'HEAD'])).stdout.trim(), result.metadata.plugins[0].commit);
    assert.equal((await run('git', ['-C', restored, 'branch', '--show-current'])).stdout.trim(), 'release');
    assert.match((await run('git', ['-C', restored, 'status', '--porcelain'])).stdout, / M index.mjs/);
    assert.equal(await fs.readFile(path.join(restored, 'extra.txt'), 'utf8'), 'untracked resource');
});
test('journal rollback recovers every root when interrupted between rename and journal update', async () => {
    const device = await fixture(), original = await portableState(device);
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const snapshotResult = await snapshot(device, payload);
    const prepared = await prepare(device, payload, snapshotResult.manifest, job);
    await fs.writeFile(path.join(prepared.candidate, 'profile/worlds/book.json'), '{"new":true}');
    const plan = await buildPlan(device, prepared, job); let count = 0;
    await assert.rejects(applyPlan(device, plan, { afterRename() { if (++count === 3) throw Error('simulated power loss'); } }));
    await rollback(device, plan);
    assert.equal((await portableState(device)).digest, original.digest);
    assert.equal(await fs.readFile(path.join(device.install, 'plugins/tavernsyn/index.mjs'), 'utf8'), '// local helper wrapper');
    assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'rolled-back');
});
test('rsync statistics distinguish actual protocol bytes and logical/literal bytes', () => {
    const stats = parseStats('Total bytes sent: 1,234\nTotal bytes received: 56\nLiteral data: 7,890 bytes\nMatched data: 10,000 bytes\nNumber of regular files transferred: 2\n');
    assert.equal(stats.sentBytes, 1234); assert.equal(stats.receivedBytes, 56); assert.equal(stats.literalBytes, 7890);
    assert.ok(RSYNC_ARGS.includes('--no-whole-file')); assert.ok(!RSYNC_ARGS.some(x => ['--inplace', '--append', '-a'].includes(x)));
});
test('two-button flow publishes a frozen snapshot; unpushed changes require manifest-bound confirmation', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')), lifecycle = new FakeLifecycle(); await fs.mkdir(remote.root);
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.equal(lifecycle.starts, 1);
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { local: 'unpublished' });
    await manager.start({ direction: 'pull', tab: randomUUID() }); const confirmation = await phase(manager, 'AWAITING_CONFIRMATION');
    await assert.rejects(manager.action('confirm', { id: confirmation.id, token: 'wrong' }), { code: 'CONFIRMATION' });
    await manager.action('confirm', { id: confirmation.id, token: confirmation.confirmationToken });
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal((await readJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'))).entries.one.content, 'synthetic world');
    assert.equal((await readJson(path.join(device.dataRoot, device.profile, 'settings.json'))).power_user.chat_width, 90);
    assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'committed');
});
test('failed startup rolls back only after confirmed exit, then starts the restored data', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')), lifecycle = new FakeLifecycle(); await fs.mkdir(remote.root);
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/local.json'), '{"keep":true}');
    const original = (await portableState(device)).digest;
    await manager.start({ direction: 'pull', tab: randomUUID() }); const confirmation = await phase(manager, 'AWAITING_CONFIRMATION');
    await manager.action('confirm', { id: confirmation.id, token: confirmation.confirmationToken });
    lifecycle.failNext = true; await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED'); assert.equal(lifecycle.stopped, false);
    assert.equal((await portableState(device)).digest, original);
    assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'rolled-back');
});
test('unmanaged pull stages only; controlled continuation uses the verified download', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const initial = new Manager(device, new FakeLifecycle(), remote);
    await initial.start({ direction: 'push', tab: randomUUID() }); await handoff(initial); await initial.done;
    const worker = new Manager(device, null, remote);
    await worker.start({ direction: 'pull', tab: randomUUID() }); await worker.done;
    assert.equal((await worker.status()).phase, 'PENDING_APPLY');
    const controlled = new Manager(device, new FakeLifecycle(), { connect() { throw Error('must not download again'); } });
    await controlled.action('resume-pending', { tab: randomUUID() }); await handoff(controlled); await controlled.done;
    assert.equal((await controlled.status()).phase, 'SUCCEEDED');
});
test('settings/chat receipts match parsed metadata and message content, not counts', async () => {
    const device = await fixture(), nonce = randomUUID(), file = path.join(device.dataRoot, device.profile, 'settings.json');
    const settings = await readJson(file); settings.extension_settings.tavernsyn.flushReceipt = nonce; await atomicJson(file, settings);
    const projection = { extension_settings: settings.extension_settings, power_user: settings.power_user, oai_settings: settings.oai_settings, textgenerationwebui_settings: settings.textgenerationwebui_settings };
    const folder = path.join(device.dataRoot, device.profile, 'chats/Card'); await fs.mkdir(folder);
    const messages = [{ name: 'fixture', mes: 'saved', is_user: true }], metadata = { integrity: 'fixture', note: 'saved' };
    const chatFile = path.join(folder, 'session.jsonl');
    await fs.writeFile(chatFile, [{ chat_metadata: metadata }, ...messages].map(JSON.stringify).join('\n'));
    const body = { nonce, settingsDigest: digest(projection), chat: { type: 'single', avatar: 'Card.png', id: 'session', digest: digest({ messages, metadata }) } };
    assert.equal((await savedReceipt(device, body)).files.length, 2);
    await fs.writeFile(chatFile, [{ chat_metadata: { ...metadata, note: 'not the acknowledged metadata' } }, ...messages].map(JSON.stringify).join('\n'));
    await assert.rejects(savedReceipt(device, body), { code: 'SAVE_PENDING' });
});
test('core JSON validation refuses a self-consistent but broken source payload', async () => {
    const device = await fixture();
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/book.json'), '{broken');
    await assert.rejects(snapshot(device, path.join(device.root, 'payload')), { code: 'INVALID_JSON' });
});
test('post-confirm local changes cancel application and restart the original instance', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')), lifecycle = new FakeLifecycle(); await fs.mkdir(remote.root);
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    const file = path.join(device.dataRoot, device.profile, 'worlds/local.json'); await fs.writeFile(file, '{"one":1}');
    await manager.start({ direction: 'pull', tab: randomUUID() }); const confirmation = await phase(manager, 'AWAITING_CONFIRMATION');
    await manager.action('confirm', { id: confirmation.id, token: confirmation.confirmationToken });
    await phase(manager, 'AWAITING_SAVE'); await fs.writeFile(file, '{"two":2}');
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED'); assert.equal((await manager.status()).error.code, 'LOCAL_CHANGED');
    assert.equal(await fs.readFile(file, 'utf8'), '{"two":2}'); assert.equal(lifecycle.stopped, false);
});
test('a remote mirror cannot replace the executing sync plugin or inject dependency directories', () => {
    for (const file of ['server-plugins/tavernsyn/package.json', 'extensions/tavernsyn/ui/extra.js', 'profile/extensions/tavernsyn/manifest.json', 'server-plugins/package.json']) assert.throws(() => validatePayloadPaths({ files: [{ path: file }] }), { code: 'SELF_PROTECTION' });
    for (const file of ['profile/node_modules/x.js', 'profile/.ssh/key', 'somewhere/file']) assert.throws(() => validatePayloadPaths({ files: [{ path: file }] }), { code: 'PAYLOAD_SCOPE' });
});
