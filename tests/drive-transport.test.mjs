import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixture, FakeLifecycle, handoff } from './fixtures.mjs';
import { MemoryDrive } from './drive-fixtures.mjs';
import { createRepository } from '../lib/drive-repository.mjs';
import { driveFingerprint } from '../lib/drive-connection.mjs';
import { writeDriveCredentials } from '../lib/drive-auth.mjs';
import * as transport from '../helper/drive-transport.mjs';
import { Manager } from '../helper/manager.mjs';
import { atomicJson, exists, readJson } from '../lib/io.mjs';
import { snapshot, portableState } from '../lib/snapshot.mjs';
import { recoveryStatus } from '../helper/apply.mjs';

async function setup(t) {
    const cloud = new MemoryDrive(), key = randomBytes(32), binding = await createRepository(cloud.api, { key });
    const devices = await Promise.all([fixture(), fixture()]);
    t.after(async () => { for (const d of devices) await fs.rm(d.root, { recursive: true, force: true }); });
    for (const device of devices) {
        device.provider = 'google-drive'; device.drive = { ...binding, clientId: '12345-fixture.apps.googleusercontent.com', keyFingerprint: driveFingerprint(key) };
        await atomicJson(path.join(device.state, 'device.json'), { format: 1, deviceId: device.deviceId, install: device.install,
            profile: device.profile, provider: device.provider, drive: device.drive });
        await writeDriveCredentials(device, { clientId: device.drive.clientId, clientSecret: 'SYNTHETIC_CLIENT', refreshToken: 'SYNTHETIC_REFRESH', key: key.toString('hex') });
    }
    const adapter = { ...transport, connect: device => transport.connect(device, () => cloud.api) };
    return { cloud, devices, key, binding, adapter };
}
async function sync(manager, direction) {
    await manager.start({ direction, tab: randomUUID() }); await handoff(manager); await manager.done;
    const status = await manager.status(); assert.equal(status.phase, 'SUCCEEDED', JSON.stringify(status)); return status;
}
const payloads = cloud => [...cloud.files.values()].filter(f => f.metadata.appProperties?.kind === 'payload');
test('actual encrypted Drive transport and Manager mirror both ways and retain one cloud/local recovery copy', async t => {
    const { cloud, devices: [pc, phone], adapter } = await setup(t);
    const profile = device => path.join(device.dataRoot, device.profile);
    await fs.writeFile(path.join(profile(phone), 'old-only.txt'), 'delete me');
    await fs.writeFile(path.join(profile(pc), 'new-only.txt'), 'full mirror');
    const before = (await portableState(phone)).digest;
    const source = new Manager(pc, new FakeLifecycle(), adapter), target = new Manager(phone, new FakeLifecycle(), adapter);
    const pushed = await sync(source, 'push');
    assert.equal(payloads(cloud).length, 1); assert(!payloads(cloud)[0].data.includes(Buffer.from('SYNTHETIC_NOT_A_KEY')));
    assert.equal(pushed.transferPlan.files, 1); assert(pushed.stats.sentBytes > 0);
    await sync(target, 'pull');
    assert.equal(await exists(path.join(profile(phone), 'old-only.txt')), false);
    assert.equal(await fs.readFile(path.join(profile(phone), 'new-only.txt'), 'utf8'), 'full mirror');
    assert((await recoveryStatus(phone)).available);
    await fs.writeFile(path.join(profile(phone), 'phone-change.txt'), 'from phone');
    await sync(target, 'push'); assert.equal(payloads(cloud).length, 1);
    await sync(source, 'pull'); assert.equal(await fs.readFile(path.join(profile(pc), 'phone-change.txt'), 'utf8'), 'from phone');
    await sync(target, 'restore'); assert.equal((await portableState(phone)).digest, before);
    assert.equal(payloads(cloud).length, 1);
});
test('download can advance once when another publication removed the originally selected archive', async t => {
    const { cloud, devices: [pc, phone], adapter } = await setup(t);
    const manager = new Manager(pc, new FakeLifecycle(), adapter); await sync(manager, 'push');
    const oldSession = await adapter.connect(phone), oldId = oldSession.hello.current.fileId;
    await fs.writeFile(path.join(pc.dataRoot, pc.profile, 'new-generation.txt'), 'latest'); await sync(manager, 'push');
    assert.equal(cloud.files.has(oldId), false);
    const job = randomUUID(), payload = path.join(phone.state, 'jobs', job, 'payload');
    const result = await transport.pull(oldSession, phone, job, payload);
    assert.equal(await fs.readFile(path.join(payload, 'profile/new-generation.txt'), 'utf8'), 'latest');
    assert.notEqual(result.fileId, oldId); assert.equal((await readJson(path.join(path.dirname(payload), 'download.json'))).generation, result.generation);
    oldSession.control.close();
});
test('corrupt cloud bytes never reach apply or rotate an existing local recovery', async t => {
    const { cloud, devices: [pc, phone], adapter } = await setup(t);
    const source = new Manager(pc, new FakeLifecycle(), adapter), target = new Manager(phone, new FakeLifecycle(), adapter);
    await sync(source, 'push'); await sync(target, 'pull');
    const before = await portableState(phone), backup = await readJson(path.join(phone.state, 'apply.json'));
    await fs.writeFile(path.join(pc.dataRoot, pc.profile, 'will-not-apply.txt'), 'changed'); await sync(source, 'push');
    payloads(cloud)[0].data[40] ^= 1;
    await target.start({ direction: 'pull', tab: randomUUID() }); await target.done;
    assert.equal((await target.status()).phase, 'FAILED'); assert.equal((await portableState(phone)).digest, before.digest);
    assert.equal((await readJson(path.join(phone.state, 'apply.json'))).jobRoot, backup.jobRoot);
});
test('resuming an acknowledged encrypted generation avoids randomized re-encryption and duplicate publication', async t => {
    const { cloud, devices: [pc], adapter } = await setup(t), job = randomUUID();
    const payload = path.join(pc.state, 'jobs', job, 'payload'), frozen = await snapshot(pc, payload);
    let session = await adapter.connect(pc);
    const first = await transport.push(session, pc, job, payload, frozen.manifest); session.control.close();
    const count = cloud.files.size; session = await adapter.connect(pc);
    const again = await transport.push(session, pc, job, payload, frozen.manifest);
    assert.equal(again.generation, first.generation); assert.equal(again.stats.sentBytes, 0); assert.equal(cloud.files.size, count);
    session.control.close();
});
test('a progress write failure after confirmed publication cannot turn success into a repeatable failed upload', async t => {
    const { cloud, devices: [pc], adapter } = await setup(t), job = randomUUID();
    const payload = path.join(pc.state, 'jobs', job, 'payload'), frozen = await snapshot(pc, payload);
    const session = await adapter.connect(pc);
    const result = await transport.push(session, pc, job, payload, frozen.manifest, async value => {
        if (value.stage === 'transferred') throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
    });
    assert.equal(result.generation, job); assert(result.maintenance.length > 0);
    assert.equal((await session.repository.head()).generation, job); assert.equal(payloads(cloud).length, 1);
    session.control.close();
});
