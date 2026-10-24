import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, MemoryTransport, FakeLifecycle, handoff, phase } from './fixtures.mjs';
import { configuration, configureDevice, readPassword } from '../lib/connection.mjs';
import { atomicJson, readJson, exists } from '../lib/io.mjs';
import { Manager } from '../helper/manager.mjs';

async function setup() {
    const device = await fixture(); delete device.remote;
    await atomicJson(path.join(device.state, 'device.json'), { format: 1, deviceId: device.deviceId, install: device.install, profile: device.profile, untouched: 'retain' });
    return { device, body: { host: '100.100.100.100', user: 'tavernsyn', password: ' SYNTHETIC 密码 \'"$`\\ password ' } };
}

test('password configuration works without device keys or a manual dataset and survives a fresh instance', async () => {
    const { device, body } = await setup();
    const result = await configureDevice(device, 'configure', { ...body, host: ` ${body.host} ` });
    assert.equal(result.configured, true); assert.equal(result.passwordSaved, true); assert.equal(result.dataset, '');
    assert.equal(await exists(path.join(device.state, 'credentials/device_ed25519')), false);
    assert.ok(!JSON.stringify(result).includes(body.password)); assert.equal(result.password, undefined);
    const saved = await readJson(path.join(device.state, 'device.json'));
    assert.equal(saved.untouched, 'retain'); assert.equal(saved.remote.host, body.host);
    assert.equal(saved.remote.identityFile, undefined); assert.ok(!JSON.stringify(saved).includes(body.password));
    assert.equal(await readPassword(saved.remote.passwordFile), body.password);
    const restarted = { ...device, remote: saved.remote };
    assert.deepEqual(await configuration(restarted), result);
    await configureDevice(restarted, 'configure', { host: body.host, user: body.user, password: '' });
    assert.equal(await readPassword(saved.remote.passwordFile), body.password);
    if (process.platform !== 'win32') assert.equal((await fs.stat(saved.remote.passwordFile)).mode & 0o777, 0o600);
});

test('invalid fields and commands cannot mutate either the password or saved connection', async () => {
    const { device, body } = await setup(); await configureDevice(device, 'configure', body);
    const before = await fs.readFile(path.join(device.state, 'device.json'), 'utf8');
    const secretBefore = await fs.readFile(device.remote.passwordFile, 'utf8');
    for (const patch of [{ user: 'root' }, { host: '127.0.0.1' }, { host: '100.999.1.2' }, { host: '-oProxyCommand=bad' },
        { dataset: '../bad' }, { identityFile: 'elsewhere' }, { passwordFile: 'elsewhere' }, { tools: { ssh: 'bad' } },
        { serverHostKey: 'old key field' }, { trustConfirmed: true }, { password: 123 }, { password: 'bad\npassword' }, { password: 'bad\x00password' }]) {
        await assert.rejects(configureDevice(device, 'configure', { ...body, ...patch }));
        assert.equal(await fs.readFile(path.join(device.state, 'device.json'), 'utf8'), before);
        assert.equal(await fs.readFile(device.remote.passwordFile, 'utf8'), secretBefore);
    }
    await assert.rejects(configureDevice(device, 'keygen', {}), { code: 'INPUT' });
});

test('a new target requires a password; changing the password keeps the dataset binding', async () => {
    const { device, body } = await setup();
    await assert.rejects(configureDevice(device, 'configure', { host: body.host, user: body.user }), { code: 'PASSWORD' });
    const dataset = randomUUID(); await configureDevice(device, 'configure', { ...body, dataset });
    await configureDevice(device, 'configure', { ...body, password: 'changed password' });
    assert.equal(device.remote.dataset, dataset); assert.equal(await readPassword(device.remote.passwordFile), 'changed password');
    await assert.rejects(configureDevice(device, 'configure', { host: '100.100.100.101', user: body.user }), { code: 'PASSWORD' });
    await configureDevice(device, 'configure', { ...body, host: '100.100.100.101' });
    assert.equal(device.remote.dataset, '');
});

test('an existing key-based installation keeps its old files and switches after entering a password', async () => {
    const { device, body } = await setup();
    const legacy = path.join(device.state, 'credentials/device_ed25519'); await fs.mkdir(path.dirname(legacy));
    await fs.writeFile(legacy, 'LEGACY_PRIVATE_FIXTURE');
    device.remote = { host: body.host, user: body.user, dataset: randomUUID(), identityFile: legacy,
        knownHostsFile: path.join(device.state, 'credentials/known_hosts') };
    assert.equal((await configuration(device)).configured, false);
    const dataset = device.remote.dataset;
    await configureDevice(device, 'configure', body);
    assert.equal(device.remote.dataset, dataset); assert.equal(device.remote.identityFile, undefined);
    assert.equal(await fs.readFile(legacy, 'utf8'), 'LEGACY_PRIVATE_FIXTURE');
});

test('operation locks and pending recovery prevent connection changes without discarding tasks', async () => {
    const { device, body } = await setup(), lock = path.join(device.state, 'operation.lock');
    await fs.writeFile(lock, 'another-operation');
    await assert.rejects(configureDevice(device, 'configure', body), { code: 'BUSY' });
    assert.equal(await fs.readFile(lock, 'utf8'), 'another-operation'); await fs.unlink(lock);
    for (const current of ['PENDING_APPLY', 'RECOVERY_REQUIRED', 'UPLOADING']) {
        await atomicJson(path.join(device.state, 'status.json'), { phase: current });
        await assert.rejects(configureDevice(device, 'configure', body), { code: 'BUSY' });
        assert.equal((await readJson(path.join(device.state, 'status.json'))).phase, current);
    }
});

test('the running manager uses the saved password configuration on the next check', async () => {
    const { device, body } = await setup(); let checked;
    const manager = new Manager(device, null, { async connect(current) { checked = current.remote; return { hello: {}, control: { close() {} } }; } });
    await manager.action('configure', body); await manager.action('check');
    assert.equal(checked.host, body.host); assert.equal(await readPassword(checked.passwordFile), body.password);
    manager.busy = true;
    await assert.rejects(manager.action('configure', body), { code: 'BUSY' });
    await assert.rejects(manager.action('check'), { code: 'BUSY' });
});

test('a different dataset requires fresh overwrite confirmation even with an identical remote digest', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const manager = new Manager(device, new FakeLifecycle(), remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    device.remote.dataset = randomUUID();
    await manager.start({ direction: 'push', tab: randomUUID() });
    const confirmation = await phase(manager, 'AWAITING_CONFIRMATION');
    assert.match(confirmation.reason, /尚未建立同步基准/);
    await manager.action('cancel', { id: confirmation.id }); await manager.done;
});
