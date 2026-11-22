import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DriveApi } from '../lib/drive-api.mjs';
import { exists } from '../lib/io.mjs';
import { driveFixture, MemoryDrive } from './drive-fixtures.mjs';

test('Drive API creates typed objects and streams a hash-verified chunked upload/download', async t => {
    const { api, drive, dir, content, archiveFile, archiveSha256, dataset } = await driveFixture(t);
    const parentId = await api.createFolder('TavernSyn'), [rootId, fileId] = await api.generateIds(2);
    await api.createJson(rootId, { hello: '世界' }, { parentId, kind: 'root', repositoryId: dataset });
    assert.deepEqual(await api.getJson(rootId), { hello: '世界' });
    assert.equal((await api.list({ parentId, kind: 'root', repositoryId: dataset }))[0].id, rootId);
    const progress = [];
    const uploaded = await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile, onProgress: value => progress.push(value) });
    assert.equal(uploaded.sha256, archiveSha256); assert.equal(uploaded.size, content.length);
    assert.deepEqual(progress.at(-1), { bytes: content.length, totalBytes: content.length });
    const puts = drive.requests.filter(request => request.method === 'PUT' && request.body.length);
    assert.equal(puts.length, 3); assert(puts.every(request => request.body.length <= 256 * 1024));
    const target = path.join(dir, 'download.tsenc'), downloaded = await api.downloadFile(fileId, target);
    assert.equal(downloaded.sha256, archiveSha256); assert.deepEqual(await fs.readFile(target), content);
    await api.deleteFile(fileId); await api.deleteFile(fileId);
    await assert.rejects(api.metadata(fileId), { status: 404 });
});

test('Drive API preserves same-ID create conflict and never overwrites the existing JSON', async t => {
    const { api, dataset } = await driveFixture(t), parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.createJson(fileId, { original: true }, { parentId, kind: 'commit', repositoryId: dataset });
    await assert.rejects(api.createJson(fileId, { replaced: true }, { parentId, kind: 'commit', repositoryId: dataset }), { status: 409 });
    assert.deepEqual(await api.getJson(fileId), { original: true });
});

test('Drive API refreshes exactly once after a 401 and never exposes the server token text', async () => {
    const flags = [], secrets = 'top-secret-token'; let requests = 0;
    const api = new DriveApi({ accessToken: async options => { flags.push(options.force); return secrets; },
        fetchImpl: async (_url, options) => {
            assert.equal(options.redirect, 'manual'); assert.equal(options.headers.authorization, `Bearer ${secrets}`); requests++;
            return new Response(JSON.stringify({ error: { message: secrets } }), { status: 401 });
        } });
    await assert.rejects(api.metadata('drive_file_1'), error => error.status === 401 && !JSON.stringify(error).includes(secrets));
    assert.equal(requests, 2); assert.deepEqual(flags, [false, true]);
});

test('Drive API retries bounded rate-limited reads and keeps nonretryable status intact', async () => {
    let calls = 0;
    const api = new DriveApi({ accessToken: async () => 'token', retryBaseMs: 0, attempts: 3,
        fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: {} }), { status: 429 }); } });
    await assert.rejects(api.metadata('drive_file_1'), { status: 429 }); assert.equal(calls, 3);
    const forbidden = new DriveApi({ accessToken: async () => 'token', retryBaseMs: 0,
        fetchImpl: async () => { calls++; return new Response('{}', { status: 403 }); } });
    await assert.rejects(forbidden.metadata('drive_file_1'), { status: 403 }); assert.equal(calls, 4);
});

test('Drive upload queries server progress after a partially accepted request loses its response', async t => {
    const { api, drive, archiveFile, archiveSha256, dataset } = await driveFixture(t);
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    let interrupted = false;
    drive.before = request => {
        if (!interrupted && request.method === 'PUT' && request.body.length) {
            interrupted = true;
            drive.sessions.get(request.url.searchParams.get('upload_id')).bytes = Buffer.from(request.body.subarray(0, 131072));
            throw new Error('connection lost');
        }
    };
    const result = await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    assert.equal(result.sha256, archiveSha256);
    assert(drive.requests.some(request => request.headers['content-range']?.startsWith('bytes */')));
    assert(drive.requests.some(request => request.headers['content-range']?.startsWith('bytes 131072-')));
});

test('Drive upload recognizes a final commit whose response was lost', async t => {
    const { api, drive, archiveFile, dataset } = await driveFixture(t, Buffer.from('one chunk'));
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    drive.afterUpload = () => { drive.afterUpload = null; throw new Error('lost final reply'); };
    const result = await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    assert.equal(result.id, fileId); assert(drive.files.has(fileId));
});

test('Drive upload restarts an expired session with the same predetermined file ID', async t => {
    const { api, drive, archiveFile, dataset } = await driveFixture(t);
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    let expired = false;
    drive.before = request => {
        if (!expired && request.method === 'PUT') { expired = true; drive.sessions.delete(request.url.searchParams.get('upload_id')); }
    };
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    assert.equal(drive.requests.filter(request => request.method === 'POST' && request.url.searchParams.get('uploadType') === 'resumable').length, 2);
    assert.equal([...drive.files.values()].filter(file => file.metadata.appProperties?.kind === 'payload').length, 1);
});

test('Drive upload refuses a session redirect to another host before sending any bytes', async t => {
    const { api, drive, archiveFile, dataset } = await driveFixture(t), parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    drive.before = request => request.method === 'POST' && request.url.searchParams.get('uploadType') === 'resumable'
        ? new Response(null, { status: 200, headers: { location: 'https://attacker.invalid/upload?upload_id=secret' } }) : undefined;
    await assert.rejects(api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile }), { code: 'DRIVE_SESSION' });
    assert(!drive.requests.some(request => request.url.hostname === 'attacker.invalid' || request.method === 'PUT'));
});

test('Drive upload refuses impossible server offsets and changed remote checksums', async t => {
    const { api, drive, archiveFile, dataset } = await driveFixture(t), parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    drive.before = request => request.method === 'PUT' ? new Response(null, { status: 308, headers: { range: 'bytes=0-999999999' } }) : undefined;
    await assert.rejects(api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile }), { code: 'DRIVE_RANGE' });
    drive.before = null; drive.afterUpload = session => { drive.files.get(session.metadata.id).metadata.sha256Checksum = '0'.repeat(64); };
    await assert.rejects(api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile }), { code: 'INTEGRITY' });
});

test('Drive download detects truncation, removes only its partial file, and preserves existing files', async t => {
    const { api, drive, dir, archiveFile, dataset } = await driveFixture(t), parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    drive.before = request => request.url.searchParams.get('alt') === 'media' ? new Response(Buffer.from('truncated')) : undefined;
    const target = path.join(dir, 'partial');
    await assert.rejects(api.downloadFile(fileId, target), { code: 'INTEGRITY' }); assert.equal(await exists(target), false);
    await fs.writeFile(target, 'existing');
    await assert.rejects(api.downloadFile(fileId, target), { code: 'EEXIST' }); assert.equal(await fs.readFile(target, 'utf8'), 'existing');
});

test('Drive list rejects an incomplete search and rejects unsafe file identifiers locally', async () => {
    const drive = new MemoryDrive();
    drive.before = () => new Response(JSON.stringify({ files: [], incompleteSearch: true }));
    await assert.rejects(drive.api.list({ parentId: 'drive_folder_1', kind: 'payload', repositoryId: '11111111-1111-4111-8111-111111111111' }), { code: 'DRIVE_RESPONSE' });
    const before = drive.requests.length;
    await assert.rejects(drive.api.metadata('../bad/path'), { code: 'DRIVE_ID' }); assert.equal(drive.requests.length, before);
});

test('Drive adapter will not send credentials to a caller-supplied external endpoint', async () => {
    let called = false;
    const api = new DriveApi({ accessToken: async () => { called = true; return 'private'; }, fetchImpl: async () => { called = true; } });
    await assert.rejects(api.request('https://attacker.invalid/drive/v3/files'), { code: 'DRIVE_ENDPOINT' });
    await assert.rejects(api.request('https://www.googleapis.com.evil.invalid/drive/v3/files'), { code: 'DRIVE_ENDPOINT' });
    assert.equal(called, false);
});

test('Drive download uses an inactivity timeout so healthy slow streams may exceed the request deadline', async t => {
    const { api, drive, dir, archiveFile, dataset, content } = await driveFixture(t, Buffer.from('01234567'));
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    let index = 0, cancelled = false;
    drive.before = request => request.url.searchParams.get('alt') === 'media' ? new Response(new ReadableStream({
        async pull(controller) {
            await delay(40);
            if (cancelled) return;
            if (index === content.length) controller.close();
            else controller.enqueue(content.subarray(index, ++index));
        }, cancel() { cancelled = true; },
    })) : undefined;
    const slow = new DriveApi({ accessToken: async () => 'token', fetchImpl: drive.fetch.bind(drive), timeoutMs: 200, retryBaseMs: 0 });
    const target = path.join(dir, 'slow.tsenc'), started = Date.now();
    const result = await slow.downloadFile(fileId, target);
    assert(Date.now() - started > 200); assert.equal(result.bytes, content.length);
    assert.deepEqual(await fs.readFile(target), content);
});

test('Drive download aborts a stalled body and removes its partial file', async t => {
    const { api, drive, dir, archiveFile, dataset } = await driveFixture(t, Buffer.from('some archive'));
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    let cancelled = false;
    drive.before = request => request.url.searchParams.get('alt') === 'media' ? new Response(new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from('some')); },
        pull() { return new Promise(() => {}); }, cancel() { cancelled = true; },
    })) : undefined;
    const stalled = new DriveApi({ accessToken: async () => 'token', fetchImpl: drive.fetch.bind(drive), timeoutMs: 50, retryBaseMs: 0 });
    const target = path.join(dir, 'stalled.tsenc');
    await assert.rejects(stalled.downloadFile(fileId, target), { code: 'DRIVE_NETWORK' });
    assert.equal(cancelled, true); assert.equal(await exists(target), false);
});

test('Drive download still bounds credential lookup before the response headers arrive', async t => {
    const { api, drive, dir, archiveFile, dataset } = await driveFixture(t, Buffer.from('some archive'));
    const parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    let calls = 0;
    const stalled = new DriveApi({ accessToken: async () => ++calls === 1 ? 'token' : new Promise(() => {}),
        fetchImpl: drive.fetch.bind(drive), timeoutMs: 50, retryBaseMs: 0 });
    const target = path.join(dir, 'no-token.tsenc');
    await assert.rejects(stalled.downloadFile(fileId, target), { code: 'DRIVE_NETWORK' });
    assert.equal(calls, 2); assert.equal(await exists(target), false);
});

test('Drive cleanup can inspect owned trash explicitly and permanently deletes only the selected file', async t => {
    const { api, drive, archiveFile, dataset } = await driveFixture(t), parentId = await api.createFolder('TavernSyn'), [fileId] = await api.generateIds(1);
    await api.uploadFile({ id: fileId, parentId, repositoryId: dataset, file: archiveFile });
    drive.files.get(fileId).metadata.trashed = true;
    await assert.rejects(api.metadata(fileId), { code: 'DRIVE_METADATA' });
    assert.equal((await api.metadata(fileId, { includeTrashed: true })).trashed, true);
    assert.equal((await api.list({ parentId, kind: 'payload', repositoryId: dataset })).length, 0);
    assert.equal((await api.list({ parentId, kind: 'payload', repositoryId: dataset, includeTrashed: true })).length, 1);
    await api.deleteFile(fileId); assert.equal(drive.files.has(fileId), false);
    const deletions = drive.requests.filter(request => request.method === 'DELETE');
    assert.deepEqual(deletions.map(request => request.url.pathname), [`/drive/v3/files/${fileId}`]);
});
