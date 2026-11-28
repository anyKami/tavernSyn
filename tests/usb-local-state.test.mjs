import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTES } from '../lib/file-attributes.mjs';
import { run } from '../lib/io.mjs';
import { usbLocalState } from '../lib/usb-local-state.mjs';

async function fixture(t) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'usb-state-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const install = path.join(root, 'install'), state = path.join(root, 'state');
    const dataRoot = path.join(root, 'data'), profile = 'default-user';
    const yamlPath = path.join(install, 'config.yaml');
    const profileRoot = path.join(dataRoot, profile), plugins = path.join(install, 'plugins');
    await Promise.all([profileRoot, plugins, state].map(folder => fs.mkdir(folder, { recursive: true })));
    await fs.writeFile(yamlPath, '{"dataRoot":"../data","port":8000,"backups":{}}\n');
    return { root, install, state, dataRoot, profile, yamlPath, profileRoot, plugins,
        origin: 'http://127.0.0.1:8000', YAML: { parse: JSON.parse },
        extraRoots: [{ id: 'custom', path: path.join(root, 'custom') }] };
}

test('USB local state detects same-size rewrites when the original modification time is restored', async t => {
    const device = await fixture(t), document = path.join(device.profileRoot, 'character.png');
    const oldTime = 1700000000;
    await fs.writeFile(document, 'abcd');
    await fs.utimes(document, oldTime, oldTime);
    const original = await fs.stat(document, { bigint: true });
    const before = await usbLocalState(device);
    await fs.writeFile(document, 'wxyz');
    await fs.utimes(document, oldTime, oldTime);
    const edited = await fs.stat(document, { bigint: true });
    assert.equal(original.size, edited.size);
    assert.equal(original.mtimeNs, edited.mtimeNs);
    assert.notEqual((await usbLocalState(device)).digest, before.digest);
});

test('USB local state detects a newly created root and a renamed or removed file', async t => {
    const device = await fixture(t), [{ path: extra }] = device.extraRoots;
    const missing = await usbLocalState(device);
    await fs.mkdir(extra);
    const empty = await usbLocalState(device);
    assert.notEqual(empty.digest, missing.digest);
    const old = path.join(extra, 'old'), next = path.join(extra, 'new');
    await fs.writeFile(old, 'content');
    const withFile = await usbLocalState(device);
    await fs.rename(old, next);
    const renamed = await usbLocalState(device);
    assert.notEqual(renamed.digest, withFile.digest);
    await fs.unlink(next);
    assert.equal((await usbLocalState(device)).digest, empty.digest);
});

test('USB local state ignores cache, workspace and TavernSyn plugin churn outside the mirror', async t => {
    const device = await fixture(t), before = await usbLocalState(device);
    const ignored = [path.join(device.profileRoot, 'thumbnails'), path.join(device.profileRoot, 'node_modules'),
        path.join(device.plugins, 'TavernSyn'), path.join(device.state, 'jobs')];
    for (const folder of ignored) {
        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, 'file'), 'cache contents');
    }
    assert.equal((await usbLocalState(device)).digest, before.digest);
});

test('USB local state observes local config and the portable executable attribute record', async t => {
    const device = await fixture(t), before = await usbLocalState(device);
    await fs.writeFile(device.yamlPath, '{"dataRoot":"../data","port":8000,"backups":{"chat":{"enabled":false}}}\n');
    const configured = await usbLocalState(device);
    assert.notEqual(configured.digest, before.digest);
    await fs.writeFile(path.join(device.state, ATTRIBUTES), '{"format":1,"executables":[]}');
    assert.notEqual((await usbLocalState(device)).digest, configured.digest);
});

test('USB local state rejects a changed data root or port before capturing an overwrite guard', async t => {
    const device = await fixture(t);
    await fs.writeFile(device.yamlPath, '{"dataRoot":"../other-data","port":8000}');
    await assert.rejects(usbLocalState(device), { code: 'CONFIG_CHANGED' });
    await fs.writeFile(device.yamlPath, '{"dataRoot":"../data","port":8001}');
    await assert.rejects(usbLocalState(device), { code: 'CONFIG_CHANGED' });
});

test('USB local state notices plugin Git ref and config changes while ignoring its object store', async t => {
    const device = await fixture(t), plugin = path.join(device.plugins, 'plugin');
    const git = args => run('git', ['-C', plugin, ...args]);
    await fs.mkdir(plugin);
    await git(['init', '-q', '-b', 'main']);
    const before = await usbLocalState(device);
    await fs.writeFile(path.join(plugin, '.git/objects', 'ignored'), 'not a Git object');
    assert.equal((await usbLocalState(device)).digest, before.digest);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Initial']);
    const committed = await usbLocalState(device);
    assert.notEqual(committed.digest, before.digest);
    await git(['config', 'remote.origin.url', 'https://example.invalid/plugin.git']);
    assert.notEqual((await usbLocalState(device)).digest, committed.digest);
});

test('USB local state detects an effective Git origin change from an included config file', async t => {
    const device = await fixture(t), plugin = path.join(device.plugins, 'plugin');
    const config = path.join(device.root, 'external.gitconfig'), localConfig = path.join(plugin, '.git/config');
    const git = args => run('git', ['-C', plugin, ...args]);
    await fs.mkdir(plugin);
    await git(['init', '-q', '-b', 'main']);
    await fs.writeFile(config, '[remote "origin"]\n\turl = https://example.invalid/old.git\n');
    await git(['config', 'include.path', config]);
    const unchanged = await fs.readFile(localConfig, 'utf8'), before = await usbLocalState(device);
    await fs.writeFile(config, '[remote "origin"]\n\turl = https://example.invalid/new.git\n');
    assert.equal(await fs.readFile(localConfig, 'utf8'), unchanged);
    assert.notEqual((await usbLocalState(device)).digest, before.digest);
});

test('USB local state observes a plugin worktree HEAD and its common Git config', async t => {
    const device = await fixture(t), repo = path.join(device.root, 'repo'), plugin = path.join(device.plugins, 'worktree');
    await run('git', ['init', '-q', '-b', 'main', repo]);
    const git = args => run('git', ['-C', repo, ...args]);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Initial']);
    await git(['worktree', 'add', '-q', '-b', 'plugin-branch', plugin]);
    const before = await usbLocalState(device);
    await git(['config', 'remote.origin.url', 'https://example.invalid/worktree.git']);
    const configured = await usbLocalState(device);
    assert.notEqual(configured.digest, before.digest);
    await run('git', ['-C', plugin, 'checkout', '--quiet', '--detach']);
    assert.notEqual((await usbLocalState(device)).digest, configured.digest);
});

test('USB local state detects a branch becoming newer in a plugin using Git reftables', async t => {
    const device = await fixture(t), plugin = path.join(device.plugins, 'reftable');
    const git = args => run('git', ['-C', plugin, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', ...args]);
    await fs.mkdir(plugin);
    try { await git(['init', '-q', '-b', 'main', '--ref-format=reftable']); }
    catch (error) { if (error.code === 'PROCESS_FAILED') { t.skip('Git does not support reftables'); return; } throw error; }
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Initial']);
    const before = await usbLocalState(device);
    const next = (await git(['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Second'])).stdout.trim();
    assert.equal((await usbLocalState(device)).digest, before.digest);
    await git(['update-ref', 'HEAD', next]);
    assert.notEqual((await usbLocalState(device)).digest, before.digest);
});

test('USB local state rejects directory links inside the mirrored roots', async t => {
    const device = await fixture(t);
    await fs.symlink(device.state, path.join(device.profileRoot, 'link'), 'junction');
    await assert.rejects(usbLocalState(device), { code: 'LINK' });
});
