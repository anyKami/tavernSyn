import assert from 'node:assert/strict';
import fsNative from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { exists, readJson, run } from '../lib/io.mjs';
import { verify } from '../lib/manifest.mjs';
import { portableState, restoreRepositories, snapshot } from '../lib/snapshot.mjs';

async function fixture(t) {
    await fs.mkdir('.tmp', { recursive: true });
    const root = path.resolve(await fs.mkdtemp('.tmp/usb-snapshot-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const install = path.join(root, 'st'), dataRoot = path.join(install, 'data');
    const profile = 'default-user', profileRoot = path.join(dataRoot, profile);
    const state = path.join(root, 'state'), yamlPath = path.join(install, 'config.yaml');
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.mkdir(state);
    await fs.writeFile(yamlPath, '{"dataRoot":"./data","port":8000}');
    await fs.writeFile(path.join(profileRoot, 'settings.json'), '{"username":"fixture","local":"device-specific"}');
    const device = { install, dataRoot, state, profile, yamlPath, origin: 'http://127.0.0.1:8000',
        YAML: { parse: JSON.parse }, pointers: ['/local'], extraRoots: [], preserveJson: [] };
    return { root, profileRoot, device };
}

const withoutTimes = files => files.map(({ mtime, ...file }) => file);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('USB snapshot hashes assets while copying and emits the same portable snapshot', async t => {
    const { root, profileRoot, device } = await fixture(t);
    device.preserveJson = [{ path: 'profile/policy.json', pointers: ['/local'] }];
    await fs.writeFile(path.join(profileRoot, 'policy.json'), '{"shared":1,"local":2}');
    await fs.mkdir(path.join(profileRoot, '.cache'));
    await fs.writeFile(path.join(profileRoot, '.cache/excluded.txt'), 'local cache');
    const asset = Buffer.alloc(128 * 1024 + 3, 0x61);
    const live = path.join(profileRoot, 'portable.bin');
    await fs.writeFile(live, asset, { mode: 0o700 });
    await fs.utimes(live, 1_700_000_000, 1_700_000_001);
    const regular = await snapshot(device, path.join(root, 'regular'));
    const payload = path.join(root, 'fast'), staged = path.join(payload, 'profile/portable.bin');
    const stageReads = [], openStream = fsNative.createReadStream;
    const spy = t.mock.method(fsNative, 'createReadStream', (file, ...args) => {
        if (file === staged) stageReads.push(file);
        return openStream(file, ...args);
    });
    syncBuiltinESMExports();
    let fast;
    try { fast = await snapshot(device, payload, { hashOnCopy: true }); }
    finally { spy.mock.restore(); syncBuiltinESMExports(); }

    assert.deepEqual(stageReads, [], 'the fast snapshot must skip rereading copied assets');
    assert.deepEqual(fast.metadata, regular.metadata);
    assert.equal(fast.manifest.digest, regular.manifest.digest);
    assert.deepEqual(withoutTimes(fast.manifest.files), withoutTimes(regular.manifest.files));
    assert.deepEqual(fast.metadata.sourceState, await portableState(device));
    assert.deepEqual(await readJson(path.join(payload, 'profile/settings.json')), { username: 'fixture' });
    assert.deepEqual(await readJson(path.join(payload, 'profile/policy.json')), { shared: 1 });
    assert.equal((await fs.stat(staged)).mtimeMs, 1_700_000_001_000);
    if (process.platform !== 'win32') assert.deepEqual(fast.metadata.executables, ['profile/portable.bin']);
    assert.deepEqual(fast.manifest.files.find(f => f.path === 'profile/portable.bin'),
        { path: 'profile/portable.bin', size: asset.length, sha256: sha256(asset), mtime: 1_700_000_001 });
    assert.deepEqual(fast.manifest.files.map(f => f.path), [
        'environment.json', 'profile/policy.json', 'profile/portable.bin', 'profile/settings.json',
    ]);
    await verify(payload, fast.manifest);
    await fs.writeFile(staged, 'independent copy');
    assert.deepEqual(await fs.readFile(live), asset);
    assert.deepEqual(await readJson(path.join(profileRoot, 'settings.json')), { username: 'fixture', local: 'device-specific' });
});

test('USB snapshot rejects an in-place source edit during copying even with a restored mtime', async t => {
    const { root, profileRoot, device } = await fixture(t);
    const live = path.join(profileRoot, 'portable.bin');
    await fs.writeFile(live, Buffer.alloc(256 * 1024, 0x61));
    await fs.utimes(live, 1_700_000_000, 1_700_000_001);
    const originalOpen = fs.open;
    const spy = t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === live) {
            const read = handle.read.bind(handle);
            handle.read = async (...options) => {
                const result = await read(...options);
                if (handle.read !== read) {
                    handle.read = read;
                    await fs.writeFile(live, Buffer.alloc(256 * 1024, 0x62));
                    await fs.utimes(live, 1_700_000_000, 1_700_000_001);
                }
                return result;
            };
        }
        return handle;
    });
    try {
        await assert.rejects(snapshot(device, path.join(root, 'fast'), { hashOnCopy: true }), { code: 'SOURCE_CHANGED' });
    } finally { spy.mock.restore(); }
});

test('USB fast snapshot preserves a pinned Git commit and can move it into the adopted candidate', async t => {
    const { root, device } = await fixture(t);
    const plugin = path.join(device.install, 'plugins/example');
    await fs.mkdir(plugin, { recursive: true });
    await run('git', ['-C', plugin, 'init', '--quiet', '--initial-branch=main']);
    await fs.writeFile(path.join(plugin, 'index.js'), 'export const committed = true;\n');
    await run('git', ['-C', plugin, 'add', 'index.js']);
    await run('git', ['-C', plugin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Fixture']);
    await run('git', ['-C', plugin, 'remote', 'add', 'origin', 'https://example.test/fixture.git']);
    const commit = (await run('git', ['-C', plugin, 'rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(plugin, 'index.js'), 'export const localEdit = true;\n');

    const payload = path.join(root, 'candidate');
    const fast = await snapshot(device, payload, { hashOnCopy: true });
    const [metadata] = fast.metadata.plugins;
    assert.equal(metadata.commit, commit);
    assert.equal(metadata.origin, 'https://example.test/fixture.git');
    const repository = path.join(payload, ...metadata.gitData.split('/'));
    assert.equal((await run('git', ['--git-dir', repository, 'show', 'HEAD:index.js'])).stdout, 'export const committed = true;\n');
    assert.equal(await fs.readFile(path.join(payload, 'server-plugins/example/index.js'), 'utf8'), 'export const localEdit = true;\n');
    await verify(payload, fast.manifest);
    const workingTree = path.join(payload, 'server-plugins/example');
    await restoreRepositories(device, payload, payload, { moveGit: true });
    assert.equal(await exists(repository), false);
    assert.equal((await run('git', ['-C', workingTree, 'rev-parse', 'HEAD'])).stdout.trim(), commit);
    assert.equal(await fs.readFile(path.join(workingTree, 'index.js'), 'utf8'), 'export const localEdit = true;\n');
});

test('USB fast snapshot rejects source link and case-collision paths', { skip: process.platform === 'win32' }, async t => {
    const { root, profileRoot, device } = await fixture(t);
    const linked = path.join(profileRoot, 'linked');
    await fs.symlink(path.join(profileRoot, 'settings.json'), linked);
    await assert.rejects(snapshot(device, path.join(root, 'fast-link'), { hashOnCopy: true }), { code: 'LINK' });
    await fs.unlink(linked);
    await fs.mkdir(path.join(profileRoot, 'Asset'));
    await fs.mkdir(path.join(profileRoot, 'asset'));
    await assert.rejects(snapshot(device, path.join(root, 'fast-collision'), { hashOnCopy: true }), { code: 'FILENAME_COLLISION' });
});
