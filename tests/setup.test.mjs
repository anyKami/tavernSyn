import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PROJECT } from '../lib/device.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { setupDevice } from '../bin/setup-device.mjs';
import { prepareRepository, repositoryPath } from '../lib/repository.mjs';
import { ST, YAML } from './fixtures.mjs';

const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
async function fixture() {
    const parent = path.join(await fs.realpath(os.tmpdir()), 'tavernsyn-tests'); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'tavernsyn-setup-'));
    const st = path.join(root, 'Silly Tavern 测试'), state = path.join(root, 'device');
    await fs.mkdir(st); await fs.mkdir(path.join(st, 'data/default-user'), { recursive: true });
    await fs.symlink(path.join(ST, 'node_modules'), path.join(st, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of ['package.json', 'src/server-main.js', 'src/server-startup.js', 'src/plugin-loader.js', 'src/users.js',
        'src/middleware/userCss.js', 'src/middleware/webpack-serve.js', 'public/scripts/st-context.js']) {
        await fs.mkdir(path.dirname(path.join(st, file)), { recursive: true }); await fs.copyFile(path.join(ST, file), path.join(st, file));
    }
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    await fs.writeFile(path.join(st, 'config.yaml'), YAML.stringify({ port, listen: false, dataRoot: './data', enableServerPlugins: false, untouched: 'keep' }));
    await atomicJson(path.join(st, 'data/default-user/settings.json'), { extension_settings: {}, username: 'synthetic installer test' });
    return { st, state, port };
}

test('the installer refuses a running server before changing files or creating state', async () => {
    const options = await fixture(), file = path.join(options.st, 'config.yaml'), before = await fs.readFile(file, 'utf8');
    const server = net.createServer(); await new Promise(resolve => server.listen(options.port, '127.0.0.1', resolve));
    try { await assert.rejects(setupDevice(options), /端口被占用/); }
    finally { await new Promise(resolve => server.close(resolve)); }
    assert.equal(await fs.readFile(file, 'utf8'), before); assert.equal(await exists(options.state), false);
});

test('the installer never removes the lock of a living launcher', async () => {
    const options = await fixture(); await fs.mkdir(options.state);
    const lock = path.join(options.state, 'launcher.lock'); await atomicJson(lock, { pid: process.pid, nonce: randomUUID() });
    await assert.rejects(setupDevice(options), { code: 'LIVE_PROCESS' });
    assert.equal((await readJson(lock)).pid, process.pid); assert.equal(await exists(path.join(options.state, 'device.json')), false);
});

test('a custom external data root cannot be used as the control directory', async () => {
    const options = await fixture(), data = path.join(path.dirname(options.st), 'external-data');
    const file = path.join(options.st, 'config.yaml'), config = YAML.parse(await fs.readFile(file, 'utf8'));
    config.dataRoot = data; await fs.writeFile(file, YAML.stringify(config));
    await assert.rejects(setupDevice({ ...options, state: path.join(data, 'control') }), /不能与酒馆数据目录重叠/);
    assert.equal(await exists(data), false);
});

test('installation refuses an unusable private npm cache before replacing code or configuration', async () => {
    const options = await fixture();
    const config = path.join(options.st, 'config.yaml'), before = await fs.readFile(config, 'utf8');
    const blocked = path.join(options.state, 'npm-cache/_logs');
    await fs.mkdir(path.dirname(blocked), { recursive: true });
    await fs.writeFile(blocked, 'keep existing file');
    await assert.rejects(setupDevice(options), { code: 'DEPENDENCY_CACHE' });
    assert.equal(await fs.readFile(config, 'utf8'), before);
    assert.equal(await fs.readFile(blocked, 'utf8'), 'keep existing file');
    assert.equal(await exists(path.join(options.st, 'plugins/tavernsyn')), false);
    assert.equal(await exists(path.join(options.state, 'device.json')), false);
});

test('code migrates from the legacy wrapper into the standard plugin directory without overwriting other plugins', async () => {
    const options = await fixture(), repository = path.join(options.st, 'plugins/tavernsyn');
    await assert.rejects(repositoryPath(options.st, path.join(path.dirname(options.st), 'outside')), { code: 'INSTALL' });
    await fs.mkdir(repository, { recursive: true });
    await fs.writeFile(path.join(repository, 'index.mjs'), 'export const info = {id:"unrelated"};');
    await assert.rejects(prepareRepository(PROJECT, repository, options.st), { code: 'INSTALL' });
    const legacy = `process.env.TAVERNSYN_STATE = ${JSON.stringify(options.state)};\nconst plugin = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, 'server/index.mjs')).href)});\nexport const { info, init, exit } = plugin;\n`;
    await fs.writeFile(path.join(repository, 'index.mjs'), legacy);
    const result = await prepareRepository(PROJECT, repository, options.st);
    assert.equal(await fs.readFile(path.join(result.repositoryBackup, 'index.mjs'), 'utf8'), legacy);
    assert.equal(path.dirname(result.repositoryBackup), options.st);
    assert.equal((await readJson(path.join(repository, 'package.json'))).main, 'index.mjs');
    assert.ok(await exists(path.join(repository, 'helper/launcher.mjs')));
    assert.equal(await exists(path.join(repository, '.local')), false);
    assert.equal(await exists(path.join(repository, 'node_modules')), false);
    assert.deepEqual(await fs.readdir(path.join(options.st, 'plugins')), ['tavernsyn']);
});

test('fresh setup needs no device keys; reinstall preserves the saved password, identity and user data', async context => {
    if (process.platform === 'win32' && !await exists(path.join(runtime, 'usr/bin/rsync.exe'))) { context.skip('Portable runtime is not prepared; this test never downloads dependencies'); return; }
    const options = await fixture();
    if (process.platform === 'win32') {
        // Exercise Windows PowerShell 5.1, Unicode paths and the actual public entry script.
        let output = '';
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(PROJECT, 'install.ps1'),
            '-SillyTavernPath', options.st, '-StatePath', options.state, '-RuntimePath', runtime], { onOutput: text => { output += text; } })
            .catch(error => { context.diagnostic(output); throw error; });
    } else await setupDevice(options);
    assert.ok(await exists(path.join(options.state, 'npm-cache/_cacache/tmp')));
    assert.ok(await exists(path.join(options.state, 'npm-cache/_logs')));
    const cli = await run(process.execPath, [path.join(PROJECT, 'bin/configure.mjs'), '--state', options.state, '--host', '100.100.100.100'],
        { input: 'synthetic reinstall password\n' });
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes('synthetic reinstall password'));
    const file = path.join(options.state, 'device.json'), saved = await readJson(file);
    const privateFile = path.join(options.state, 'credentials/device_ed25519');
    assert.equal(await exists(privateFile), false); assert.equal(await exists(`${privateFile}.pub`), false);
    await fs.mkdir(path.join(options.state, 'credentials'), { recursive: true });
    const passwordFile = path.join(options.state, 'credentials/ssh-password.json');
    await atomicJson(passwordFile, { password: 'synthetic reinstall password' });
    const knownHosts = path.join(options.state, 'credentials/known_hosts');
    saved.remote = { host: '100.100.100.100', user: 'tavernsyn', dataset: randomUUID(), passwordFile, knownHostsFile: knownHosts };
    saved.customField = 'keep'; await atomicJson(file, saved);
    const settingsFile = path.join(options.st, 'data/default-user/settings.json'), settingsBefore = await fs.readFile(settingsFile, 'utf8');
    const result = await setupDevice({ ...options, ...(process.platform === 'win32' ? { runtime } : {}) }), after = await readJson(file);
    assert.equal(result.deviceId, saved.deviceId); assert.equal(result.configured, true); assert.equal(after.customField, 'keep');
    assert.deepEqual(after.remote, saved.remote); assert.equal((await readJson(passwordFile)).password, 'synthetic reinstall password');
    assert.ok(await exists(path.join(options.state, 'npm-cache/_cacache/tmp')));
    assert.equal(await exists(privateFile), false); assert.equal(await fs.readFile(settingsFile, 'utf8'), settingsBefore);
    assert.ok(await exists(result.launcher)); assert.ok(await exists(path.join(options.st, 'plugins/tavernsyn/index.mjs')));
    const repository = path.join(options.st, 'plugins/tavernsyn');
    assert.equal(result.repository, repository);
    const installedDependencies = await import(pathToFileURL(path.join(repository, 'lib/dependencies.mjs')));
    assert.equal(await installedDependencies.prepareDependencyCache({ state: options.state }), path.join(options.state, 'npm-cache'));
    assert.equal((await readJson(path.join(repository, '.tavernsyn-install.json'))).state, options.state);
    assert.ok((await fs.readFile(result.launcher, 'utf8')).includes('TavernSyn-Startup.mjs'));
    assert.ok(await exists(path.join(options.st, 'TavernSyn-Startup.mjs')));
    if (process.platform === 'win32') {
        const batch = await fs.readFile(result.launcher, 'utf8');
        assert.ok(batch.includes('--state')); assert.ok(batch.includes('--desktop-shortcut'));
        assert.match((await readJson(path.join(repository, '.tavernsyn-install.json'))).codeFingerprint, /^[a-f0-9]{64}$/);
        assert.ok(await exists(path.join(repository, 'bin/create-desktop-shortcut.ps1')));
    }
    assert.ok(await exists(path.join(options.st, 'public/scripts/extensions/third-party/tavernsyn/ui/index.js')));
    assert.equal(YAML.parse(await fs.readFile(path.join(options.st, 'config.yaml'), 'utf8')).untouched, 'keep');
    assert.equal(YAML.parse(await fs.readFile(path.join(options.state, 'config.before-install.yaml'), 'utf8')).enableServerPlugins, false);
    if (process.platform === 'win32') {
        const downloadedOptions = await fixture();
        const mirror = path.join(path.dirname(options.st), 'published'), clone = path.join(downloadedOptions.st, 'plugins/tavernsyn');
        await fs.mkdir(mirror);
        for (const entry of ['adapters', 'bin', 'helper', 'lib', 'server', 'ui', 'index.mjs', 'manifest.json', 'package.json', 'install.ps1', 'install.sh']) {
            await fs.cp(path.join(PROJECT, entry), path.join(mirror, entry), { recursive: true });
        }
        await run('git', ['init', '-b', 'main', mirror]); await run('git', ['-C', mirror, 'add', '.']);
        await run('git', ['-C', mirror, '-c', 'user.name=TavernSyn Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic installer repository']);
        const downloaded = path.join(options.st, 'public/scripts/extensions/third-party/tavernsyn/install.ps1'); await fs.copyFile(path.join(PROJECT, 'install.ps1'), downloaded);
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', downloaded,
            '-SillyTavernPath', downloadedOptions.st, '-StatePath', downloadedOptions.state, '-RuntimePath', runtime], { env: {
                GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${pathToFileURL(mirror).href}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/anyKami/tavernSyn.git',
                GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always',
            } });
        assert.ok(await exists(path.join(clone, '.git')));
        assert.ok((await fs.readFile(path.join(downloadedOptions.st, 'Start-TavernSyn.cmd'), 'utf8')).includes('TavernSyn-Startup.mjs'));
        // Reuse an installed clone when the entry script is downloaded separately.
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', downloaded,
            '-SillyTavernPath', options.st, '-StatePath', options.state]);
        assert.equal(await exists(privateFile), false);
        assert.equal((await readJson(passwordFile)).password, 'synthetic reinstall password');
    }
    const secretBefore = await fs.readFile(passwordFile, 'utf8');
    await atomicJson(path.join(options.state, 'status.json'), { phase: 'PENDING_APPLY' });
    await assert.rejects(setupDevice(options), { code: 'BUSY' });
    assert.equal(await fs.readFile(passwordFile, 'utf8'), secretBefore);
});
