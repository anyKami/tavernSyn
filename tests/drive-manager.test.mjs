import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Manager } from '../helper/manager.mjs';
import { validateDownloadBinding } from '../helper/download-binding.mjs';
import { connectionId, connectionIdentity, remoteDataset, remoteLabel } from '../lib/completion.mjs';
import { atomicJson, digest, exists, readJson, SyncError } from '../lib/io.mjs';
import { verifiedDownload } from '../lib/download.mjs';
import { withDeviceLock } from '../lib/connection.mjs';
import { recoverStopped } from '../bin/recover.mjs';
import { fixture, MemoryTransport, FakeLifecycle, handoff } from './fixtures.mjs';

async function deviceForDrive(identity) {
    const device = await fixture();
    device.provider = 'google-drive';
    device.drive = structuredClone(identity ?? { rootId: `root-${randomUUID()}`, folderId: `folder-${randomUUID()}`,
        dataset: randomUUID(), clientId: 'fixture.apps.googleusercontent.com', keyFingerprint: 'a'.repeat(64) });
    delete device.remote;
    return device;
}

class MemoryDrive extends MemoryTransport {
    constructor(root) { super(root); this.uploads = 0; this.downloads = 0; this.checks = 0; }
    async connect(device) {
        const current = this.current ? { ...this.current } : null;
        const hello = () => ({ dataset: device.drive.dataset, current: this.current ? { ...this.current } : null });
        return { provider: 'google-drive', hello: { ...hello(), current }, control: {
            close() {}, request: async op => { assert.equal(op, 'hello'); return hello(); },
        }, assertCurrent: async () => {
            this.checks++;
            await this.beforeAssert?.(this.checks);
            if ((this.current?.generation ?? null) !== (current?.generation ?? null)
                || (this.current?.digest ?? null) !== (current?.digest ?? null)) throw new SyncError('REMOTE_CHANGED', '测试云盘代次已改变。');
        } };
    }
    async push(...args) {
        this.uploads++;
        if (this.failBefore) { await args[6]?.({ job: args[2] }); throw new SyncError('DRIVE_NETWORK', '测试上传中断。'); }
        const result = await super.push(...args);
        if (this.failAfter) throw new SyncError('DRIVE_RESULT_UNKNOWN', '测试发布回执丢失。');
        return result;
    }
    async pull(...args) {
        this.downloads++;
        const result = await super.pull(...args);
        const [, device, job, payload] = args;
        await atomicJson(path.join(path.dirname(payload), 'download.json'), { format: 1, provider: 'google-drive', job,
            connection: connectionId(device), dataset: device.drive.dataset, generation: result.generation, digest: result.manifest.digest });
        if (this.failDownloadAfter) throw new SyncError('DRIVE_NETWORK', '测试完整下载回执之后中断。');
        return result;
    }
}

async function setup() {
    const source = await deviceForDrive(), remote = new MemoryDrive(path.join(source.root, 'drive'));
    await fs.mkdir(remote.root);
    return { source, remote };
}
async function upload(device, remote) {
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, remote);
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    return { manager, lifecycle, status: await manager.status() };
}

test('Drive identities bind repository, OAuth client and encryption key independently of VPS settings', async () => {
    const device = await deviceForDrive();
    const binding = connectionIdentity(device), job = { provider: 'google-drive', connectionBinding: binding };
    const original = connectionId(device, job);
    device.remote = { host: '100.64.0.2', user: 'changed', dataset: randomUUID() };
    device.drive.accessToken = 'refreshes-are-not-identity';
    assert.equal(connectionId(device, job), original);
    assert.equal(remoteDataset(device), device.drive.dataset); assert.equal(remoteLabel(device), 'Google 云盘');
    for (const key of ['rootId', 'folderId', 'dataset', 'clientId', 'keyFingerprint']) {
        const previous = device.drive[key]; device.drive[key] = `${previous}-changed`;
        assert.throws(() => connectionId(device, job), { code: 'CONFIG_CHANGED' }, key);
        device.drive[key] = previous;
    }
    device.provider = 'vps';
    assert.throws(() => connectionId(device, job), { code: 'CONFIG_CHANGED' });
    assert.equal(connectionId(device), digest({ host: device.remote.host, user: device.remote.user, dataset: device.remote.dataset }));
});

test('Drive full mirror reuses controlled apply, preserves local fields and rotates exactly one recovery backup', async () => {
    const { source, remote } = await setup();
    assert.equal((await upload(source, remote)).status.phase, 'SUCCEEDED');
    const target = await deviceForDrive(source.drive), localOnly = path.join(target.dataRoot, target.profile, 'worlds/local.json');
    await atomicJson(localOnly, { local: true });
    const settingsFile = path.join(target.dataRoot, target.profile, 'settings.json');
    const settings = await readJson(settingsFile); settings.power_user.chat_width = 44; await atomicJson(settingsFile, settings);
    const lifecycle = new FakeLifecycle(), manager = new Manager(target, lifecycle, remote);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    const first = await manager.status(), journal = await readJson(path.join(target.state, 'apply.json'));
    assert.equal(first.phase, 'SUCCEEDED'); assert.equal(first.provider, 'google-drive');
    assert.equal(await exists(localOnly), false);
    assert.equal((await readJson(settingsFile)).power_user.chat_width, 44);
    assert.equal((await readJson(path.join(target.dataRoot, target.profile, 'secrets.json'))).fake_api_key, 'SYNTHETIC_NOT_A_KEY');
    const oldProfile = journal.steps.find(step => step.live === path.join(target.dataRoot, target.profile)).old;
    assert.equal((await readJson(path.join(oldProfile, 'worlds/local.json'))).local, true);
    await atomicJson(path.join(source.dataRoot, source.profile, 'worlds/book.json'), { entries: { newest: { content: 'new publication' } } });
    await upload(source, remote);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    const second = await manager.status(), latest = await readJson(path.join(target.state, 'apply.json'));
    assert.equal(second.phase, 'SUCCEEDED'); assert.notEqual(second.id, first.id);
    assert.equal(latest.phase, 'committed'); assert.equal(latest.jobRoot, path.join(target.state, 'jobs', second.id));
    assert.equal(await exists(path.join(target.state, 'jobs', first.id)), false);
    const latestOldProfile = latest.steps.find(step => step.live === path.join(target.dataRoot, target.profile)).old;
    assert.equal(await exists(path.join(latestOldProfile, 'worlds/local.json')), false);
    assert.equal((await readJson(path.join(latestOldProfile, 'worlds/book.json'))).entries.one.content, 'synthetic world');
    assert.equal(lifecycle.starts, 2); assert.equal(remote.checks, 4);
});

test('Drive rejects categorized sync before creating a job or contacting storage', async () => {
    const device = await deviceForDrive();
    const manager = new Manager(device, new FakeLifecycle(), { connect() { throw Error('must not connect'); } });
    await assert.rejects(manager.start({ direction: 'push', preview: true, tab: randomUUID(), scope: ['worlds'] }), { code: 'UNSUPPORTED_SCOPE' });
    assert.equal(await exists(path.join(device.state, 'operation.lock')), false);
    assert.equal(await exists(path.join(device.state, 'status.json')), false);
});

test('Drive does not offer VPS partial-download resume records', async () => {
    const device = await deviceForDrive(), manager = new Manager(device, null);
    assert.equal(await manager.canResumeDownload({ phase: 'FAILED', direction: 'pull', failurePhase: 'DOWNLOADING' }), false);
    assert.throws(() => validateDownloadBinding(device, randomUUID(), {}), { code: 'DOWNLOAD_BINDING' });
});

test('Drive frozen upload resumes only against its exact base publication', async () => {
    const { source, remote } = await setup();
    await upload(source, remote);
    const base = { ...remote.current };
    await atomicJson(path.join(source.dataRoot, source.profile, 'worlds/book.json'), { entries: {} });
    remote.failBefore = true;
    const { status } = await upload(source, remote);
    assert.equal(status.phase, 'FAILED'); assert.equal(status.snapshotReady, true);
    remote.failBefore = false;
    remote.current = { generation: randomUUID(), digest: base.digest };
    const manager = new Manager(source, new FakeLifecycle(), remote), before = remote.uploads;
    await manager.action('resume-upload', { id: status.id, tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'REMOTE_CHANGED'); assert.equal(remote.uploads, before);
    remote.current = base;
    await manager.action('resume-upload', { id: status.id, tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.equal(remote.uploads, before + 1);
});

test('Drive lost publish acknowledgement is reconciled without another upload', async () => {
    const { source, remote } = await setup(); remote.failAfter = true;
    const { status } = await upload(source, remote);
    assert.equal(status.phase, 'FAILED'); assert.equal(remote.current.generation, status.id);
    const repaired = await new Manager(source, null, remote).action('reconcile', { id: status.id });
    assert.equal(repaired.phase, 'SUCCEEDED'); assert.equal(repaired.commit.kind, 'published'); assert.equal(remote.uploads, 1);
});

test('Drive completed pending download applies offline only with its original repository receipt', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive), download = new Manager(target, null, remote);
    await download.start({ direction: 'pull', tab: randomUUID() }); await download.done;
    const pending = await download.status(); assert.equal(pending.phase, 'PENDING_APPLY');
    const manager = new Manager(target, new FakeLifecycle(), { connect() { throw Error('pending apply must stay offline'); } });
    await manager.action('resume-pending', { tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.equal(remote.downloads, 1);
});

test('Drive pending apply rejects a changed repository before acquiring the apply lock', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive), manager = new Manager(target, null, remote);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    target.drive.rootId = 'another-root'; manager.lifecycle = new FakeLifecycle();
    await assert.rejects(manager.action('resume-pending', { tab: randomUUID() }), { code: 'CONFIG_CHANGED' });
    assert.equal(await exists(path.join(target.state, 'operation.lock')), false);
    assert.equal(await exists(path.join(target.state, 'apply.json')), false);
});

test('Drive pending apply rejects a tampered receipt without stopping SillyTavern', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive), download = new Manager(target, null, remote);
    await download.start({ direction: 'pull', tab: randomUUID() }); await download.done;
    const pending = await download.status(), file = path.join(pending.jobRoot, 'download.json');
    const receipt = await readJson(file); receipt.generation = randomUUID(); await atomicJson(file, receipt);
    const lifecycle = new FakeLifecycle(), manager = new Manager(target, lifecycle, remote);
    await manager.action('resume-pending', { tab: randomUUID() }); await manager.done;
    assert.equal((await manager.status()).error.code, 'DOWNLOAD_BINDING');
    assert.equal(lifecycle.starts, 0); assert.equal(await exists(path.join(target.state, 'apply.json')), false);
});

test('Drive publication changes during handoff stop stale application and preserve the previous recovery', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive), lifecycle = new FakeLifecycle(), manager = new Manager(target, lifecycle, remote);
    const local = path.join(target.dataRoot, target.profile, 'worlds/local.json'); await atomicJson(local, { first: true });
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    const recoveryBefore = await readJson(path.join(target.state, 'apply.json'));
    await atomicJson(local, { later: true });
    remote.beforeAssert = async count => { if (count === 4) remote.current = { generation: randomUUID(), digest: 'b'.repeat(64) }; };
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).error.code, 'REMOTE_CHANGED');
    assert.deepEqual(await readJson(path.join(target.state, 'apply.json')), recoveryBefore);
    assert.deepEqual(await readJson(local), { later: true }); assert.equal(lifecycle.stopped, false);
});

test('only a fully verified Drive download with a bound receipt can be recovered offline', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive); remote.failDownloadAfter = true;
    const manager = new Manager(target, null, remote);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await manager.done;
    const failed = await manager.status(); assert.equal(failed.canResumeDownload, false);
    const verified = await verifiedDownload(target, failed); assert.equal(verified.remote.generation, remote.current.generation);
    await fs.unlink(path.join(verified.jobRoot, 'download.json'));
    await assert.rejects(verifiedDownload(target, failed), { code: 'DOWNLOAD_BINDING' });
});

test('completed historical Drive receipts do not block stopped-process recovery after switching storage', async () => {
    const { source, remote } = await setup();
    const { status } = await upload(source, remote);
    source.provider = 'vps'; source.origin = 'http://127.0.0.1:0';
    await recoverStopped(source);
    assert.equal((await readJson(path.join(source.state, 'status.json'))).id, status.id);
    assert.equal((await readJson(path.join(source.state, 'status.json'))).phase, 'SUCCEEDED');
});

test('a failed-looking status with a durable Drive outcome blocks configuration until reconciliation', async () => {
    const { source, remote } = await setup();
    const { status } = await upload(source, remote);
    await atomicJson(path.join(source.state, 'status.json'), { ...status, phase: 'FAILED', commit: undefined, maintenancePending: false });
    let changed = false;
    await assert.rejects(withDeviceLock(source, async () => { changed = true; source.provider = 'vps'; }), { code: 'FINALIZATION_PENDING' });
    assert.equal(changed, false); assert.equal(source.provider, 'google-drive');
    assert.equal(await exists(path.join(source.state, 'operation.lock')), false);
    const repaired = await new Manager(source, null, remote).action('reconcile', { id: status.id });
    assert.equal(repaired.phase, 'SUCCEEDED'); assert.equal(repaired.maintenancePending, false);
});

test('local recovery remains usable after changing from Drive to VPS without any remote connection', async () => {
    const { source, remote } = await setup(); await upload(source, remote);
    const target = await deviceForDrive(source.drive), local = path.join(target.dataRoot, target.profile, 'worlds/local.json');
    await atomicJson(local, { previous: true });
    const manager = new Manager(target, new FakeLifecycle(), remote);
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal(await exists(local), false);
    target.provider = 'vps';
    manager.transport = { connect() { throw Error('restore must not connect'); } };
    await manager.start({ direction: 'restore', tab: randomUUID() }); await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED'); assert.deepEqual(await readJson(local), { previous: true });
    assert.equal(await exists(path.join(target.state, 'recovery')), false);
});
