import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, handoff, phase } from './fixtures.mjs';
import { snapshot, portableState } from '../lib/snapshot.mjs';
import { seedDownloadBasis } from '../lib/download-basis.mjs';
import { Manager } from '../helper/manager.mjs';
import { prepare } from '../helper/apply.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { verify, seal } from '../lib/manifest.mjs';
import { RSYNC_ARGS, parseStats } from '../helper/transport.mjs';

async function plugin(device, name = 'demo') {
    const directory = path.join(device.install, 'plugins', name); await fs.mkdir(directory);
    await run('git', ['init', '-b', 'main', directory]);
    await fs.writeFile(path.join(directory, 'index.js'), 'export const fixture = true;\n');
    await run('git', ['-C', directory, 'remote', 'add', 'origin', 'https://example.invalid/fixture/plugin.git']);
    return directory;
}
async function commit(directory, ...extra) {
    await run('git', ['-C', directory, 'add', '.']);
    await run('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', ...extra, '-qm', 'synthetic increment']);
}
async function tools(context) {
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.resolve('.local/msys64');
    const rsync = process.platform === 'win32' ? path.join(runtime, 'usr/bin/rsync.exe') : 'rsync';
    if (process.platform === 'win32' && !await exists(rsync)) { context.skip('Prepared rsync runtime is required'); return null; }
    const posix = async file => process.platform === 'win32' ? (await run(path.join(runtime, 'usr/bin/cygpath.exe'), ['-u', file])).stdout.trim() : file;
    // This raw rsync fixture has no production inspect/SHA-256 correction pass.
    // Compare contents so same-size Git refs created within one second on fast
    // Linux hosts cannot be skipped by the timestamp quick check. This does not
    // change block deltas or the production transfer arguments.
    return async (source, destination) => parseStats((await run(rsync, [...RSYNC_ARGS, '--checksum', '--', (await posix(source)) + '/', (await posix(destination)) + '/'])).stdout);
}

test('real rsync avoids resending a large plugin object after a tiny Git commit', { timeout: 90000 }, async context => {
    const sync = await tools(context); if (!sync) return;
    const device = await fixture(), directory = await plugin(device);
    await fs.writeFile(path.join(directory, 'asset.bin'), randomBytes(2 * 1024 * 1024)); await commit(directory);
    const template = path.join(device.root, 'empty-template'); await fs.mkdir(template);
    const legacy = async name => {
        const target = path.join(device.root, name);
        await run('git', ['-c', 'protocol.file.allow=always', 'clone', '--no-local', '--depth=1', '--single-branch', '--no-tags', '--no-checkout', `--template=${template}`, pathToFileURL(directory).href, target]);
        return path.join(target, '.git');
    };
    const legacyCache = path.join(device.root, 'legacy-cache'), cache = path.join(device.root, 'new-cache');
    await fs.mkdir(legacyCache); await fs.mkdir(cache);
    await sync(await legacy('legacy-first'), legacyCache);
    const firstJob = path.join(device.state, 'jobs', randomUUID()), first = path.join(firstJob, 'payload');
    await snapshot(device, first); await sync(first, cache);
    const delta = 'tiny change: 19 B!!'; assert.equal(Buffer.byteLength(delta), 19);
    await fs.writeFile(path.join(directory, 'tiny.txt'), delta); await commit(directory);
    const oldStats = await sync(await legacy('legacy-second'), legacyCache);
    const secondJob = path.join(device.state, 'jobs', randomUUID()), second = path.join(secondJob, 'payload');
    const frozen = await snapshot(device, second), newStats = await sync(second, cache);
    assert.ok(oldStats.sentBytes > 1.5 * 1024 * 1024, JSON.stringify(oldStats));
    assert.ok(newStats.sentBytes < 64 * 1024 && newStats.literalBytes < 64 * 1024, JSON.stringify(newStats));
    assert.ok(!frozen.manifest.files.some(f => /objects\/pack\/.*\.pack$/.test(f.path)));
    await verify(cache, frozen.manifest);
    const restored = await prepare(device, cache, frozen.manifest, path.join(device.state, 'jobs', randomUUID()));
    assert.equal((await run('git', ['-C', path.join(restored.candidate, 'server-plugins/demo'), 'rev-parse', 'HEAD'])).stdout.trim(), frozen.metadata.plugins[0].commit);
    context.diagnostic(JSON.stringify({ addedBytes: Buffer.byteLength(delta), legacy: oldStats, fixed: newStats }));
});

test('plugin object paths remain stable when a different plugin is inserted', async () => {
    const device = await fixture(), zeta = await plugin(device, 'zeta'); await commit(zeta);
    const first = await snapshot(device, path.join(device.root, 'first'));
    const alpha = await plugin(device, 'alpha'); await commit(alpha);
    const second = await snapshot(device, path.join(device.root, 'second'));
    assert.equal(second.metadata.plugins.find(p => p.code === 'server-plugins/zeta').gitData, first.metadata.plugins[0].gitData);
});

async function published(configure = async () => {}) {
    const device = await fixture(), lifecycle = new FakeLifecycle(), remote = new MemoryTransport(path.join(device.root, 'vps'));
    await configure(device);
    await fs.mkdir(remote.root);
    const manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    return { device, lifecycle, remote, manager };
}

test('unchanged push and pull skip transfer, preparation and restart while preserving save handoff', async () => {
    const { device, lifecycle, remote, manager } = await published();
    const original = { ...remote.current };
    remote.push = async () => assert.fail('unchanged push transferred');
    remote.pull = async () => assert.fail('unchanged pull downloaded or prepared');
    lifecycle.stop = async () => assert.fail('unchanged synchronization stopped ST');
    const marker = path.join(device.state, 'recovery-marker'); await fs.writeFile(marker, 'retain recovery');
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).noChanges, true);
    assert.equal(lifecycle.starts, 1); assert.deepEqual(remote.current, original);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).noChanges, true);
    assert.equal(await fs.readFile(marker, 'utf8'), 'retain recovery');
});

test('Git commit, branch, origin and shared config changes invalidate the no-change identity', async () => {
    const device = await fixture(), directory = await plugin(device); await commit(directory);
    let before = await portableState(device);
    await commit(directory, '--allow-empty'); let after = await portableState(device);
    assert.notEqual(after.digest, before.digest); assert.deepEqual(after.files, before.files); before = after;
    await run('git', ['-C', directory, 'checkout', '-b', 'other']); after = await portableState(device);
    assert.notEqual(after.digest, before.digest); before = after;
    await run('git', ['-C', directory, 'remote', 'set-url', 'origin', 'https://example.invalid/fixture/new-origin.git']); after = await portableState(device);
    assert.notEqual(after.digest, before.digest); before = after;
    const config = device.YAML.parse(await fs.readFile(device.yamlPath, 'utf8')); config.backups.common.numberOfBackups++;
    await fs.writeFile(device.yamlPath, device.YAML.stringify(config)); after = await portableState(device);
    assert.notEqual(after.digest, before.digest);
});

test('browser saves during handoff cannot be skipped as unchanged', async () => {
    const { device, manager, remote, lifecycle } = await published(), original = remote.current.generation;
    await manager.start({ direction: 'push', tab: randomUUID() }); await phase(manager, 'AWAITING_SAVE');
    await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { savedBeforeReceipt: true });
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).noChanges, false); assert.notEqual(remote.current.generation, original);
    assert.equal(lifecycle.starts, 2);
});

test('a changed remote publication and legacy incomplete inventory cannot take the fast path', async () => {
    const { device, manager, remote } = await published();
    const baseline = await readJson(path.join(device.state, 'baseline.json'));
    manager.job = { direction: 'pull', preview: false };
    const session = await remote.connect(device);
    session.control.request = async () => ({ dataset: device.remote.dataset, current: { generation: randomUUID(), digest: 'f'.repeat(64) } });
    assert.equal(await manager.skipUnchanged(session, baseline), false);
    assert.equal(await manager.skipUnchanged(session, { ...baseline, local: { ...baseline.local, format: 1 } }), false);
    session.hello.current = { generation: remote.current.generation };
    assert.equal(await manager.skipUnchanged(session, { ...baseline, remote: {} }), false);
});

test('autosaves during the remote version recheck cannot be reported as unchanged', async () => {
    const { device, manager, remote } = await published();
    const baseline = await readJson(path.join(device.state, 'baseline.json'));
    manager.job = { direction: 'pull', preview: false };
    const session = await remote.connect(device);
    session.control.request = async () => {
        await atomicJson(path.join(device.dataRoot, device.profile, 'worlds/book.json'), { savedDuringCheck: true });
        return { dataset: device.remote.dataset, current: remote.current };
    };
    assert.equal(await manager.skipUnchanged(session, baseline), false);
});

test('a missing previously empty extra root cannot be mistaken for no change', async () => {
    const { device, manager, remote } = await published(async device => {
        const directory = path.join(device.root, 'empty-extra'); await fs.mkdir(directory);
        device.extraRoots = [{ id: 'empty', path: directory }];
    });
    const baseline = await readJson(path.join(device.state, 'baseline.json'));
    await fs.rmdir(device.extraRoots[0].path);
    assert.equal((await portableState(device)).digest, baseline.local.digest);
    manager.job = { direction: 'pull', preview: false };
    assert.equal(await manager.skipUnchanged(await remote.connect(device), baseline), false);
});

test('real rsync reuses live local files as a verified download basis without a cache', { timeout: 60000 }, async context => {
    const sync = await tools(context); if (!sync) return;
    const device = await fixture(), asset = path.join(device.dataRoot, device.profile, 'asset.bin');
    await fs.writeFile(asset, randomBytes(2 * 1024 * 1024));
    const remote = path.join(device.root, 'remote'), frozen = await snapshot(device, remote);
    const changed = await fs.readFile(asset); changed.fill(0, 50000, 51000); await fs.writeFile(asset, changed);
    const target = path.join(device.root, 'download'); await fs.mkdir(target);
    const seeded = await seedDownloadBasis(device, target, frozen.manifest);
    assert.ok(seeded.files > 0);
    const stats = await sync(remote, target);
    assert.ok(stats.sentBytes < 64 * 1024 && stats.matchedBytes > 1.9 * 1024 * 1024, JSON.stringify(stats));
    await verify(target, frozen.manifest);
    context.diagnostic(JSON.stringify({ coldCacheDownload: stats }));
});

test('download seeding excludes runtime code, credentials and local dependencies', async () => {
    const device = await fixture(), payload = path.join(device.root, 'basis'); await fs.mkdir(payload);
    const manifest = seal(['server-plugins/tavernsyn/index.mjs', 'profile/.ssh/key', 'profile/node_modules/secret', 'profile/extensions/tavernSyn/config'].sort().map(path => ({ path, size: 1, mtime: 0, sha256: 'a'.repeat(64) })));
    assert.deepEqual(await seedDownloadBasis(device, payload, manifest), { files: 0 });
    assert.deepEqual(await fs.readdir(payload), []);
});
