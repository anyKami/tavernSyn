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
async function receiveFull(source, target) {
    const frozen = await source.export(target.device);
    const ready = await target.prepareReceive(source.device, frozen.id);
    assert.deepEqual(ready, { id: frozen.id });
    assert.equal(target.basis, undefined);
    assert.equal(await exists(path.join(target.root, 'usb-basis')), false);
    let progress;
    await target.receive(Readable.from(encodeUsb(frozen.payload, frozen.manifest, {
        onProgress: value => { progress = value; },
    })), source.device, frozen.id);
    assert.deepEqual(progress, { bytes: source.manager.job.transfer.bytes, files: source.manager.job.transfer.files });
    assert.deepEqual(target.manager.job.transfer, source.manager.job.transfer);
    return { frozen, ready, progress };
}
async function transferFull(source, target) {
    const received = await receiveFull(source, target);
    const result = await target.apply(); await source.acknowledge(result);
    assert.equal(source.manager.job.stats.sentBytes, received.progress.bytes);
    assert.equal(target.manager.job.stats.receivedBytes, received.progress.bytes);
    assert.equal(source.manager.job.stats.matchedBytes, source.manager.job.transfer.reusedBytes);
    assert.equal(target.manager.job.stats.transferredFiles, received.progress.files);
    return { ...received, result };
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

test('USB prepares an independent verified candidate in one copy pass', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'asset.bin'), Buffer.alloc(1024, 0x6a));
    const source = await open(t, a), target = await open(t, b);
    await receiveFull(source, target);
    const staged = await fs.stat(path.join(target.payload, 'profile/asset.bin'));
    const result = await target.apply(); await source.acknowledge(result);
    const applied = await fs.stat(path.join(b.dataRoot, b.profile, 'asset.bin'));
    assert.equal(applied.dev, staged.dev); assert.notEqual(applied.ino, staged.ino);
    assert.equal(await exists(path.join(target.root, 'candidate/repositories')), false);
});

test('USB candidate detaches matching staged hard links from external files', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'asset.bin'), 'same');
    const external = path.join(b.root, 'external.bin'); await fs.writeFile(external, 'same');
    const source = await open(t, a), target = await open(t, b);
    await receiveFull(source, target);
    const staged = path.join(target.payload, 'profile/asset.bin');
    await fs.unlink(staged); await fs.link(external, staged);
    const result = await target.apply(); await source.acknowledge(result);
    await fs.writeFile(external, 'evil');
    assert.equal(await fs.readFile(path.join(b.dataRoot, b.profile, 'asset.bin'), 'utf8'), 'same');
});

test('USB writes through an old staging handle cannot change the prepared live candidate', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'asset.bin'), 'same');
    const source = await open(t, a), target = await open(t, b);
    await receiveFull(source, target);
    const handle = await fs.open(path.join(target.payload, 'profile/asset.bin'), 'r+');
    const write = target.manager.write.bind(target.manager); let changed = false;
    target.manager.write = async (phase, fields) => {
        if (phase === 'APPLYING' && !changed) { changed = true; await handle.write('evil', 0, 'utf8'); }
        return write(phase, fields);
    };
    try {
        const result = await target.apply(); await source.acknowledge(result);
        assert.equal(changed, true);
        assert.equal(await fs.readFile(path.join(b.dataRoot, b.profile, 'asset.bin'), 'utf8'), 'same');
    } finally { await handle.close(); }
});

test('USB candidate flush failure preserves the previous recovery journal and live data', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'asset.bin'), 'same');
    const firstSource = await open(t, a), firstTarget = await open(t, b);
    await transferFull(firstSource, firstTarget); await firstSource.close(); await firstTarget.close();
    const journal = await readJson(path.join(b.state, 'apply.json')), before = await portableState(b);
    const source = await open(t, a), target = await open(t, b);
    await receiveFull(source, target);
    const openFile = fs.open.bind(fs); let attempted = false;
    const mock = t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await openFile(file, ...args);
        if (file === path.join(target.root, 'candidate/profile/asset.bin') && args[0] === 'r+') {
            handle.sync = async () => { attempted = true; throw Object.assign(new Error('synthetic delayed writeback failure'), { code: 'EIO' }); };
        }
        return handle;
    });
    try { await assert.rejects(target.apply(), { code: 'EIO' }); }
    finally { mock.mock.restore(); }
    assert.equal(attempted, true);
    assert.deepEqual(await readJson(path.join(b.state, 'apply.json')), journal);
    assert.equal((await recoveryStatus(b)).available, true);
    assert.equal((await portableState(b)).digest, before.digest);
});

test('USB reverse full transfers rotate the target recovery point', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const source = await open(t, b), target = await open(t, a);
    await transferFull(source, target); await source.close(); await target.close();
    const before = await portableState(a);
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'second.txt'), 'second snapshot');
    const secondSource = await open(t, b), secondTarget = await open(t, a);
    await transferFull(secondSource, secondTarget);
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
    const source = await open(t, a), target = await open(t, b, life), { frozen } = await receiveFull(source, target);
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

for (const [sourceName, targetName] of [['电脑', '手机'], ['手机', '电脑']]) {
    test(`USB full ${sourceName} to ${targetName} transfers matching content and detects equal-size equal-time edits while mirroring deletions`, async t => {
        const a = await device(t, sourceName), b = await device(t, targetName);
        const profile = value => path.join(value.dataRoot, value.profile);
        const shared = Buffer.alloc(2 * 1024 * 1024, 0x61);
        for (const value of [a, b]) {
            await fs.writeFile(path.join(profile(value), 'unchanged-image.bin'), shared);
            await fs.writeFile(path.join(profile(value), 'same-size.txt'), value === a ? 'new!' : 'old!');
            await fs.utimes(path.join(profile(value), 'same-size.txt'), 1730000000, 1730000000);
        }
        // Mtime cannot be used as the content identity in either direction.
        await fs.utimes(path.join(profile(a), 'unchanged-image.bin'), 1720000000, 1720000000);
        await fs.utimes(path.join(profile(b), 'unchanged-image.bin'), 1740000000, 1740000000);
        await fs.writeFile(path.join(profile(a), 'new.txt'), 'new file');
        await fs.writeFile(path.join(profile(b), 'deleted.txt'), 'remove from mirror');
        const local = await readJson(path.join(profile(b), 'settings.json')); local.power_user.chat_width = 43;
        await atomicJson(path.join(profile(b), 'settings.json'), local);
        const source = await open(t, a), target = await open(t, b);
        const { result, frozen } = await transferFull(source, target);
        assert.equal(result.applied, true);
        assert.equal(await fs.readFile(path.join(profile(b), 'same-size.txt'), 'utf8'), 'new!');
        assert.equal(await fs.readFile(path.join(profile(b), 'new.txt'), 'utf8'), 'new file');
        assert.equal(await exists(path.join(profile(b), 'deleted.txt')), false);
        assert.deepEqual(await fs.readFile(path.join(profile(b), 'unchanged-image.bin')), shared);
        assert.equal((await readJson(path.join(profile(b), 'settings.json'))).power_user.chat_width, 43);
        assert.equal(source.manager.job.transfer.mode, 'full');
        assert.equal(source.manager.job.transfer.files, frozen.manifest.files.length);
        assert.equal(source.manager.job.transfer.bytes, frozen.manifest.bytes);
        assert.equal(source.manager.job.transfer.reusedBytes, 0);
        assert.equal(source.manager.job.transfer.totalBytes, frozen.manifest.bytes);
        assert.equal(source.manager.job.transfer.reusedFiles, 0);
        assert.equal((await recoveryStatus(b)).available, true);
    });
}

test('USB identical canonical snapshots still transfer every file and preserve per-device JSON fields', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const profile = value => path.join(value.dataRoot, value.profile);
    for (const [value, localPath] of [[a, 'C:/desktop/config'], [b, '/data/data/com.termux/files/home/config']]) {
        value.preserveJson = [{ path: 'profile/custom-config.json', pointers: ['/localPath'] }];
        await atomicJson(path.join(profile(value), 'custom-config.json'), { localPath, shared: { enabled: true } });
    }
    const local = await readJson(path.join(profile(b), 'settings.json')); local.power_user.chat_width = 43;
    await atomicJson(path.join(profile(b), 'settings.json'), local);
    const source = await open(t, a), target = await open(t, b);
    const { progress, result } = await transferFull(source, target);
    assert.equal(result.applied, true);
    assert.deepEqual(progress, { bytes: source.manager.job.bytes, files: source.manager.job.files });
    assert.equal(source.manager.job.transfer.reusedFiles, 0);
    assert.equal(source.manager.job.transfer.reusedBytes, 0);
    assert.equal(target.manager.job.stats.literalBytes, source.manager.job.bytes);
    assert.equal(target.lifecycle.starts, 1, 'full content completes verification and the normal apply health check');
    assert.equal((await readJson(path.join(profile(b), 'settings.json'))).power_user.chat_width, 43);
    assert.equal((await readJson(path.join(profile(b), 'custom-config.json'))).localPath, '/data/data/com.termux/files/home/config');
});

test('USB staged same-size corruption with restored mtime never consumes the previous recovery point', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.writeFile(path.join(a.dataRoot, a.profile, 'shared.bin'), 'same');
    const firstSource = await open(t, a), firstTarget = await open(t, b);
    await transferFull(firstSource, firstTarget); await firstSource.close(); await firstTarget.close();
    const before = await portableState(b), journal = await readJson(path.join(b.state, 'apply.json'));
    const source = await open(t, a), target = await open(t, b);
    const { frozen } = await receiveFull(source, target);
    const file = path.join(target.payload, 'profile/shared.bin'), stat = await fs.stat(file);
    await fs.writeFile(file, 'evil'); await fs.utimes(file, stat.atime, stat.mtime);
    await assert.rejects(target.apply(), { code: 'INTEGRITY' });
    assert.equal((await portableState(b)).digest, before.digest);
    assert.deepEqual(await readJson(path.join(b.state, 'apply.json')), journal);
    assert.equal((await recoveryStatus(b)).available, true);
    assert.equal(await readCompletion(b, frozen.id), null);
});

for (const fault of ['truncated', 'corrupt']) {
    test(`USB ${fault} full contents cannot apply or consume the previous recovery point`, async t => {
        const a = await device(t, '电脑'), b = await device(t, '手机');
        const firstSource = await open(t, a), firstTarget = await open(t, b);
        await transferFull(firstSource, firstTarget); await firstSource.close(); await firstTarget.close();
        const before = await portableState(b), journal = await readJson(path.join(b.state, 'apply.json'));
        await fs.writeFile(path.join(a.dataRoot, a.profile, 'z-new.bin'), Buffer.alloc(8192, 0x3a));
        const source = await open(t, a), target = await open(t, b), frozen = await source.export(b);
        await target.prepareReceive(a, frozen.id);
        const chunks = [];
        for await (const chunk of encodeUsb(frozen.payload, frozen.manifest)) chunks.push(chunk);
        const wire = Buffer.concat(chunks);
        if (fault === 'corrupt') wire[wire.length - 1] ^= 1;
        await assert.rejects(target.receive(Readable.from([fault === 'truncated' ? wire.subarray(0, -1) : wire]), a, frozen.id),
            { code: fault === 'truncated' ? 'USB_TRUNCATED' : 'INTEGRITY' });
        assert.equal((await portableState(b)).digest, before.digest);
        assert.deepEqual(await readJson(path.join(b.state, 'apply.json')), journal);
        assert.equal((await recoveryStatus(b)).available, true);
        assert.equal(await readCompletion(b, frozen.id), null);
        await assert.rejects(target.apply(), { code: 'USB_STAGE' });
    });
}

test('USB target changes after receive preparation are rejected before consuming recovery', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const firstSource = await open(t, a), firstTarget = await open(t, b);
    await transferFull(firstSource, firstTarget); await firstSource.close(); await firstTarget.close();
    const journal = await readJson(path.join(b.state, 'apply.json'));
    const source = await open(t, a), target = await open(t, b);
    await receiveFull(source, target);
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'external-edit.txt'), 'keep this live edit');
    await assert.rejects(target.apply(), { code: 'LOCAL_CHANGED' });
    assert.equal(await fs.readFile(path.join(b.dataRoot, b.profile, 'external-edit.txt'), 'utf8'), 'keep this live edit');
    assert.deepEqual(await readJson(path.join(b.state, 'apply.json')), journal);
    assert.equal((await recoveryStatus(b)).available, true);
});

test('USB full sync restores a target with missing settings by transferring the complete snapshot', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    await fs.unlink(path.join(b.dataRoot, b.profile, 'settings.json'));
    await fs.writeFile(path.join(b.dataRoot, b.profile, 'obsolete.txt'), 'remove during complete restore');
    const source = await open(t, a), target = await open(t, b);
    const { result } = await transferFull(source, target);
    assert.equal(result.applied, true);
    assert.equal(source.manager.job.transfer.bytes, source.manager.job.bytes);
    assert.equal(source.manager.job.transfer.reusedBytes, 0);
    assert.equal((await readJson(path.join(b.dataRoot, b.profile, 'settings.json'))).username, 'fixture');
    assert.equal(await exists(path.join(b.dataRoot, b.profile, 'obsolete.txt')), false);
    assert.equal((await recoveryStatus(b)).available, true);
});

test('USB full sync restores a configured target extra root that does not exist yet', async t => {
    const a = await device(t, '电脑'), b = await device(t, '手机');
    const sourceExtra = path.join(a.root, 'portable-extra'), targetExtra = path.join(b.root, 'missing-extra');
    a.extraRoots = [{ id: 'custom', path: sourceExtra }];
    b.extraRoots = [{ id: 'custom', path: targetExtra }];
    await fs.mkdir(sourceExtra);
    await fs.writeFile(path.join(sourceExtra, 'payload.txt'), 'restore this portable extra root');
    const source = await open(t, a), target = await open(t, b);
    const { result } = await transferFull(source, target);
    assert.equal(result.applied, true);
    assert.equal(source.manager.job.transfer.bytes, source.manager.job.bytes);
    assert.equal(source.manager.job.transfer.reusedBytes, 0);
    assert.equal(await fs.readFile(path.join(targetExtra, 'payload.txt'), 'utf8'), 'restore this portable extra root');
    assert.equal((await recoveryStatus(b)).available, true);
});

for (const [relative, broken, valid] of [
    ['worlds/book.json', '{"invalid":', '{"entries":{"repaired":{"content":"restored source world"}}}\n'],
    ['chats/repaired.jsonl', 'invalid chat line\n', '{"name":"fixture","is_user":true,"mes":"restored source chat"}\n'],
]) {
    test(`USB full sync repairs damaged target ${relative} using a complete validated source`, async t => {
        const a = await device(t, '电脑'), b = await device(t, '手机');
        await fs.writeFile(path.join(a.dataRoot, a.profile, relative), valid);
        await fs.writeFile(path.join(b.dataRoot, b.profile, relative), broken);
        const source = await open(t, a), target = await open(t, b);
        const { result } = await transferFull(source, target);
        assert.equal(result.applied, true);
            assert.equal(source.manager.job.transfer.bytes, source.manager.job.bytes);
        assert.equal(source.manager.job.transfer.reusedBytes, 0);
        assert.equal(await fs.readFile(path.join(b.dataRoot, b.profile, relative), 'utf8'), valid);
        assert.equal((await recoveryStatus(b)).available, true);
    });
}
