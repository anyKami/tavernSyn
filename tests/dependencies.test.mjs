import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installPluginDependencies } from '../lib/dependencies.mjs';
import { atomicJson, readJson, run, SyncError } from '../lib/io.mjs';
import { fixture } from './fixtures.mjs';

const mismatch = 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.\nnpm error Missing: fixture-dependency@1.0.0 from lock file\n';
async function dependencyFixture() {
    const device = await fixture(); device.restoreDependencies = true;
    device.npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    const job = path.join(device.state, 'jobs', randomUUID()), directory = path.join(job, 'candidate/extensions/demo');
    await fs.mkdir(directory, { recursive: true });
    await atomicJson(path.join(directory, 'package.json'), { name: 'fixture-root', version: '1.0.0', dependencies: { 'fixture-dependency': '1.0.0' } });
    await atomicJson(path.join(directory, 'package-lock.json'), { name: 'fixture-root', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture-root', version: '1.0.0' } } });
    return { device, job, directory };
}

test('only an npm ci lock mismatch retries install inside the candidate and keeps a useful log', async () => {
    const { device, directory } = await dependencyFixture(), calls = [];
    const result = await installPluginDependencies(device, directory, { log() {} }, async (_node, args, options) => {
        calls.push(args); assert.equal(options.cwd, directory);
        if (calls.length === 1) { options.onOutput(mismatch); throw new SyncError('PROCESS_FAILED', 'synthetic npm exit 1'); }
        if (args[1] === 'install') {
            await assert.rejects(fs.stat(path.join(directory, 'package-lock.json')), { code: 'ENOENT' });
            await atomicJson(path.join(directory, 'package-lock.json'), { lockfileVersion: 3, packages: {} });
        }
        options.onOutput('added fixture dependencies\n');
    });
    assert.equal(result.repairedLock, true); assert.deepEqual(calls.map(args => args[1]), ['ci', 'install', 'ci']);
    assert.ok(calls[1].includes('--package-lock=true'));
    assert.ok(calls[1].includes('--package-lock-only') && calls[1].includes('--include=dev') && calls[1].includes('--ignore-scripts'));
    assert.ok(!calls[1].includes('--omit=dev') && calls[2].includes('--omit=dev'));
    assert.match(await fs.readFile(result.logFile, 'utf8'), /EUSAGE[\s\S]*added fixture dependencies/);
});

test('rebuilding a candidate shrinkwrap keeps its filename and validates the rebuilt graph', async () => {
    const { device, directory } = await dependencyFixture();
    await fs.rename(path.join(directory, 'package-lock.json'), path.join(directory, 'npm-shrinkwrap.json'));
    const calls = [];
    await installPluginDependencies(device, directory, { log() {} }, async (_node, args, options) => {
        calls.push(args[1]);
        if (calls.length === 1) { options.onOutput(mismatch); throw new SyncError('PROCESS_FAILED', 'synthetic'); }
        if (args[1] === 'install') {
            await assert.rejects(fs.stat(path.join(directory, 'npm-shrinkwrap.json')), { code: 'ENOENT' });
            await atomicJson(path.join(directory, 'package-lock.json'), { lockfileVersion: 3, packages: {} });
        } else {
            assert.equal((await readJson(path.join(directory, 'npm-shrinkwrap.json'))).lockfileVersion, 3);
            await assert.rejects(fs.stat(path.join(directory, 'package-lock.json')), { code: 'ENOENT' });
        }
    });
    assert.deepEqual(calls, ['ci', 'install', 'ci']);
});

test('network and authentication errors do not bypass the lock or leak credentials into the dependency log', async () => {
    const { device, directory, job } = await dependencyFixture(); let calls = 0;
    await assert.rejects(installPluginDependencies(device, directory, { log() {} }, async (_node, _args, options) => {
        calls++; options.onOutput('npm error code E401\nhttps://fixture-user:private-password@example.invalid/pkg token=private-token\n');
        throw new SyncError('PROCESS_FAILED', 'synthetic');
    }), error => error.code === 'PLUGIN_DEPENDENCIES' && /extensions\/demo.*npm E401/.test(error.message));
    assert.equal(calls, 1);
    const log = await fs.readFile(path.join(job, 'dependencies.log'), 'utf8');
    assert.ok(!log.includes('private-password') && !log.includes('private-token')); assert.match(log, /redacted/);
});

test('installation refuses a live plugin directory and package.json semantic changes', async () => {
    const { device, directory } = await dependencyFixture(); let invoked = false;
    await assert.rejects(installPluginDependencies(device, path.join(device.install, 'plugins/demo'), {}, async () => { invoked = true; }), { code: 'DEPENDENCY_SCOPE' });
    assert.equal(invoked, false);
    await assert.rejects(installPluginDependencies(device, directory, { log() {} }, async () => {
        const file = path.join(directory, 'package.json'), pkg = await readJson(file); pkg.dependencies = {}; await atomicJson(file, pkg);
    }), { code: 'PLUGIN_DEPENDENCIES' });
});

test('actual offline npm repairs the candidate lock, preserves the sealed source, then succeeds with npm ci', { timeout: 60000 }, async () => {
    const { device, directory, job } = await dependencyFixture(), localDependency = path.join(path.dirname(directory), 'fixture-dependency');
    await atomicJson(path.join(localDependency, 'package.json'), { name: 'fixture-dependency', version: '1.0.0', main: 'index.js' });
    await fs.writeFile(path.join(localDependency, 'index.js'), 'module.exports = 1;\n');
    const pkg = await readJson(path.join(directory, 'package.json')); pkg.dependencies['fixture-dependency'] = 'file:../fixture-dependency';
    await atomicJson(path.join(directory, 'package.json'), pkg);
    const source = path.join(job, 'payload/extensions/demo'); await fs.mkdir(source, { recursive: true });
    const sourceLock = await fs.readFile(path.join(directory, 'package-lock.json'), 'utf8');
    await fs.writeFile(path.join(source, 'package-lock.json'), sourceLock);
    const execute = (node, args, options) => run(node, args, { ...options, env: { npm_config_cache: path.join(job, 'npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' } });
    assert.equal((await installPluginDependencies(device, directory, { log() {} }, execute)).repairedLock, true);
    assert.equal(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'), sourceLock);
    assert.equal((await readJson(path.join(directory, 'package-lock.json'))).packages[''].dependencies['fixture-dependency'], 'file:../fixture-dependency');
    assert.equal((await installPluginDependencies(device, directory, { log() {} }, execute)).repairedLock, false);
});
