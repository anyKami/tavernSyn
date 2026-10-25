import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { autoUpdate, codeFingerprint, compareVersions, termuxLauncher, windowsLauncher } from '../bin/startup.mjs';
import { integrateTermuxManager } from '../bin/integrate-termux-manager.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { PROJECT } from '../lib/device.mjs';
import { ST, temporary, YAML } from './fixtures.mjs';

async function fixture() {
    const root = await temporary('startup'), install = path.join(root, 'Silly Tavern 测试'), state = path.join(root, 'state');
    const backend = path.join(install, 'plugins/tavernsyn'), source = path.join(root, 'source');
    await fs.mkdir(state); await fs.mkdir(backend, { recursive: true }); await fs.mkdir(source);
    await fs.symlink(path.join(ST, 'node_modules'), path.join(install, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    await fs.writeFile(path.join(install, 'package.json'), '{"name":"sillytavern","version":"1.19.0","type":"module"}');
    await fs.writeFile(path.join(install, 'config.yaml'), YAML.stringify({ port, listen: false, enableServerPlugins: true, dataRoot: './data' }));
    await atomicJson(path.join(state, 'device.json'), { install, profile: 'default-user', deviceId: randomUUID(), custom: 'preserve' });
    await atomicJson(path.join(state, 'status.json'), { phase: 'FAILED', error: { code: 'SYNTHETIC' } });
    await atomicJson(path.join(state, 'credentials/ssh-password.json'), { password: 'SYNTHETIC_UPDATE_PASSWORD' });
    await atomicJson(path.join(install, 'data/default-user/settings.json'), { username: 'synthetic user', extension_settings: { tavernsyn: { local: true } } });
    const files = {
        'package.json': JSON.stringify({ name: 'tavernsyn', version: '0.2.2', type: 'module', main: 'index.mjs' }),
        'manifest.json': '{"display_name":"TavernSyn","version":"0.2.2","js":"ui/index.js","css":"ui/style.css"}',
        'index.mjs': 'export const info={id:"tavernsyn"};',
        'helper/launcher.mjs': 'import fs from"node:fs";if(process.env.TAVERNSYN_FIXTURE_MARKER)fs.writeFileSync(process.env.TAVERNSYN_FIXTURE_MARKER,JSON.stringify({pid:process.pid,argv:process.argv}));',
        'helper/bootstrap.mjs': 'export const fixture=true;', 'server/index.mjs': 'export const fixture=true;',
        'ui/index.js': 'export const fixture=true;', 'ui/style.css': '/* fixture */',
        '.gitignore': '.tavernsyn-install.json\n',
    };
    for (const [name, data] of Object.entries(files)) for (const directory of [source, backend]) {
        await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true }); await fs.writeFile(path.join(directory, name), data);
    }
    for (const name of ['package.json', 'manifest.json']) {
        const value = await readJson(path.join(backend, name)); value.version = '0.1.3'; await atomicJson(path.join(backend, name), value);
    }
    await atomicJson(path.join(backend, '.tavernsyn-install.json'), { state, codeFingerprint: await codeFingerprint(backend) });
    const front = path.join(install, 'public/scripts/extensions/third-party/tavernSyn');
    await fs.mkdir(front, { recursive: true }); await fs.writeFile(path.join(front, 'manifest.json'), '{"version":"0.1.3"}');
    await run('git', ['init', '-b', 'main', source]); await run('git', ['-C', source, 'add', '.']);
    await run('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic release']);
    await run('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'tag', '-a', 'v0.2.2', '-m', 'Synthetic release']);
    return { root, install, state, backend, front, source, port, repositoryUrl: pathToFileURL(source).href, log() {} };
}

test('only newer stable versions update; generated launchers use the standalone entry', () => {
    assert.equal(compareVersions('0.2.10', '0.2.9'), 1); assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
    assert.equal(compareVersions('0.1.3', '0.2.1'), -1); assert.throws(() => compareVersions('0.3.0-beta', '0.2.1'));
    const batch = windowsLauncher({ node: 'C:/Node/node.exe', repository: 'C:/ST/plugins/tavernsyn', state: 'C:/state' });
    assert.ok(batch.includes('TavernSyn-Startup.mjs')); assert.ok(batch.includes('%*')); assert.ok(batch.includes('--desktop-shortcut'));
    assert.throws(() => windowsLauncher({ node: 'C:/bad%PATH%/node.exe', repository: 'C:/ST/plugins/tavernsyn', state: 'C:/state' }));
    assert.ok(termuxLauncher({ node: '/data/node', install: '/home/ST', state: '/home/state' }).includes('exec'));
});

test('an actual tagged Git release replaces both components, preserves local state and keeps one code backup', async () => {
    const f = await fixture(), files = [path.join(f.state, 'device.json'), path.join(f.state, 'credentials/ssh-password.json'), path.join(f.install, 'config.yaml'), path.join(f.install, 'data/default-user/settings.json')];
    const before = await Promise.all(files.map(file => fs.readFile(file, 'utf8')));
    const result = await autoUpdate(f); assert.deepEqual(result, { status: 'updated', version: '0.2.2' });
    assert.equal((await readJson(path.join(f.backend, 'package.json'))).version, '0.2.2');
    assert.equal((await readJson(path.join(f.front, 'manifest.json'))).version, '0.2.2');
    assert.equal((await readJson(path.join(f.backend, '.tavernsyn-install.json'))).state, f.state);
    assert.equal((await readJson(path.join(f.backend, '.tavernsyn-install.json'))).codeFingerprint, await codeFingerprint(f.backend));
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), before);
    assert.equal((await readJson(path.join(f.install, '.tavernsyn-previous-code/old-backend/package.json'))).version, '0.1.3');
    assert.equal(await exists(path.join(f.state, 'startup-update.json')), false);
    assert.equal(await exists(path.join(f.state, 'startup-update.lock')), false);
    assert.deepEqual(await autoUpdate(f), { status: 'current', version: '0.2.2' });
    await fs.appendFile(path.join(f.backend, 'helper/launcher.mjs'), '\n// local modification');
    assert.equal((await autoUpdate(f)).status, 'modified');
});

test('offline checks, active processes and pending synchronization never replace the installed code', async () => {
    const f = await fixture(), before = await codeFingerprint(f.backend);
    assert.equal((await autoUpdate({ ...f, repositoryUrl: pathToFileURL(path.join(f.root, 'missing')).href })).status, 'unavailable');
    await atomicJson(path.join(f.state, 'launcher.lock'), { pid: process.pid });
    await assert.rejects(autoUpdate(f), { code: 'BUSY' }); await fs.unlink(path.join(f.state, 'launcher.lock'));
    await atomicJson(path.join(f.state, 'status.json'), { phase: 'PENDING_APPLY' });
    assert.equal((await autoUpdate(f)).status, 'protected');
    assert.equal(await codeFingerprint(f.backend), before);
});

test('a tagged automatic update retains a working ff-only manual update path', async () => {
    const f = await fixture();
    assert.equal((await autoUpdate(f)).status, 'updated');
    const git = async (...args) => (await run('git', ['-C', f.backend, ...args])).stdout.trim();
    const tagged = (await run('git', ['-C', f.source, 'rev-parse', 'v0.2.2^{commit}'])).stdout.trim();
    assert.equal(await git('rev-parse', 'HEAD'), tagged);
    assert.equal(await git('branch', '--show-current'), 'main');
    assert.equal(await git('config', '--get', 'branch.main.remote'), 'origin');
    assert.equal(await git('config', '--get', 'branch.main.merge'), 'refs/heads/main');
    await fs.writeFile(path.join(f.source, 'README.md'), 'Synthetic later main commit\n');
    await run('git', ['-C', f.source, 'add', 'README.md']);
    await run('git', ['-C', f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Later manual update']);
    const later = (await run('git', ['-C', f.source, 'rev-parse', 'main'])).stdout.trim();
    await git('pull', '--ff-only');
    assert.equal(await git('rev-parse', 'HEAD'), later);
    assert.equal((await fs.readFile(path.join(f.backend, 'README.md'), 'utf8')).trim(), 'Synthetic later main commit');
});

test('failure after each rename restores the original backend and original frontend case', async () => {
    const f = await fixture(), before = await codeFingerprint(f.backend), originalFront = await fs.readFile(path.join(f.front, 'manifest.json'), 'utf8');
    for (const step of ['backend-backup', 'front-backup', 'backend-installed', 'front-installed']) {
        const result = await autoUpdate({ ...f, afterRename: actual => { if (actual === step) throw Error('Synthetic interrupted installation'); } });
        assert.equal(result.status, 'unavailable', step); assert.equal(await codeFingerprint(f.backend), before, step);
        assert.equal(await fs.readFile(path.join(f.front, 'manifest.json'), 'utf8'), originalFront, step);
        assert.equal(await exists(path.join(f.state, 'startup-update.json')), false, step);
    }
});

test('a later startup recovers an interrupted code swap before trying the network', async () => {
    const f = await fixture(), before = await codeFingerprint(f.backend), stage = path.join(f.install, `.tavernsyn-update-${randomUUID()}`);
    await fs.mkdir(stage); await fs.rename(f.backend, path.join(stage, 'old-backend'));
    await fs.mkdir(f.backend); await fs.writeFile(path.join(f.backend, 'package.json'), '{broken');
    await atomicJson(path.join(f.state, 'startup-update.json'), { format: 1, install: f.install, stage, frontName: 'tavernSyn', hadFront: true, phase: 'prepared' });
    const result = await autoUpdate({ ...f, skipCheck: true, repositoryUrl: pathToFileURL(path.join(f.root, 'missing')).href });
    assert.equal(result.status, 'skipped'); assert.equal(await codeFingerprint(f.backend), before);
});

test('standalone startup imports the launcher in its own process and keeps its state/browser arguments', async () => {
    const f = await fixture(), script = path.join(f.install, 'TavernSyn-Startup.mjs'), marker = path.join(f.root, 'launched.json');
    await fs.copyFile(path.join(PROJECT, 'bin/startup.mjs'), script);
    const child = spawn(process.execPath, [script, '--st', f.install, '--state', f.state, '--skip-update'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAVERNSYN_FIXTURE_MARKER: marker },
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, output);
    const started = await readJson(marker); assert.equal(started.pid, child.pid);
    assert.deepEqual(started.argv.slice(2), ['--state', f.state, '--open-browser', 'yes']);
});

test('the actual Windows batch forwards skip-update and launches the standalone entry', async context => {
    if (process.platform !== 'win32') { context.skip('Windows cmd entry'); return; }
    const f = await fixture(), script = path.join(f.install, 'TavernSyn-Startup.mjs'), marker = path.join(f.root, 'batch-launched.json');
    const batch = path.join(f.install, 'Start-TavernSyn.cmd');
    await fs.copyFile(path.join(PROJECT, 'bin/startup.mjs'), script);
    await fs.writeFile(batch, windowsLauncher({ node: process.execPath, repository: f.backend, state: f.state }));
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${batch}" --skip-update"`], {
        windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TAVERNSYN_FIXTURE_MARKER: marker },
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, output);
    assert.deepEqual((await readJson(marker)).argv.slice(2), ['--state', f.state, '--open-browser', 'yes']);
});

test('Termux menu option 4 performs a real tagged update before invoking the controlled launcher', async context => {
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
    const shell = process.platform === 'win32' ? path.join(runtime, 'usr/bin/bash.exe') : 'bash';
    if (process.platform === 'win32' && !await exists(shell)) { context.skip('Bash test runtime unavailable'); return; }
    const f = await fixture(), marker = path.join(f.root, 'menu-launched.json');
    await fs.copyFile(path.join(PROJECT, 'bin/startup.mjs'), path.join(f.install, 'TavernSyn-Startup.mjs'));
    await fs.writeFile(path.join(f.install, 'start-tavernsyn.sh'), termuxLauncher({ node: process.execPath, install: f.install, state: f.state }));
    await fs.writeFile(path.join(f.root, 'install.sh'), '#!/usr/bin/env bash\n# ClewdR & SillyTavern 管理工具\nshow_menu() {\n case "$1" in\n 4) start_service "SillyTavern" "$ST_DIR" "node server.js" ;;\n esac\n}\nmain() { show_menu "$@"; }\nmain "$@"\n');
    await integrateTermuxManager({ install: f.install, home: f.root, shell, log() {} });
    const output = await run(shell, [path.join(f.root, 'install.sh'), '4'], { env: {
        PATH: path.dirname(shell) + path.delimiter + process.env.PATH,
        TAVERNSYN_FIXTURE_MARKER: marker,
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${f.repositoryUrl}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/anyKami/tavernSyn.git',
        GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
    } });
    assert.ok(output.stdout.includes('0.1.3 → 0.2.2'), output.stdout);
    assert.equal((await readJson(path.join(f.backend, 'package.json'))).version, '0.2.2');
    assert.deepEqual((await readJson(marker)).argv.slice(2), ['--state', f.state, '--open-browser', 'yes']);
});

test('an existing service is reused only when its private epoch matches, without starting or updating another instance', async () => {
    const f = await fixture(), nonce = randomUUID(), browserMarker = path.join(f.root, 'browser.json');
    await fs.copyFile(path.join(PROJECT, 'bin/startup.mjs'), path.join(f.install, 'TavernSyn-Startup.mjs'));
    await fs.writeFile(path.join(f.backend, 'helper/browser.mjs'), `import fs from'node:fs';export async function openBrowser(origin){fs.writeFileSync(${JSON.stringify(browserMarker)},JSON.stringify({origin}));}`);
    await atomicJson(path.join(f.state, 'instance.lock'), { pid: process.pid, nonce, install: f.install });
    let epoch = nonce;
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ managed: true, epoch })); });
    await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
    try {
        const args = [path.join(f.install, 'TavernSyn-Startup.mjs'), '--st', f.install, '--state', f.state];
        await run(process.execPath, args);
        assert.equal((await readJson(browserMarker)).origin, `http://127.0.0.1:${f.port}`);
        assert.equal((await readJson(path.join(f.backend, 'package.json'))).version, '0.1.3');
        epoch = randomUUID(); await assert.rejects(run(process.execPath, args), { code: 'PROCESS_FAILED' });
        assert.equal((await readJson(path.join(f.state, 'instance.lock'))).nonce, nonce);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
