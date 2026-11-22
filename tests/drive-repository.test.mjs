import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRepository, DriveRepository } from '../lib/drive-repository.mjs';
import { driveFixture, hash } from './drive-fixtures.mjs';

async function fixture(t) {
    const value = await driveFixture(t, Buffer.from('encrypted fixture archive'));
    const key = randomBytes(32), descriptor = await createRepository(value.api, { key });
    return { ...value, key, descriptor, repository: new DriveRepository(value.api, { ...descriptor, key }) };
}
function publication(value, base = null, extra = {}) {
    return { generation: randomUUID(), manifestDigest: hash('fixture manifest'), archiveFile: value.archiveFile,
        archiveSha256: value.archiveSha256, base, ...extra };
}
function payloads(drive) { return [...drive.files.values()].filter(file => file.metadata.appProperties?.kind === 'payload'); }
function commits(drive) { return [...drive.files.values()].filter(file => file.metadata.appProperties?.kind === 'commit'); }

test('Drive repository creates a signed empty root and discovers configuration using only root ID and key', async t => {
    const value = await fixture(t);
    assert.equal(await value.repository.head(), null);
    const joined = await new DriveRepository(value.api, { rootId: value.descriptor.rootId, key: value.key }).open();
    assert.equal(joined.folderId, value.descriptor.folderId); assert.equal(joined.dataset, value.descriptor.dataset);
    assert.equal(await joined.head(), null);
    const wrongKey = new DriveRepository(value.api, { ...value.descriptor, key: randomBytes(32) });
    await assert.rejects(wrongKey.open(), { code: 'DRIVE_SIGNATURE' });
    assert.equal(payloads(value.drive).length, 0);
});

test('Drive immutable publication retains only the latest payload and preserves all signed commit records', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    assert.equal(first.sequence, 1); assert.equal(first.maintenancePending, false);
    const secondFile = path.join(value.dir, 'second.tsenc'); await fs.writeFile(secondFile, 'new encrypted archive');
    const second = await value.repository.publish(publication(value, first, { archiveFile: secondFile, archiveSha256: hash('new encrypted archive') }));
    assert.equal(second.sequence, 2); assert.equal(payloads(value.drive).length, 1); assert.equal(commits(value.drive).length, 2);
    assert.equal(value.drive.files.has(first.fileId), false); assert.equal(value.drive.files.has(second.fileId), true);
    const joined = new DriveRepository(value.api, { ...value.descriptor, key: value.key });
    assert.equal((await joined.head()).generation, second.generation);
    assert.equal(value.drive.requests.some(request => request.method === 'PATCH'), false);
});

test('Drive concurrent publishers contend for one predetermined slot and cannot overwrite the winner', async t => {
    const value = await fixture(t), other = new DriveRepository(value.api, { ...value.descriptor, key: value.key });
    let count = 0, release; const uploaded = new Promise(resolve => { release = resolve; });
    value.drive.afterUpload = async () => { if (++count === 2) release(); await uploaded; };
    const results = await Promise.allSettled([value.repository.publish(publication(value)), other.publish(publication(value))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const loser = results.find(result => result.status === 'rejected'); assert.equal(loser.reason.code, 'REMOTE_CHANGED');
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.equal(payloads(value.drive).length, 1); assert.equal(commits(value.drive).length, 1);
    assert.equal((await new DriveRepository(value.api, { ...value.descriptor, key: value.key }).head()).generation, winner.generation);
});

test('Drive repository resolves a lost successful commit response by exact readback and is idempotent', async t => {
    const value = await fixture(t), job = publication(value);
    value.drive.afterCreate = metadata => {
        if (metadata.appProperties.kind === 'commit') { value.drive.afterCreate = null; throw new Error('response lost'); }
    };
    const result = await value.repository.publish(job);
    assert.equal(result.generation, job.generation); assert.equal(commits(value.drive).length, 1);
    const uploads = value.drive.requests.filter(request => request.method === 'PUT' && request.body?.length).length;
    const again = await value.repository.publish(job);
    assert.equal(again.generation, result.generation); assert.equal(again.stats.sentBytes, 0);
    assert.equal(value.drive.requests.filter(request => request.method === 'PUT' && request.body?.length).length, uploads);
    await assert.rejects(value.repository.publish({ ...job, manifestDigest: 'f'.repeat(64) }), { code: 'DRIVE_PUBLICATION' });
});

test('Drive upload interruption leaves the previous published snapshot and head untouched', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    value.drive.before = request => {
        if (request.method === 'PUT') throw new Error('connection gone');
    };
    await assert.rejects(value.repository.publish(publication(value, first)), { code: 'DRIVE_NETWORK' });
    assert.equal(value.drive.files.has(first.fileId), true); assert.equal(commits(value.drive).length, 1);
    assert.equal((await value.repository.head()).generation, first.generation);
});

test('Drive refuses a stale expected generation before uploading any replacement', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    const count = value.drive.requests.length;
    await assert.rejects(value.repository.publish(publication(value, null)), { code: 'REMOTE_CHANGED' });
    assert(!value.drive.requests.slice(count).some(request => request.method === 'PUT'));
    assert.equal((await value.repository.head()).generation, first.generation);
});

test('Drive cleanup failure is reported after publication, blocks accumulation, and recovers from a cached head', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    value.drive.before = request => request.method === 'DELETE' ? new Response('{}', { status: 403 }) : undefined;
    const second = await value.repository.publish(publication(value, first));
    assert.equal(second.maintenancePending, true); assert.equal(second.maintenance.length, 1);
    assert.equal(payloads(value.drive).length, 2); assert.equal((await value.repository.head()).generation, second.generation);
    const joined = new DriveRepository(value.api, { ...value.descriptor, key: value.key, anchor: second });
    await assert.rejects(joined.publish(publication(value, second)), { code: 'DRIVE_CLEANUP' });
    assert.equal(payloads(value.drive).length, 2);
    value.drive.before = null;
    const cleaned = await joined.retryCleanup(); assert.equal(cleaned.maintenancePending, false);
    assert.equal(payloads(value.drive).length, 1); assert.equal(value.drive.files.has(second.fileId), true);
    const third = await joined.publish(publication(value, second)); assert.equal(third.sequence, 3);
    assert.equal(payloads(value.drive).length, 1); assert.equal(commits(value.drive).length, 3);
});

test('Drive cleanup never deletes an unreferenced upload or an ancestor moved outside its owned folder', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    const [inflight] = await value.api.generateIds(1);
    await value.api.uploadFile({ id: inflight, parentId: value.descriptor.folderId, repositoryId: value.descriptor.dataset, file: value.archiveFile });
    const originalParents = value.drive.files.get(first.fileId).metadata.parents;
    value.drive.files.get(first.fileId).metadata.parents = ['foreign_folder_123'];
    const second = await value.repository.publish(publication(value, first));
    assert.equal(second.maintenancePending, true); assert(value.drive.files.has(first.fileId)); assert(value.drive.files.has(inflight));
    assert(!value.drive.requests.some(request => request.method === 'DELETE' && request.url.pathname.endsWith(first.fileId)));
    value.drive.files.get(first.fileId).metadata.parents = originalParents;
    await value.repository.retryCleanup(); assert(!value.drive.files.has(first.fileId)); assert(value.drive.files.has(inflight));
});

test('Drive rejects tampered root, tampered commit, and pairing with a different dataset', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    await assert.rejects(new DriveRepository(value.api, { ...value.descriptor, dataset: randomUUID(), key: value.key }).open(), { code: 'DRIVE_REPOSITORY' });
    const original = value.drive.readJson(first.commitId);
    value.drive.writeJson(first.commitId, { ...original, digest: '1'.repeat(64) });
    await assert.rejects(new DriveRepository(value.api, { ...value.descriptor, key: value.key }).head(), { code: 'DRIVE_SIGNATURE' });
    value.drive.writeJson(first.commitId, original);
    const root = value.drive.readJson(value.descriptor.rootId);
    value.drive.writeJson(value.descriptor.rootId, { ...root, firstCommitId: 'different_commit_id' });
    await assert.rejects(new DriveRepository(value.api, { ...value.descriptor, key: value.key }).open(), { code: 'DRIVE_SIGNATURE' });
    assert(value.drive.files.has(first.fileId));
});

test('Drive cached-head discovery verifies the signed anchor and follows only new successor records', async t => {
    const value = await fixture(t); let current = null;
    for (let i = 0; i < 5; i++) current = await value.repository.publish(publication(value, current));
    const before = value.drive.requests.length;
    const joined = new DriveRepository(value.api, { ...value.descriptor, key: value.key, anchor: current });
    assert.equal((await joined.head()).sequence, 5);
    const mediaReads = value.drive.requests.slice(before).filter(request => request.url.searchParams.get('alt') === 'media');
    assert(mediaReads.length <= 5); // root + anchor verification + absent successor, independent of chain length.
    const bad = new DriveRepository(value.api, { ...value.descriptor, key: value.key, anchor: { ...current, digest: '0'.repeat(64) } });
    await assert.rejects(bad.head(), { code: 'DRIVE_ANCHOR' });
});

test('Drive ambiguous publication preserves both payloads instead of deleting possibly committed data', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    let target;
    value.drive.afterCreate = metadata => {
        if (metadata.appProperties.kind === 'commit') {
            target = metadata.id; value.drive.afterCreate = null;
            value.drive.before = request => request.url.pathname.endsWith(target) ? new Response('{}', { status: 503 }) : undefined;
            throw new Error('unknown result');
        }
    };
    await assert.rejects(value.repository.publish(publication(value, first)), { code: 'DRIVE_RESULT_UNKNOWN' });
    assert.equal(payloads(value.drive).length, 2); assert.equal(commits(value.drive).length, 2);
    assert(value.drive.files.has(first.fileId));
    value.drive.before = null;
    const recovered = new DriveRepository(value.api, { ...value.descriptor, key: value.key });
    assert.equal((await recovered.head()).sequence, 2);
    await recovered.retryCleanup(); assert.equal(payloads(value.drive).length, 1);
});

test('Drive cache follows a newly published successor and bounded reads do not report a truncated head', async t => {
    const value = await fixture(t), first = await value.repository.publish(publication(value));
    const second = await value.repository.publish(publication(value, first));
    const cached = new DriveRepository(value.api, { ...value.descriptor, key: value.key, anchor: first });
    assert.equal((await cached.head()).generation, second.generation);
    const limited = new DriveRepository(value.api, { ...value.descriptor, key: value.key, maxCommits: 1 });
    await assert.rejects(limited.head(), { code: 'DRIVE_LIMIT' });
});
