import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { fixture, FakeLifecycle } from './fixtures.mjs';
import { atomicJson, exists, readJson } from '../lib/io.mjs';
import { portableState } from '../lib/snapshot.mjs';
import { encodeUsb } from '../lib/usb-stream.mjs';
import { readCompletion } from '../lib/completion.mjs';
import { UsbSession } from '../helper/usb-sync.mjs';
import { recoveryStatus, rollback } from '../helper/apply.mjs';

async function device(t, name) {
    const value = await fixture(); value.deviceName = name;
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    value.origin = `http://127.0.0.1:${port}`; value.stConfig.port = port;
    await fs.writeFile(value.yamlPath, value.YAML.stringify(value.stConfig));
    t.after(() => fs.rm(value.root, { recursive: true, force: true }));
    return value;
}
async function open(t, value, lifecycle = new FakeLifecycle()) {
    lifecycle.stopped = true;
    const session = new UsbSession(value, { lifecycle }); await session.open();
    t.after(() => session.close()); return session;
}
async function transfer(source, target) {
    const frozen = await source.export(target.device);
    await target.receive(Readable.from(encodeUsb(frozen.payload, frozen.manifest)), source.device, frozen.id);
    const result = await target.apply(); await source.acknowledge(result); return result;
}

test('USB full mirror includes private data and deletion, preserves local fields and one usable backup', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const profile = value => path.join(value.dataRoot, value.profile);
    await atomicJson(path.join(profile(a), 'worlds/new.json'), { entries: { a: { content: 'new world' } } });
    await fs.writeFile(path.join(profile(b), 'obsolete.txt'), 'target-only content');
    const local = await readJson(path.join(profile(b), 'settings.json')); local.power_user.chat_width = 43;
    await atomicJson(path.join(profile(b), 'settings.json'), local);
    const before = await portableState(b);
    const source = await open(t, a), target = await open(t, b);
    const result = await transfer(source, target);
    assert.equal(result.applied, true); assert.equal(source.status().stage, 'completed');
    assert.equal(await exists(path.join(profile(b), 'obsolete.txt')), false);
    assert.equal((await readJson(path.join(profile(b), 'worlds/new.json'))).entries.a.content, 'new world');
    assert.equal((await readJson(path.join(profile(b), 'settings.json'))).power_user.chat_width, 43);
    assert.equal((await readJson(path.join(profile(b), 'secrets.json'))).fake_api_key, 'SYNTHETIC_NOT_A_KEY');
    assert.equal((await recoveryStatus(b)).available, true);
    assert.equal(target.lifecycle.stopped, true); assert.equal(target.lifecycle.starts, 1);
    // USB receipts survive changing/removing an unrelated VPS configuration.
    b.remote = undefined; assert.equal((await readCompletion(b, result.jobId)).job.transport, 'usb');
    await target.close();
    await rollback(b, await readJson(path.join(b.state, 'apply.json')));
    assert.equal((await portableState(b)).digest, before.digest);
});

test('USB reverse direction and repeated transfers rotate the target recovery point', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const source = await open(t, b), target = await open(t, a);
    await transfer(source, target); await source.close(); await target.close();
    const before = await portableState(a);
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'second.txt'), 'second snapshot');
    const secondSource = await open(t, b), secondTarget = await open(t, a);
    await transfer(secondSource, secondTarget);
    assert.equal((await recoveryStatus(a)).available, true);
    const journal = await readJson(path.join(a.state, 'apply.json'));
    assert.equal(journal.jobRoot, secondTarget.root);
    await secondTarget.close(); await rollback(a, journal);
    assert.equal((await portableState(a)).digest, before.digest);
    assert.equal(await exists(path.join(a.state, 'jobs', target.manager.job.id)), false);
});

test('USB refuses running servers and existing locks without removing them', async t => {
    const a = await device(t, '电脑');
    const server = net.createServer(); await new Promise(resolve => server.listen(Number(new URL(a.origin).port), '127.0.0.1', resolve));
    await assert.rejects(new UsbSession(a).open(), { code: 'USB_RUNNING' });
    await new Promise(resolve => server.close(resolve));
    assert.equal(await exists(path.join(a.state, 'launcher.lock')), false);
    await atomicJson(path.join(a.state, 'operation.lock'), { pid: process.pid, id: randomUUID() });
    await assert.rejects(new UsbSession(a).open(), { code: 'USB_RUNNING' });
    assert.equal((await readJson(path.join(a.state, 'operation.lock'))).pid, process.pid);
    assert.equal(await exists(path.join(a.state, 'launcher.lock')), false);
});

test('USB truncated or corrupt upload never applies or consumes the old recovery backup', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const source = await open(t, a), target = await open(t, b);
    await transfer(source, target); await source.close(); await target.close();
    const before = await portableState(b), journal = await readJson(path.join(b.state, 'apply.json'));
    const nextSource = await open(t, a), nextTarget = await open(t, b);
    const frozen = await nextSource.export(b), chunks = [];
    for await (const chunk of encodeUsb(frozen.payload, frozen.manifest)) chunks.push(chunk);
    const truncated = Buffer.concat(chunks).subarray(0, -7);
    await assert.rejects(nextTarget.receive(Readable.from([truncated]), a, frozen.id));
    assert.equal((await portableState(b)).digest, before.digest);
    assert.deepEqual(await readJson(path.join(b.state, 'apply.json')), journal);
    await assert.rejects(nextTarget.apply(), { code: 'USB_STAGE' });
    assert.equal((await recoveryStatus(b)).available, true);
});

test('USB health failure rolls back target data and cannot produce a success receipt', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'only-on-target.txt'), 'keep on failure');
    const before = await portableState(b), life = new FakeLifecycle(); life.failNext = true;
    const source = await open(t, a), target = await open(t, b, life), frozen = await source.export(b);
    await target.receive(Readable.from(encodeUsb(frozen.payload, frozen.manifest)), a, frozen.id);
    await assert.rejects(target.apply(), { code: 'HEALTH' });
    assert.equal((await portableState(b)).digest, before.digest);
    assert.equal(target.status().stage, 'failed'); assert.equal(target.status().result, undefined);
    assert.equal(await readCompletion(b, frozen.id), null);
    await assert.rejects(source.acknowledge({ jobId: frozen.id, applied: true, deviceId: a.deviceId, digest: frozen.manifest.digest }), { code: 'USB_RESULT' });
});

test('USB detects target edits before replacing data or deleting a previous backup', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const source = await open(t, a), target = await open(t, b), frozen = await source.export(b);
    await target.receive(Readable.from(encodeUsb(frozen.payload, frozen.manifest)), a, frozen.id);
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'external-edit.txt'), 'do not replace');
    await assert.rejects(target.apply(), { code: 'LOCAL_CHANGED' });
    assert.equal(await fs.readFile(path.join(b.dataRoot, b.profile, 'external-edit.txt'), 'utf8'), 'do not replace');
    assert.equal(await exists(path.join(b.state, 'recovery')), false);
});

test('USB never rolls back beneath an unrelated server that stole the health port', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'new-from-source.txt'), 'new');
    const before = await portableState(b), lifecycle = new FakeLifecycle(), occupied = net.createServer();
    lifecycle.start = async () => {
        await new Promise(resolve => occupied.listen(Number(new URL(b.origin).port), '127.0.0.1', resolve));
        lifecycle.stopped = true;
        throw Object.assign(new Error('port stolen by unowned instance'), { code: 'START_FAILED' });
    };
    const source = await open(t, a), target = await open(t, b, lifecycle), frozen = await source.export(b);
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    await target.receive(Readable.from(encodeUsb(frozen.payload, frozen.manifest)), a, frozen.id);
    await assert.rejects(target.apply(), { code: 'RECOVERY_REQUIRED' });
    assert.equal((await readJson(path.join(b.state, 'apply.json'))).phase, 'applied');
    assert.notEqual((await portableState(b)).digest, before.digest);
    assert.equal(await exists(path.join(b.dataRoot, b.profile, 'new-from-source.txt')), true);
    assert.equal(await exists(path.join(b.state, 'recovery')), true);
});

test('USB refuses self sync, pending recovery and repeated jobs', async t => {
    const a = await device(t, '电脑');
    const source = await open(t, a);
    await assert.rejects(source.export(a), { code: 'USB_IDENTITY' });
    await source.close();
    await atomicJson(path.join(a.state, 'status.json'), { phase: 'PENDING_APPLY' });
    await assert.rejects(new UsbSession(a).open(), { code: 'RECOVERY_REQUIRED' });
    assert.equal(await exists(path.join(a.state, 'operation.lock')), false);
});
