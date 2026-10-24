import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { recoverDownload } from '../bin/recover-download.mjs';
import { Manager } from '../helper/manager.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { atomicJson, digest, exists, readJson } from '../lib/io.mjs';
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

test('legacy verified pull recovers offline, then confirms, applies and restarts once', async () => {
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
    const confirmation = await phase(manager, 'AWAITING_CONFIRMATION');
    await manager.action('confirm', { id: confirmation.id, token: confirmation.confirmationToken });
    await handoff(manager); await manager.done;
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
    assert.equal(await exists(local), false); assert.equal(lifecycle.starts, 1);
    assert.equal((await readJson(path.join(device.state, 'apply.json'))).phase, 'committed');
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
