import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { fixture, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { scan, transferSummary } from '../lib/manifest.mjs';
import { copyTree } from '../lib/manifest.mjs';
import { readJson, SyncError } from '../lib/io.mjs';
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
    const session = { hello: { current: null }, get env() { return { get rsync() { assert.fail('must not start rsync before approval'); } }; }, control: { request: async op => {
        calls.push(op); if (op === 'begin') return { phase: 'transfer' };
        if (op === 'inspect') return { changed: ['new'], extra: ['deleted'] };
        assert.fail('Unexpected remote mutation');
    } } };
    await assert.rejects(transport.push(session, device, randomUUID(), payload, manifest, null, null, { onPlan: async plan => {
        calls.push('size-confirmation'); assert.deepEqual(plan, { files: 1, bytes: 5 }); throw cancelled();
    } }), { code: 'CANCELLED' });
    assert.deepEqual(calls, ['begin', 'inspect', 'size-confirmation']);
});

for (const scoped of [false, true]) test(`${scoped ? 'selected' : 'complete'} download compares pinned source to the local basis before transfer`, async () => {
    const device = await fixture(), source = path.join(device.root, 'source'), payload = path.join(device.root, 'payload');
    await fs.mkdir(path.join(source, 'profile/worlds'), { recursive: true });
    await fs.writeFile(path.join(source, 'profile/worlds/changed.json'), 'BBBB');
    await fs.writeFile(path.join(source, 'profile/worlds/unchanged.json'), 'same');
    await fs.writeFile(path.join(source, 'profile/worlds/新增.json'), '12345');
    const environment = JSON.stringify({ scope: ['worlds'] }); await fs.writeFile(path.join(source, 'environment.json'), environment);
    await copyTree(source, payload); await fs.unlink(path.join(payload, 'profile/worlds/新增.json'));
    await fs.writeFile(path.join(payload, 'profile/worlds/changed.json'), 'AAAA');
    await fs.writeFile(path.join(payload, 'profile/worlds/deleted.json'), 'local only, not downloaded');
    const manifest = await scan(source), generation = randomUUID(), calls = [];
    const session = { hello: { capabilities: ['scoped-sync-v1'] }, env: { jobBound: true, get rsync() { assert.fail('must not start rsync before approval'); } }, control: { request: async op => {
        calls.push(op); assert.equal(op, 'begin');
        return { phase: 'transfer', generation, manifest, scope: scoped ? ['worlds'] : undefined, environment, publicationDigest: 'a'.repeat(64) };
    } } };
    await assert.rejects(transport.pull(session, device, randomUUID(), payload, null, null, { scope: scoped ? ['worlds'] : null, onPlan: async plan => {
        assert.deepEqual(plan, { files: 2, bytes: 9 }); throw cancelled();
    } }), { code: 'CANCELLED' });
    assert.deepEqual(calls, ['begin']);
    assert.equal(await fs.readFile(path.join(payload, 'profile/worlds/changed.json'), 'utf8'), 'AAAA');
});

class PlannedTransport extends MemoryTransport {
    async push(session, device, job, payload, manifest, progress, begin, options) {
        await options.onPlan(transferSummary(manifest, { missing: manifest.files.map(file => file.path), changed: [] }));
        return super.push(session, device, job, payload, manifest, progress, begin);
    }
}
test('upload waits for a bound size confirmation and retains the frozen snapshot despite later local edits', async () => {
    const device = await fixture(), remote = new PlannedTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager);
    const waiting = await phase(manager, 'AWAITING_CONFIRMATION');
    assert.equal(waiting.transferConfirmation, true); assert.ok(waiting.transferPlan.bytes > 0);
    assert.equal(remote.current, null); assert.equal(lifecycle.stopped, false);
    await assert.rejects(manager.action('confirm', { id: waiting.id, token: 'stale' }), { code: 'CONFIRMATION' });
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'worlds/book.json'), '{"local":"after snapshot"}');
    await manager.action('confirm', { id: waiting.id, token: waiting.confirmationToken }); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal((await readJson(path.join(remote.last.payload, 'profile/worlds/book.json'))).entries.one.content, 'synthetic world');
});

test('cancelling the size prompt publishes nothing and leaves the tavern running', async () => {
    const device = await fixture(), remote = new PlannedTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager);
    const waiting = await phase(manager, 'AWAITING_CONFIRMATION');
    await manager.action('cancel', { id: waiting.id }); await manager.done;
    assert.equal(remote.current, null); assert.equal(lifecycle.stopped, false);
    assert.equal((await manager.status()).error.code, 'CANCELLED');
});

test('size text distinguishes upload/download, handles zero and keeps actual traffic separate', () => {
    const upload = progressDetail({ direction: 'push', phase: 'AWAITING_CONFIRMATION', transferPlan: { files: 2, bytes: 1536 } });
    assert.match(upload, /待上传文件总大小：1\.50 KiB/); assert.match(upload, /不含删除和未变化文件/);
    assert.match(progressDetail({ direction: 'pull', phase: 'AWAITING_CONFIRMATION', transferPlan: { files: 1, bytes: 9 } }), /待下载文件总大小：9 B/);
    assert.match(progressDetail({ direction: 'pull', noChanges: true }), /待下载文件总大小：0 B/);
    assert.doesNotMatch(progressDetail({ direction: 'push', phase: 'SUCCEEDED', transferPlan: { files: 2, bytes: 1536 } }), /待上传/);
});

for (const action of ['confirm', 'cancel']) test(`the restarted waiting page displays size and sends ${action} with the current epoch`, async () => {
    const id = randomUUID(), oldEpoch = randomUUID(), epoch = randomUUID(), token = randomUUID();
    const elements = new Map(), calls = [];
    const element = name => { if (!elements.has(name)) elements.set(name, { hidden: true, disabled: false, textContent: '' }); return elements.get(name); };
    const context = vm.createContext({ document: { getElementById: element }, location: { replace() {} }, setTimeout() {}, fetch: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => url === '/csrf-token' ? { token: 'fixture-csrf' } : { id, epoch, confirmationToken: token, phase: 'AWAITING_CONFIRMATION', transferConfirmation: true, direction: 'push', transferPlan: { files: 2, bytes: 1536 } } };
    } });
    const html = waitPage({ id, tab: randomUUID(), ticket: randomUUID(), epoch: oldEpoch });
    vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(element('confirm').hidden, false); assert.equal(element('cancel').hidden, false);
    assert.equal(element('confirm').textContent, '开始上传'); assert.match(element('detail').textContent, /1\.50 KiB/);
    await element(action).onclick();
    const request = calls.find(call => call.url.endsWith('/' + action));
    assert.ok(request); assert.equal(request.options.headers['x-tavernsyn-epoch'], epoch);
    assert.deepEqual(JSON.parse(request.options.body), { id, token });
});

test('unmanaged download confirmation reaches its worker and binds the reply to the request', async () => {
    const source = await fixture(), remote = new MemoryTransport(path.join(source.root, 'vps')); await fs.mkdir(remote.root);
    const initial = new Manager(source, new FakeLifecycle(), remote);
    await initial.start({ direction: 'push', tab: randomUUID() }); await handoff(initial); await initial.done;
    const original = remote.pull.bind(remote);
    remote.pull = async (...args) => { await args[6].onPlan({ files: 1, bytes: 7 }); return original(...args); };
    const target = await fixture(), manager = new Manager(target, null, remote);
    await manager.start({ direction: 'pull', tab: randomUUID() });
    const waiting = await phase(manager, 'AWAITING_CONFIRMATION'); assert.equal(waiting.transferConfirmation, true);
    const child = new EventEmitter();
    child.send = message => {
        child.emit('message', { actionId: 'another request', error: { code: 'WRONG' } });
        manager.action(message.action, message.payload).then(result => child.emit('message', { actionId: message.actionId, result }));
    };
    assert.deepEqual(await workerAction(child, 'confirm', { id: waiting.id, token: waiting.confirmationToken }), { ok: true });
    await manager.done; assert.equal((await manager.status()).phase, 'PENDING_APPLY');
    assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('exit'), 0);
});

test('a disconnected download worker rejects the confirmation and releases listeners', async () => {
    const child = new EventEmitter(); child.send = () => queueMicrotask(() => child.emit('exit'));
    await assert.rejects(workerAction(child, 'cancel', { id: randomUUID() }), { code: 'WORKER' });
    assert.equal(child.listenerCount('message'), 0); assert.equal(child.listenerCount('exit'), 0);
});
