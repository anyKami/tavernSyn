import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverDownload } from '../bin/recover-download.mjs';
import { recoverStopped } from '../bin/recover.mjs';
import { Manager } from '../helper/manager.mjs';
import { pull } from '../helper/transport.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { connectionId } from '../lib/completion.mjs';
import { copyTree, scan } from '../lib/manifest.mjs';
import { atomicJson, digest, exists, readJson, SyncError } from '../lib/io.mjs';
import { fixture, FakeLifecycle, handoff, phase } from './fixtures.mjs';

async function downloaded() {
    const device = await fixture(), id = randomUUID(), root = path.join(device.state, 'jobs', id);
    const frozen = await snapshot(device, path.join(root, 'payload'));
    await atomicJson(path.join(root, 'manifest.json'), frozen.manifest);
    const { host, user, dataset } = device.remote;
    const status = { id, direction: 'pull', phase: 'FAILED', remoteJob: id,
        connection: digest({ host: host ?? '', user: user ?? '', dataset }),
        remoteBase: { generation: randomUUID(), digest: frozen.manifest.digest },
        error: { code: 'SSH', message: 'SSH 控制连接已关闭。' }, progress: { percent: 100 } };
    await atomicJson(path.join(device.state, 'status.json'), status);
    return { device, root, status, manifest: frozen.manifest };
}

test('legacy verified pull recovers offline, then automatically applies and restarts once', async () => {
    const { device, root, status } = await downloaded();
    const local = path.join(device.dataRoot, device.profile, 'worlds/local-only.json');
    await fs.writeFile(local, '{"entries":{}}');
    const pending = await recoverDownload(device);
    assert.equal(pending.phase, 'PENDING_APPLY'); assert.equal(pending.progress, null); assert.equal(pending.error, null);
    assert.equal(pending.remote.generation, status.remoteBase.generation);
    assert.equal(await exists(local), true, 'offline recovery only stages; it does not apply live data');
    assert.equal((await readJson(path.join(root, 'job.json'))).phase, 'PENDING_APPLY');
    const lifecycle = new FakeLifecycle(), manager = new Manager(device, lifecycle, {
        connect() { throw Error('offline continuation must not connect or redownload'); },
    });
    await manager.action('resume-pending', { tab: randomUUID() });

    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(local), false); assert.equal(lifecycle.starts, 1);
    assert.equal((await readJson(path.join(device.state, 'last-apply.json'))).phase, 'committed');
});

test('download receipt pins the original generation even if hello saw a different publication', async () => {
    const { device, root, status, manifest } = await downloaded(), generation = randomUUID();
    await atomicJson(path.join(root, 'download.json'), { format: 1, job: status.id, dataset: device.remote.dataset, generation, digest: manifest.digest });
    status.remoteBase = { generation: randomUUID(), digest: 'a'.repeat(64) };
    await atomicJson(path.join(device.state, 'status.json'), status);
    assert.equal((await recoverDownload(device)).remote.generation, generation);
});

test('100 percent progress never permits damaged, partial or unbound downloads to be applied', async () => {
    for (const failure of ['damaged', 'missing', 'target', 'generation', 'after-apply', 'journal', 'lock', 'receipt']) {
        const { device, root, status, manifest } = await downloaded();
        let code;
        if (failure === 'damaged') { await fs.writeFile(path.join(root, 'payload/profile/worlds/book.json'), '{}'); code = 'INTEGRITY'; }
        if (failure === 'missing') { await fs.unlink(path.join(root, 'manifest.json')); code = 'NO_DOWNLOAD'; }
        if (failure === 'target') { device.remote.host = '100.64.0.2'; code = 'CONFIG_CHANGED'; }
        if (failure === 'generation') { status.remoteBase.digest = 'b'.repeat(64); code = 'MANIFEST'; }
        if (failure === 'after-apply') { status.remoteJob = null; code = 'NO_DOWNLOAD'; }
        if (failure === 'journal') { await atomicJson(path.join(device.state, 'apply.json'), { jobRoot: root, phase: 'committed' }); code = 'NO_DOWNLOAD'; }
        if (failure === 'lock') { await fs.writeFile(path.join(device.state, 'operation.lock'), '{}'); code = 'BUSY'; }
        if (failure === 'receipt') {
            await atomicJson(path.join(root, 'download.json'), { format: 1, job: randomUUID(), dataset: device.remote.dataset, generation: randomUUID(), digest: manifest.digest }); code = 'MANIFEST';
        }
        await atomicJson(path.join(device.state, 'status.json'), status);
        await assert.rejects(recoverDownload(device), { code }, failure);
        assert.equal((await readJson(path.join(device.state, 'status.json'))).phase, 'FAILED', failure);
        assert.equal(await exists(path.join(device.state, 'operation.lock')), failure === 'lock', failure);
    }
});

async function interrupted(scope = null, { beforePayload = false } = {}) {
    const source = await fixture(), device = await fixture();
    await atomicJson(path.join(source.dataRoot, source.profile, 'worlds/book.json'), { entries: { one: { content: 'pinned old publication' } } });
    const remotePayload = path.join(source.root, 'pinned');
    const { manifest } = await snapshot(source, remotePayload, { scope });
    const environment = await fs.readFile(path.join(remotePayload, 'environment.json'), 'utf8');
    const generation = randomUUID(), publicationDigest = 'a'.repeat(64);
    const beginRequests = [], completed = [];
    const remote = {
        current: { generation, digest: publicationDigest },
        catalog: async () => ({ generation, digest: publicationDigest, scope, manifest, environment }),
        async connect(currentDevice) {
            if (this.beforeConnect) await this.beforeConnect();
            return {
                hello: { dataset: currentDevice.remote.dataset, current: this.current, capabilities: ['scoped-sync-v1', 'job-bound-rsync'] },
                env: { jobBound: true },
                control: {
                    close() {},
                    request: async (op, fields) => {
                        assert.equal(op, 'begin'); beginRequests.push(fields);
                        if (fields.resumeOnly && this.refusal) throw this.refusal;
                        return { job: fields.job, direction: 'pull', generation, base: publicationDigest, manifest,
                            phase: fields.resumeOnly && !beforePayload ? 'done' : 'transfer', ...(scope ? { scope, environment, publicationDigest } : {}),
                            ...(fields.resumeOnly ? this.changed : {}) };
                    },
                },
            };
        },
        async pull(session, currentDevice, id, payload, progress, onBegin, options) {
            let resumedPhase;
            return pull(session, currentDevice, id, payload, progress, async receipt => {
                assert.equal((await readJson(path.join(path.dirname(payload), 'download-resume.json'))).job, id,
                    'the immutable binding is durable before recording begin in Manager');
                await onBegin(receipt);
                resumedPhase = receipt.phase;
                if (!options.resume) {
                    if (beforePayload) throw new SyncError('SSH', 'simulated interruption immediately after begin');
                    await copyTree(remotePayload, payload);
                    const partial = path.join(payload, 'profile/worlds/.tavernsyn-partial/book.json');
                    await fs.mkdir(path.dirname(partial)); await fs.writeFile(partial, 'incomplete bytes');
                }
            }, {
                ...options,
                onPlan: async plan => {
                    await options.onPlan(plan);
                    if (!options.resume) throw new SyncError('SSH', 'simulated interruption after planning');
                    completed.push(plan);
                    if (beforePayload && resumedPhase === 'transfer') throw new SyncError('CANCELLED', 'stop after recreating the transfer directory');
                },
            });
        },
    };
    const first = new Manager(device, null, remote);
    const { id } = await first.start({ direction: 'pull', tab: randomUUID(), scope });
    await first.done;
    const failed = await first.status();
    assert.equal(failed.error?.code, 'SSH', JSON.stringify(failed));
    assert.equal(failed.canResumeDownload, true);
    const root = path.join(device.state, 'jobs', id);
    return { device, id, root, generation, publicationDigest, manifest, remote, beginRequests, completed,
        partial: path.join(root, 'payload/profile/worlds/.tavernsyn-partial/book.json'), failed };
}

for (const scope of [null, ['worlds']]) {
    test(`${scope ? 'scoped' : 'full'} download reopens the original job and generation after a manager restart`, async () => {
        const f = await interrupted(scope);
        f.remote.current = { generation: randomUUID(), digest: 'b'.repeat(64) };
        const manager = new Manager(f.device, null, f.remote);
        assert.equal(await fs.readFile(f.partial, 'utf8'), 'incomplete bytes');
        assert.equal((await manager.status()).canResumeDownload, true);
        assert.equal((await manager.action('resume-download', { id: f.id, tab: randomUUID() })).id, f.id);
        await manager.done;
        const status = await manager.status();
        assert.equal(status.phase, 'PENDING_APPLY', JSON.stringify(status));
        assert.equal(status.canResumeDownload, false);
        assert.equal(status.remote.generation, f.generation);
        assert.equal(status.remote.digest, scope ? f.publicationDigest : f.manifest.digest);
        assert.deepEqual(f.beginRequests.map(({ job, resumeOnly, scope }) => ({ job, resumeOnly, scope })), [
            { job: f.id, resumeOnly: undefined, scope: scope ?? undefined }, { job: f.id, resumeOnly: true, scope: scope ?? undefined },
        ]);
        assert.equal(await exists(f.partial), false);
        const binding = await readJson(path.join(f.root, 'download-resume.json'));
        assert.equal(binding.state, 'verified');
        assert.equal(binding.connection, connectionId(f.device));
        assert.equal(binding.manifest.digest, f.manifest.digest);
        assert.equal((await readJson(path.join(f.root, 'download.json'))).generation, f.generation);
        assert.equal((await readJson(path.join(f.device.dataRoot, f.device.profile, 'worlds/book.json'))).entries.one.content, 'synthetic world');
    });
}

for (const scope of [null, ['worlds']]) {
    test(`${scope ? 'scoped' : 'full'} download can recreate its stage after stopping just after begin`, async t => {
        const f = await interrupted(scope, { beforePayload: true });
        const payload = path.join(f.root, 'payload');
        assert.equal(await exists(payload), false);
        const cache = path.join(f.device.state, 'cache/payload');
        await fs.mkdir(cache, { recursive: true });
        await fs.writeFile(path.join(cache, 'unrelated-cache.txt'), 'fixture from another task');
        const manager = new Manager(f.device, null, f.remote);
        assert.equal((await manager.action('resume-download', { id: f.id, tab: randomUUID() })).id, f.id);
        await manager.done;
        const status = await manager.status();
        assert.equal(status.error?.code, 'CANCELLED', JSON.stringify(status));
        assert.equal(f.completed.length, 1);
        assert.equal(f.beginRequests.length, 2);
        assert.deepEqual(f.beginRequests[1], { job: f.id, dataset: f.device.remote.dataset, direction: 'pull', jobBound: true,
            ...(scope ? { scope } : {}), resumeOnly: true });
        const binding = await readJson(path.join(f.root, 'download-resume.json'));
        assert.equal(binding.generation, f.generation);
        assert.deepEqual((await scan(payload)).files.map(file => file.path), scope ? ['environment.json'] : []);
        if (scope) assert.equal(await fs.readFile(path.join(payload, 'environment.json'), 'utf8'), binding.environment);
        await fs.unlink(path.join(payload, 'environment.json')).catch(error => {
            if (scope || error.code !== 'ENOENT') throw error;
        });
        await fs.rmdir(payload);
        f.remote.changed = { phase: 'done' };
        await manager.action('resume-download', { id: f.id, tab: randomUUID() });
        await manager.done;
        assert.equal((await manager.status()).error?.code, 'DOWNLOAD_BINDING');
        assert.equal(await exists(payload), false);
        assert.equal(f.completed.length, 1);
        f.remote.changed = null;
        await fs.writeFile(payload, 'unsafe non-directory stage');
        await manager.action('resume-download', { id: f.id, tab: randomUUID() });
        await manager.done;
        assert.equal((await manager.status()).error?.code, 'DOWNLOAD_BINDING');
        assert.equal(await fs.readFile(payload, 'utf8'), 'unsafe non-directory stage');
        await fs.unlink(payload);
        await t.test('a linked stage is rejected before touching its target', async subtest => {
            const external = path.join(f.device.root, 'external-stage');
            await fs.mkdir(external);
            try { await fs.symlink(external, payload, process.platform === 'win32' ? 'junction' : 'dir'); }
            catch (error) {
                if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
                subtest.skip('directory link creation unavailable');
                return;
            }
            await manager.action('resume-download', { id: f.id, tab: randomUUID() });
            await manager.done;
            assert.equal((await manager.status()).error?.code, 'UNSAFE_PATH');
            assert.deepEqual(await fs.readdir(external), []);
        });
    });
}

test('a failed reconnect can itself be retried with the same binding and partials', async () => {
    const f = await interrupted();
    f.remote.beforeConnect = () => { throw new SyncError('SSH', 'network remains down'); };
    const manager = new Manager(f.device, null, f.remote);
    await manager.action('resume-download', { id: f.id, tab: randomUUID() });
    await manager.done;
    const failure = await manager.status();
    assert.equal(failure.error.code, 'SSH');
    assert.equal(failure.canResumeDownload, true);
    assert.equal(await fs.readFile(f.partial, 'utf8'), 'incomplete bytes');
    f.remote.beforeConnect = null;
    await manager.action('resume-download', { id: f.id, tab: randomUUID() });
    await manager.done;
    assert.equal((await manager.status()).phase, 'PENDING_APPLY');
    assert.equal(f.beginRequests.length, 2);
});

test('scoped transfer restores missing or truncated metadata from its fixed receipt without touching done-stage bytes', async t => {
    const scope = ['worlds'];
    const f = await interrupted(scope, { beforePayload: true });
    const payload = path.join(f.root, 'payload'), environment = path.join(payload, 'environment.json');
    const binding = await readJson(path.join(f.root, 'download-resume.json'));
    await fs.mkdir(path.dirname(f.partial), { recursive: true });
    await fs.writeFile(f.partial, 'already downloaded bytes');
    const rename = fs.rename, replacements = [];
    t.mock.method(fs, 'rename', async (from, to) => {
        if (to === environment) {
            assert.equal(path.dirname(from), f.root);
            assert.deepEqual(await fs.readFile(from), Buffer.from(binding.environment, 'utf8'));
            replacements.push(await exists(environment) ? await fs.readFile(environment, 'utf8') : null);
        }
        return rename(from, to);
    });
    const manager = new Manager(f.device, null, f.remote);
    const resume = async () => {
        assert.equal((await manager.action('resume-download', { id: f.id, tab: randomUUID() })).id, f.id);
        await manager.done;
        return manager.status();
    };
    for (const original of [null, '{"scope":']) {
        if (await exists(environment)) await fs.unlink(environment);
        if (original !== null) await fs.writeFile(environment, original);
        f.remote.changed = { phase: 'done' };
        assert.equal((await resume()).error?.code, 'REMOTE_PROTOCOL');
        assert.equal(await exists(environment), original !== null);
        if (original !== null) assert.equal(await fs.readFile(environment, 'utf8'), original);
        await fs.mkdir(path.dirname(f.partial), { recursive: true });
        await fs.writeFile(f.partial, 'already downloaded bytes');
        f.remote.changed = { phase: 'transfer' };
        const failed = await resume();
        assert.equal(failed.error?.code, 'CANCELLED', JSON.stringify(failed));
        assert.deepEqual(await fs.readFile(environment), Buffer.from(binding.environment, 'utf8'));
        assert.deepEqual((await scan(payload, { ignorePartials: true })).files.map(file => file.path), ['environment.json']);
        assert.deepEqual(await fs.readdir(f.root), ['download-resume.json', 'job.json', 'payload']);
        assert.equal((await readJson(path.join(f.root, 'download-resume.json'))).generation, f.generation);
        assert.equal(await fs.readFile(f.partial, 'utf8'), 'already downloaded bytes');
    }
    assert.deepEqual(replacements, [null, '{"scope":']);
    assert.ok(f.beginRequests.slice(1).every(request => request.resumeOnly && request.job === f.id));
    await t.test('a linked scoped metadata path is rejected without touching its target', async subtest => {
        const target = path.join(f.device.root, 'linked-environment');
        await fs.mkdir(target);
        await fs.unlink(environment);
        try { await fs.symlink(target, environment, process.platform === 'win32' ? 'junction' : 'dir'); }
        catch (error) {
            if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
            subtest.skip('directory link creation unavailable');
            return;
        }
        assert.equal((await resume()).error?.code, 'UNSAFE_PATH');
        assert.equal((await fs.lstat(environment)).isSymbolicLink(), true);
        assert.deepEqual(await fs.readdir(target), []);
        assert.equal(replacements.length, 2);
    });
});

test('recoverStopped exposes a download interrupted while reconnecting', async () => {
    const f = await interrupted(['worlds']);
    const statusFile = path.join(f.device.state, 'status.json');
    f.device.origin = 'http://127.0.0.1:0';
    f.remote.beforeConnect = async () => {
        const persisted = await readJson(statusFile);
        assert.equal(persisted.phase, 'DOWNLOADING');
        // Reproduce the persisted state a dead worker leaves during connect.
        await atomicJson(statusFile, persisted);
        throw new SyncError('SSH', 'network remains down');
    };
    const first = new Manager(f.device, null, f.remote);
    await first.action('resume-download', { id: f.id, tab: randomUUID() });
    await first.done;
    const failed = await readJson(statusFile);
    assert.equal(failed.error.code, 'SSH', JSON.stringify(failed));
    await atomicJson(statusFile, { ...failed, phase: failed.failurePhase });
    await recoverStopped(f.device);
    const status = await new Manager(f.device, null, f.remote).status();
    assert.equal(status.error.code, 'INTERRUPTED');
    assert.equal(status.canResumeDownload, true);
});

test('retained download refusal or changed generation, scope, manifest, metadata or publication never stages a new job', async () => {
    const f = await interrupted(['worlds']);
    const alternate = path.join(f.device.root, 'alternate');
    await fs.mkdir(alternate);
    await fs.writeFile(path.join(alternate, 'environment.json'), '{}');
    const manifest = await scan(alternate);
    for (const changed of [
        { generation: randomUUID() }, { base: 'c'.repeat(64) }, { scope: ['chats'] }, { manifest },
        { environment: '{}' }, { publicationDigest: 'c'.repeat(64) }, null,
    ]) {
        f.remote.changed = changed;
        f.remote.refusal = changed ? null : new SyncError('REMOTE', 'NO_JOB: missing retained task');
        const manager = new Manager(f.device, null, f.remote);
        await manager.action('resume-download', { id: f.id, tab: randomUUID() });
        await manager.done;
        const status = await manager.status();
        assert.equal(status.phase, 'FAILED');
        assert.equal(status.error.code, changed ? 'DOWNLOAD_BINDING' : 'REMOTE');
        assert.equal(await fs.readFile(f.partial, 'utf8'), 'incomplete bytes');
    }
    assert.deepEqual(await fs.readdir(path.join(f.device.state, 'jobs')), [f.id]);
    assert.ok(f.beginRequests.slice(1).every(request => request.resumeOnly && request.job === f.id));
});

test('changed local connection or scope, missing binding, and preparing/apply work suppress download recovery', async () => {
    const f = await interrupted(['worlds']), manager = new Manager(f.device, null, f.remote);
    const statusFile = path.join(f.device.state, 'status.json');
    const mutations = [
        [() => { f.device.remote.host = '100.64.0.2'; }, () => { delete f.device.remote.host; }],
        [() => atomicJson(statusFile, { ...f.failed, scope: ['chats'] }), () => atomicJson(statusFile, f.failed)],
        [() => atomicJson(statusFile, { ...f.failed, failurePhase: 'PREPARING' }), () => atomicJson(statusFile, f.failed)],
        [() => fs.mkdir(path.join(f.root, 'candidate')), () => fs.rmdir(path.join(f.root, 'candidate'))],
        [() => atomicJson(path.join(f.device.state, 'apply.json'), { jobRoot: f.root, phase: 'applying' }), () => fs.unlink(path.join(f.device.state, 'apply.json'))],
        [() => fs.unlink(path.join(f.root, 'download-resume.json')), async () => {}],
    ];
    for (const [modify, restore] of mutations) {
        await modify();
        assert.equal((await manager.status()).canResumeDownload, false);
        await assert.rejects(manager.action('resume-download', { id: f.id, tab: randomUUID() }), { code: 'DOWNLOAD_BINDING' });
        await restore();
    }
    for (const property of ['pending', 'resume']) {
        await assert.rejects(manager.action('start', { direction: 'pull', tab: randomUUID(), [property]: f.failed }), { code: 'INPUT' });
    }
    assert.equal(f.beginRequests.length, 1, 'local refusal must occur before VPS begin');
});
