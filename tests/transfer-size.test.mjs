import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { fixture, MemoryTransport, FakeLifecycle, handoff } from './fixtures.mjs';
import { scan, transferSummary } from '../lib/manifest.mjs';
import { copyTree } from '../lib/manifest.mjs';
import { atomicJson, readJson, SyncError } from '../lib/io.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import * as transport from '../helper/transport.mjs';
import { Manager } from '../helper/manager.mjs';
import { progressDetail } from '../ui/progress.js';
import { waitPage, workerAction } from '../server/index.mjs';

const cancelled = () => new SyncError('CANCELLED', 'test cancellation before any file transfer');

test('pending size counts added/modified full files once, excluding deletions and unchanged files', () => {
    const manifest = { files: [{ path: 'new 空.txt', size: 13 }, { path: 'changed', size: 4096 }, { path: 'empty', size: 0 }, { path: 'unchanged', size: 999999 }] };
    assert.deepEqual(transferSummary(manifest, { missing: ['new 空.txt', 'empty'], changed: ['changed', 'new 空.txt'], extra: ['deleted'] }), { files: 3, bytes: 4109 });
    assert.deepEqual(transferSummary(manifest, { missing: [], changed: [], extra: ['deleted'] }), { files: 0, bytes: 0 });
    assert.throws(() => transferSummary(manifest, { missing: ['unknown'], changed: [] }), { code: 'MANIFEST' });
});

test('upload obtains receiver differences and waits before touching the rsync environment', async () => {
    const device = await fixture(), payload = path.join(device.root, 'payload'); await fs.mkdir(payload);
    await fs.writeFile(path.join(payload, 'new'), '12345'); await fs.writeFile(path.join(payload, 'unchanged'), 'already present');
    const manifest = await scan(payload), calls = [];
    const session = { hello: { current: null, capabilities: ['inspect-preserves-partials'] }, get env() { return { get rsync() { assert.fail('must report size before starting rsync'); } }; }, control: { request: async (op, fields) => {
        calls.push(op); if (op === 'begin') return { job: fields.job, direction: fields.direction, generation: fields.job, base: null, phase: 'transfer' };
        if (op === 'inspect') return { changed: ['new'], extra: ['deleted'] };
        assert.fail('Unexpected remote mutation');
    } } };
    await assert.rejects(transport.push(session, device, randomUUID(), payload, manifest, null, null, { onPlan: async plan => {
        calls.push('size-report'); assert.deepEqual(plan, { files: 1, bytes: 5 }); throw cancelled();
    } }), { code: 'CANCELLED' });
    assert.deepEqual(calls, ['begin', 'inspect', 'size-report']);
});

for (const scoped of [false, true]) test(`${scoped ? 'selected' : 'complete'} download compares pinned source to the local basis before transfer`, async () => {
    const device = await fixture(), job = randomUUID(), source = path.join(device.root, 'source'), payload = path.join(device.state, 'jobs', job, 'payload');
    await fs.mkdir(path.join(source, 'profile/worlds'), { recursive: true });
    await fs.writeFile(path.join(source, 'profile/worlds/changed.json'), 'BBBB');
    await fs.writeFile(path.join(source, 'profile/worlds/unchanged.json'), 'same');
    await fs.writeFile(path.join(source, 'profile/worlds/新增.json'), '12345');
    const environment = JSON.stringify({ scope: ['worlds'] }); await fs.writeFile(path.join(source, 'environment.json'), environment);
    await copyTree(source, payload); await fs.unlink(path.join(payload, 'profile/worlds/新增.json'));
    await fs.writeFile(path.join(payload, 'profile/worlds/changed.json'), 'AAAA');
    await fs.writeFile(path.join(payload, 'profile/worlds/deleted.json'), 'local only, not downloaded');
    const partial = path.join(payload, 'profile/worlds/.tavernsyn-partial/changed.json');
    await fs.mkdir(path.dirname(partial)); await fs.writeFile(partial, 'BB');
    const manifest = await scan(source), generation = randomUUID(), calls = [];
    const session = { hello: { capabilities: ['scoped-sync-v1'] }, env: { jobBound: true, get rsync() { assert.fail('must report size before starting rsync'); } }, control: { request: async op => {
        calls.push(op); assert.equal(op, 'begin');
        return { job, direction: 'pull', base: null, phase: 'transfer', generation, manifest, scope: scoped ? ['worlds'] : undefined, environment, publicationDigest: 'a'.repeat(64) };
    } } };
    await assert.rejects(transport.pull(session, device, job, payload, null, null, { scope: scoped ? ['worlds'] : null, onPlan: async plan => {
        assert.deepEqual(plan, { files: 2, bytes: 9 }); throw cancelled();
    } }), { code: 'CANCELLED' });
    assert.deepEqual(calls, ['begin']);
    assert.equal(await fs.readFile(path.join(payload, 'profile/worlds/changed.json'), 'utf8'), 'AAAA');
    assert.equal(await fs.readFile(partial, 'utf8'), 'BB');
    await assert.rejects(scan(payload), { code: 'FILENAME' });
    assert.equal((await readJson(path.join(path.dirname(payload), 'download-resume.json'))).state, 'transferring');
});

class PlannedTransport extends MemoryTransport {
    async push(session, device, job, payload, manifest, progress, begin, options) {
        await options.onPlan(this.plan ?? transferSummary(manifest, { missing: manifest.files.map(file => file.path), changed: [] }));
        await this.beforeTransfer?.();
        return super.push(session, device, job, payload, manifest, progress, begin);
    }
}
test('upload reports size and continues automatically with its frozen snapshot despite later local edits', async () => {
    const device = await fixture(), remote = new PlannedTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), phases = [], manager = new Manager(device, lifecycle, remote, job => phases.push(job.phase));
    remote.beforeTransfer = async () => {
        const status = await manager.status();
        assert.equal(status.phase, 'UPLOADING'); assert.ok(status.transferPlan.bytes > 0);
        assert.equal(remote.current, null); assert.equal(lifecycle.stopped, false);
        await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/book.json'), '{"local":"after snapshot"}');
    };
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.ok(!phases.includes('AWAITING_CONFIRMATION'));
    assert.equal((await readJson(path.join(remote.last.payload, 'profile/worlds/book.json'))).entries.one.content, 'synthetic world');
});

test('invalid transfer size still prevents publication and leaves the tavern running', async () => {
    const device = await fixture(), remote = new PlannedTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    remote.plan = { files: 1, bytes: -1 };
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal(remote.current, null); assert.equal(lifecycle.stopped, false);
    assert.equal((await manager.status()).error.code, 'MANIFEST');
});

test('size text distinguishes upload/download, handles zero and keeps actual traffic separate', () => {
    const upload = progressDetail({ direction: 'push', phase: 'UPLOADING', transferPlan: { files: 2, bytes: 1536 } });
    assert.match(upload, /待上传文件总大小：1\.50 KiB/); assert.match(upload, /不含删除和未变化文件/);
    assert.match(progressDetail({ direction: 'pull', phase: 'DOWNLOADING', transferPlan: { files: 1, bytes: 9 } }), /待下载文件总大小：9 B/);
    assert.match(progressDetail({ direction: 'pull', noChanges: true }), /待下载文件总大小：0 B/);
    assert.doesNotMatch(progressDetail({ direction: 'push', phase: 'SUCCEEDED', transferPlan: { files: 2, bytes: 1536 } }), /待上传/);
});

for (const direction of ['push', 'pull']) test(`the waiting page shows ${direction} size without asking for confirmation`, async () => {
    const id = randomUUID(), epoch = randomUUID(), elements = new Map(), calls = [];
    const element = name => { if (!elements.has(name)) elements.set(name, { hidden: true, textContent: '' }); return elements.get(name); };
    const context = vm.createContext({ document: { getElementById: element }, location: { replace() {} }, setTimeout() {}, fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url === '/csrf-token' ? { token: 'fixture-csrf' } : { id, epoch, phase: direction === 'push' ? 'UPLOADING' : 'DOWNLOADING', direction, transferPlan: { files: 2, bytes: 1536 } } };
    } });
    const html = waitPage({ id, tab: randomUUID(), ticket: randomUUID(), epoch });
    assert.doesNotMatch(html, /id="confirm"/);
    vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(element('detail').textContent, /1\.50 KiB/);
    assert.deepEqual(calls.filter(call => call.options?.method === 'POST').map(call => call.url), ['/api/plugins/tavernsyn/page']);
});

test('unmanaged download reports size and stages automatically without any confirmation', async () => {
    const source = await fixture(), remote = new MemoryTransport(path.join(source.root, 'vps')); await fs.mkdir(remote.root);
    const initial = new Manager(source, new FakeLifecycle(), remote);
    await initial.start({ direction: 'push', tab: randomUUID() }); await handoff(initial); await initial.done;
    const original = remote.pull.bind(remote);
    remote.pull = async (...args) => { await args[6].onPlan({ files: 1, bytes: 7 }); return original(...args); };
    const target = await fixture(), phases = [], manager = new Manager(target, null, remote, job => phases.push(job.phase));
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    const status = await manager.status();
    assert.equal(status.phase, 'PENDING_APPLY'); assert.deepEqual(status.transferPlan, { files: 1, bytes: 7 });
    assert.ok(!phases.includes('AWAITING_CONFIRMATION'));
});

test('a disconnected download worker rejects the action and releases listeners', async () => {
    const child = new EventEmitter(); child.send = () => queueMicrotask(() => child.emit('exit'));
    await assert.rejects(workerAction(child, 'cancel', { id: randomUUID() }), { code: 'WORKER' });
    assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('exit'), 0);
});

for (const [direction, scope] of [['push', null], ['pull', null], ['pull', ['worlds']]]) {
    test(`${scope ? 'scoped ' : ''}${direction} preserves only completed rsync statistics after corrective transfer fails`, async t => {
        const device = await fixture(), source = await fixture();
        await atomicJson(path.join(source.dataRoot, source.profile, 'worlds/book.json'), { entries: { one: { content: 'remote fixture' } } });
        const sourcePayload = path.join(source.root, 'payload'), { manifest } = await snapshot(source, sourcePayload, { scope });
        const environment = await fs.readFile(path.join(sourcePayload, 'environment.json'), 'utf8');
        const jobFile = 'profile/worlds/book.json', generation = randomUUID(), publicationDigest = 'a'.repeat(64);
        const spawn = childProcess.spawn, rsync = path.join(device.root, 'rsync-fixture');
        t.mock.method(childProcess, 'spawn', (executable, args, options) => {
            if (executable !== rsync) return spawn(executable, args, options);
            const child = new EventEmitter();
            child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            queueMicrotask(() => {
                const correction = args.includes('--ignore-times');
                if (!correction) child.stdout.write('Total bytes sent: 123\nTotal bytes received: 45\nLiteral data: 12 bytes\nMatched data: 0 bytes\nNumber of regular files transferred: 1\n');
                child.emit('close', correction ? 12 : 0, null);
            });
            return child;
        });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
        let reconnects = 0;
        const remote = {
            ...transport,
            async catalog() { return { generation, digest: publicationDigest, scope, manifest, environment }; },
            async connect() {
                return {
                    env: { jobBound: true, deviceId: device.deviceId, rsync, posix: async file => file, rsh: '' },
                    hello: { dataset: device.remote.dataset, current: { generation, digest: publicationDigest },
                        capabilities: ['scoped-sync-v1', 'inspect-preserves-partials', 'job-bound-rsync'] },
                    log() {},
                    async reconnect() { reconnects++; throw new SyncError('PERMISSION', 'cannot reauthenticate synthetic receiver'); },
                    control: { close() {}, async request(op, fields) {
                        if (op === 'begin') return { job: fields.job, direction, generation: direction === 'push' ? fields.job : generation,
                            base: publicationDigest, manifest, phase: 'transfer', ...(scope ? { scope, environment, publicationDigest } : {}) };
                        if (op === 'inspect') return { changed: [jobFile], extra: [] };
                        assert.fail(`a failed correction cannot ${op}`);
                    } },
                };
            },
            async pull(session, currentDevice, id, payload, progress, onBegin, options) {
                return transport.pull(session, currentDevice, id, payload, progress, async receipt => {
                    await onBegin(receipt);
                    await copyTree(sourcePayload, payload);
                    const file = path.join(payload, jobFile), contents = await fs.readFile(file), original = await fs.stat(file);
                    contents[1] ^= 1;
                    await fs.writeFile(file, contents);
                    await fs.utimes(file, original.atime, original.mtime);
                }, options);
            },
        };
        const manager = new Manager(device, direction === 'push' ? new FakeLifecycle() : null, remote);
        await manager.start({ direction, tab: randomUUID(), scope });
        if (direction === 'push') await handoff(manager);
        await manager.done;
        const status = await manager.status();
        assert.equal(status.phase, 'FAILED', JSON.stringify(status));
        assert.equal(status.error.code, 'PERMISSION');
        assert.equal(reconnects, 1);
        assert.equal(status.stats.sentBytes, 123);
        assert.equal(status.stats.receivedBytes, 45);
        assert.equal(status.stats.incompleteNetworkStats, true);
        assert.match(progressDetail(status), /未包含部分中断尝试流量/);
    });
}
