import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { prepare } from '../helper/apply.mjs';
import { copyTree } from '../lib/manifest.mjs';
import { run } from '../lib/io.mjs';

test('version files survive a pull and another push with disabled hooks and local edits', async () => {
    const device = await fixture(), name = 'demo 空格', directory = path.join(device.install, 'plugins', name);
    await fs.mkdir(directory); await run('git', ['init', '-b', 'release', directory]);
    const invoke = args => run('git', ['-C', directory, ...args]);
    await invoke(['remote', 'add', 'origin', 'https://example.invalid/fixture/plugin.git']);
    await invoke(['config', 'core.hooksPath', path.join(device.state, 'disabled-hooks')]);
    const commit = async () => { await invoke(['add', '.']); await invoke(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'version fixture']); };
    await fs.writeFile(path.join(directory, 'removed.txt'), 'old history is not needed'); await commit();
    const old = (await invoke(['rev-parse', 'HEAD'])).stdout.trim();
    await fs.unlink(path.join(directory, 'removed.txt'));
    await fs.writeFile(path.join(directory, 'index.mjs'), 'export const version=1;\n'); await commit();
    await invoke(['gc', '--quiet']); // Source objects may be packed.
    const head = (await invoke(['rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(directory, 'index.mjs'), 'export const version=2; // local edit\n');
    await fs.writeFile(path.join(directory, 'extra.txt'), 'untracked resource');
    const config = await fs.readFile(path.join(directory, '.git/config'), 'utf8');
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const first = await snapshot(device, payload);
    assert.equal(first.metadata.plugins[0].commit, head); assert.equal(first.metadata.plugins[0].branch, 'release');
    const gitData = path.join(payload, first.metadata.plugins[0].gitData);
    assert.doesNotMatch(await fs.readFile(path.join(gitData, 'config'), 'utf8'), /hooksPath|disabled-hooks/);
    assert.equal(await fs.readFile(path.join(directory, '.git/config'), 'utf8'), config);
    assert.equal(await fs.readFile(path.join(directory, 'index.mjs'), 'utf8'), 'export const version=2; // local edit\n');
    const prepared = await prepare(device, payload, first.manifest, job);
    const restored = path.join(prepared.candidate, 'server-plugins', name);
    const restoredGit = args => run('git', ['-C', restored, ...args]);
    assert.equal((await restoredGit(['rev-parse', 'HEAD'])).stdout.trim(), head);
    assert.equal((await restoredGit(['branch', '--show-current'])).stdout.trim(), 'release');
    assert.equal((await restoredGit(['remote', 'get-url', 'origin'])).stdout.trim(), 'https://example.invalid/fixture/plugin.git');
    assert.match((await restoredGit(['status', '--porcelain'])).stdout, / M index.mjs/);
    await assert.rejects(restoredGit(['cat-file', '-e', old]), { code: 'PROCESS_FAILED' });
    const other = await fixture(); await copyTree(restored, path.join(other.install, 'plugins', name));
    const second = await snapshot(other, path.join(other.root, 'second-push'));
    assert.equal(second.metadata.plugins[0].commit, head);
    assert.equal(await fs.readFile(path.join(other.root, 'second-push/server-plugins', name, 'extra.txt'), 'utf8'), 'untracked resource');
});

test('detached versions retain a detached HEAD without cloning or updating', async () => {
    const device = await fixture(), directory = path.join(device.install, 'plugins/demo'); await fs.mkdir(directory);
    await run('git', ['init', '-b', 'main', directory]);
    await fs.writeFile(path.join(directory, 'index.mjs'), '// fixture');
    const invoke = args => run('git', ['-C', directory, ...args]);
    await invoke(['add', '.']); await invoke(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    await invoke(['remote', 'add', 'origin', 'https://example.invalid/detached.git']);
    await invoke(['checkout', '--detach']); await invoke(['config', 'core.hooksPath', path.join(device.state, 'disabled-hooks')]);
    const result = await snapshot(device, path.join(device.root, 'payload'));
    assert.equal(result.metadata.plugins[0].branch, null);
    assert.equal((await fs.readFile(path.join(device.root, 'payload', result.metadata.plugins[0].gitData, 'HEAD'), 'utf8')).trim(), result.metadata.plugins[0].commit);
});

test('a restored version can still be updated locally using its saved branch and origin', async () => {
    const device = await fixture(), directory = path.join(device.install, 'plugins/demo'); await fs.mkdir(directory);
    const remote = path.join(device.root, 'upstream.git'), origin = 'https://example.invalid/plugin.git';
    await run('git', ['init', '--bare', remote]);
    await run('git', ['-C', remote, 'config', 'core.longpaths', 'true']);
    await run('git', ['init', '-b', 'release', directory]);
    const invoke = args => run('git', ['-C', directory, ...args]);
    const commit = async () => { await invoke(['add', '.']); await invoke(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'local update fixture']); };
    await fs.writeFile(path.join(directory, 'README.md'), 'fixture'); await commit();
    await fs.writeFile(path.join(directory, 'index.mjs'), '// version 1'); await commit();
    await invoke(['remote', 'add', 'origin', origin]);
    await invoke(['config', 'core.hooksPath', path.join(device.state, 'disabled-hooks')]);
    const publish = () => invoke(['-c', 'protocol.file.allow=always', 'push', remote, 'HEAD:refs/heads/release']);
    await publish();
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const result = await snapshot(device, payload), prepared = await prepare(device, payload, result.manifest, job);
    const restored = path.join(prepared.candidate, 'server-plugins/demo');
    await fs.writeFile(path.join(directory, 'index.mjs'), '// version 2'); await commit(); await publish();
    assert.equal(await fs.readFile(path.join(restored, 'index.mjs'), 'utf8'), '// version 1');
    // Redirect only this explicit update to a local fixture; no internet or VPS update.
    await run('git', ['-C', restored, '-c', 'protocol.file.allow=always', '-c', `url.${pathToFileURL(remote).href}.insteadOf=${origin}`, 'pull', '--ff-only']);
    assert.equal(await fs.readFile(path.join(restored, 'index.mjs'), 'utf8'), '// version 2');
    assert.equal((await run('git', ['-C', restored, 'remote', 'get-url', 'origin'])).stdout.trim(), origin);
});
