import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { encodeUsb, receiveUsb, planUsb, USB_MAX_MANIFEST_BYTES } from '../lib/usb-stream.mjs';
import { scan, seal, verify } from '../lib/manifest.mjs';
import { exists } from '../lib/io.mjs';

const temporaryRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
const emptyHash = createHash('sha256').update('').digest('hex');
async function fixture(t) {
    await fs.mkdir(temporaryRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'usb-stream-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    await fs.mkdir(source);
    return { root, source, target };
}
async function collect(iterable) {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return Buffer.concat(chunks);
}
function packet(manifest, content = Buffer.alloc(0), magic = 'TSUSB001') {
    const json = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(12);
    header.write(magic); header.writeUInt32BE(json.length, 8);
    return Buffer.concat([header, json, content]);
}
function file(name, content = Buffer.alloc(0)) {
    return { path: name, size: content.length, mtime: 1730000000, sha256: createHash('sha256').update(content).digest('hex') };
}
async function* fragmented(buffer) {
    const sizes = [1, 2, 3, 17, 65537];
    for (let offset = 0, index = 0; offset < buffer.length; index++) {
        const end = Math.min(buffer.length, offset + sizes[index % sizes.length]);
        yield buffer.subarray(offset, end); offset = end;
    }
}

test('USB stream transfers binary, Unicode, spaces, and empty files with bounded file chunks', async t => {
    const { source, target } = await fixture(t);
    await fs.mkdir(path.join(source, '角色 卡'));
    await fs.writeFile(path.join(source, '角色 卡/图片.png'), randomBytes(3 * 1024 * 1024 + 79));
    await fs.writeFile(path.join(source, '角色 卡/空文件.jsonl'), '');
    await fs.writeFile(path.join(source, 'settings.json'), '{"主题":"夜间"}');
    const manifest = await scan(source);
    const stream = encodeUsb(source, manifest), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert(chunks.slice(2).every(chunk => chunk.length <= 64 * 1024));
    let initialCheck = false, lastProgress;
    const result = await receiveUsb(Readable.from(fragmented(Buffer.concat(chunks))), target, {
        onManifest: async value => {
            assert.equal(await exists(target), false); assert.deepEqual(value, manifest); initialCheck = true;
        },
        onProgress: value => { lastProgress = value; },
    });
    assert.equal(initialCheck, true); assert.deepEqual(result, manifest);
    assert.deepEqual(lastProgress, { bytes: manifest.bytes, files: manifest.files.length });
    await verify(target, manifest);
    for (const entry of manifest.files) {
        const stat = await fs.stat(path.join(target, entry.path));
        assert.equal(Math.floor(stat.mtimeMs / 1000), entry.mtime);
        if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    }
});

test('USB stream supports an empty snapshot', async t => {
    const { source, target } = await fixture(t), manifest = await scan(source);
    assert.deepEqual(await receiveUsb(Readable.from(encodeUsb(source, manifest)), target), manifest);
    assert.deepEqual(await fs.readdir(target), []);
});

test('USB refuses an existing payload without overwriting any of its content', async t => {
    const { source, target } = await fixture(t), manifest = await scan(source);
    await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'original');
    await assert.rejects(receiveUsb(Readable.from(encodeUsb(source, manifest)), target), { code: 'USB_PAYLOAD_EXISTS' });
    assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'original');
});

test('USB rejects truncation in the header, manifest, and file body', async t => {
    const { source, root } = await fixture(t);
    await fs.writeFile(path.join(source, 'content.bin'), randomBytes(4096));
    const wire = await collect(encodeUsb(source, await scan(source)));
    for (const [index, length] of [5, 15, wire.length - 1].entries()) {
        await assert.rejects(receiveUsb(Readable.from([wire.subarray(0, length)]), path.join(root, `short-${index}`)), { code: 'USB_TRUNCATED' });
    }
});

test('USB rejects content corruption and trailing data', async t => {
    const { source, root } = await fixture(t);
    await fs.writeFile(path.join(source, 'content.bin'), randomBytes(4096));
    const wire = await collect(encodeUsb(source, await scan(source)));
    const corrupt = Buffer.from(wire); corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(receiveUsb(Readable.from([corrupt]), path.join(root, 'corrupt')), { code: 'INTEGRITY' });
    await assert.rejects(receiveUsb(Readable.from([wire, Buffer.from('extra')]), path.join(root, 'extra')), { code: 'USB_TRAILING' });
});

test('USB rejects invalid protocol, oversized manifest, invalid JSON, invalid UTF-8 and forged digests before staging', async t => {
    const { root } = await fixture(t), empty = seal([]);
    const magic = packet(empty); magic[0] ^= 1;
    const oversized = Buffer.alloc(12); oversized.write('TSUSB001'); oversized.writeUInt32BE(USB_MAX_MANIFEST_BYTES + 1, 8);
    const malformed = Buffer.alloc(13); malformed.write('TSUSB001'); malformed.writeUInt32BE(1, 8); malformed[12] = 0x7b;
    const utf8 = Buffer.from(malformed); utf8[12] = 0xff;
    const forged = packet({ ...empty, digest: '0'.repeat(64) });
    for (const [index, wire] of [magic, oversized, malformed, utf8, forged].entries()) {
        const target = path.join(root, `invalid-${index}`);
        await assert.rejects(receiveUsb(Readable.from([wire]), target), error => ['USB_PROTOCOL', 'MANIFEST'].includes(error.code));
        assert.equal(await exists(target), false);
    }
});

test('USB rejects path traversal, prefix collisions, Unicode aliases and invalid entries', async t => {
    const { root } = await fixture(t);
    const manifests = [
        seal([file('../escape')]),
        seal([file('/absolute')]),
        seal([file('profile'), file('profile/settings.json')]),
        seal([file('A/x'), file('a/y')]),
        seal([file('caf\u00e9/a'), file('cafe\u0301/b')]),
        seal([file('A/x'), file('a')].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))),
        { format: 1, bytes: 0, digest: '0'.repeat(64), files: [null] },
        seal([{ path: 'huge', size: Number.MAX_SAFE_INTEGER, mtime: 0, sha256: emptyHash }, file('z', Buffer.from('1'))]),
    ];
    for (const [index, manifest] of manifests.entries()) {
        const target = path.join(root, `unsafe-${index}`);
        await assert.rejects(receiveUsb(Readable.from([packet(manifest)]), target), error => ['MANIFEST', 'FILENAME', 'FILENAME_COLLISION'].includes(error.code));
        assert.equal(await exists(target), false);
    }
    assert.equal(await exists(path.join(root, 'escape')), false);
});

test('USB runs the space/preflight callback before creating a target and closes rejected input', async t => {
    const { source, target } = await fixture(t);
    const input = Readable.from(encodeUsb(source, await scan(source)));
    await assert.rejects(receiveUsb(input, target, { onManifest: () => { throw Object.assign(new Error('disk full'), { code: 'SPACE' }); } }), { code: 'SPACE' });
    assert.equal(await exists(target), false);
    assert.equal(input.destroyed, true);
});

test('USB sender detects source mutation after its manifest was created', async t => {
    const { source } = await fixture(t), name = path.join(source, 'data');
    await fs.writeFile(name, 'abcd'); const manifest = await scan(source);
    await fs.writeFile(name, 'efgh');
    await assert.rejects(collect(encodeUsb(source, manifest)), { code: 'SOURCE_CHANGED' });
    await fs.writeFile(name, 'changed length');
    await assert.rejects(collect(encodeUsb(source, manifest)), { code: 'SOURCE_CHANGED' });
});

test('USB refuses symlink sources and linked target ancestors', { skip: process.platform === 'win32' }, async t => {
    const { source, root } = await fixture(t);
    const data = Buffer.from('private'); await fs.writeFile(path.join(root, 'private'), data);
    await fs.symlink(path.join(root, 'private'), path.join(source, 'link'));
    await assert.rejects(collect(encodeUsb(source, seal([file('link', data)]))), { code: 'UNSAFE_PATH' });
    await fs.symlink(source, path.join(root, 'linked-root'));
    await assert.rejects(receiveUsb(Readable.from([packet(seal([]))]), path.join(root, 'linked-root/target')), { code: 'UNSAFE_PATH' });
    assert.equal(await exists(path.join(source, 'target')), false);
});

test('USB progress callback failure closes the stream and preserves isolated staging only', async t => {
    const { source, target } = await fixture(t);
    await fs.writeFile(path.join(source, 'data'), randomBytes(1024));
    const input = Readable.from(encodeUsb(source, await scan(source)));
    await assert.rejects(receiveUsb(input, target, { onProgress: () => { throw Object.assign(new Error('stopped'), { code: 'CANCELLED' }); } }), { code: 'CANCELLED' });
    assert.equal(input.destroyed, true);
    assert.equal(await exists(target), true);
    // The failed file's descriptor has been closed, including on Windows.
    await fs.rename(path.join(target, 'data'), path.join(target, 'closed'));
});

test('USB delta transfers changed bytes and new files, reuses matching content despite mtime differences, and omits deletions', async t => {
    const { source, target, root } = await fixture(t), basisPath = path.join(root, 'basis');
    await fs.mkdir(basisPath);
    const unchanged = randomBytes(3 * 1024 * 1024 + 17);
    for (const directory of [source, basisPath]) {
        await fs.writeFile(path.join(directory, 'unchanged.bin'), unchanged);
        await fs.writeFile(path.join(directory, 'same-size.txt'), directory === source ? 'new!' : 'old!');
        await fs.utimes(path.join(directory, 'same-size.txt'), 1700000000, 1700000000);
    }
    await fs.utimes(path.join(source, 'unchanged.bin'), 1700000020, 1700000020);
    await fs.utimes(path.join(basisPath, 'unchanged.bin'), 1700000000, 1700000000);
    await fs.writeFile(path.join(source, '新增 空.jsonl'), '');
    await fs.writeFile(path.join(source, 'new.txt'), 'new file');
    await fs.writeFile(path.join(basisPath, 'deleted.txt'), 'target-only');
    const manifest = await scan(source), basisManifest = await scan(basisPath), expected = planUsb(manifest, basisManifest);
    assert.equal(expected.mode, 'incremental'); assert.equal(expected.bytes, 12); assert.equal(expected.files, 3);
    assert.equal(expected.reusedBytes, unchanged.length); assert.equal(expected.reusedFiles, 1);
    assert.equal(expected.totalBytes, manifest.bytes); assert.equal(expected.totalFiles, manifest.files.length);
    assert.equal(planUsb(manifest).mode, 'full'); assert.equal(planUsb(manifest).bytes, manifest.bytes);
    let sent, received, preflight = false;
    const wire = await collect(encodeUsb(source, manifest, { basisManifest, onProgress: value => { sent = value; } }));
    assert.equal(wire.subarray(0, 8).toString(), 'TSUSB002');
    assert.equal(wire.length - 12 - wire.readUInt32BE(8), expected.bytes);
    const result = await receiveUsb(Readable.from(fragmented(wire)), target, {
        basis: { payload: basisPath, manifest: basisManifest },
        onManifest: async (value, plan) => {
            assert.equal(await exists(target), false); assert.deepEqual(value, manifest); assert.deepEqual(plan, expected); preflight = true;
        },
        onProgress: value => {
            assert(value.bytes >= (received?.bytes ?? 0)); assert(value.files >= (received?.files ?? 0));
            assert(value.bytes <= expected.bytes); assert(value.files <= expected.files); received = value;
        },
    });
    assert.equal(preflight, true); assert.deepEqual(result, manifest);
    assert.deepEqual(sent, { bytes: 12, files: 3 }); assert.deepEqual(received, sent);
    await verify(target, manifest);
    assert.equal(await exists(path.join(target, 'deleted.txt')), false);
    assert.equal(await exists(path.join(basisPath, 'unchanged.bin')), false);
    assert.equal(await fs.readFile(path.join(basisPath, 'deleted.txt'), 'utf8'), 'target-only');
    assert.equal(Math.floor((await fs.stat(path.join(target, 'unchanged.bin'))).mtimeMs / 1000), 1700000020);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(target, 'unchanged.bin'))).mode & 0o777, 0o600);
});

test('USB delta supports zero transferred bytes, deleted files, and a fully empty final snapshot', async t => {
    const { source, root, target } = await fixture(t), basisPath = path.join(root, 'basis');
    await fs.mkdir(basisPath);
    for (const directory of [source, basisPath]) {
        await fs.writeFile(path.join(directory, 'shared.txt'), 'identical');
        await fs.writeFile(path.join(directory, 'empty.txt'), '');
    }
    await fs.writeFile(path.join(basisPath, 'delete.txt'), 'removed by source');
    const manifest = await scan(source), basisManifest = await scan(basisPath);
    let sent, received;
    const wire = await collect(encodeUsb(source, manifest, { basisManifest, onProgress: value => { sent = value; } }));
    assert.equal(wire.length, 12 + wire.readUInt32BE(8)); assert.deepEqual(sent, { bytes: 0, files: 0 });
    await receiveUsb(Readable.from([wire]), target, { basis: { payload: basisPath, manifest: basisManifest }, onProgress: value => { received = value; } });
    assert.deepEqual(received, { bytes: 0, files: 0 }); await verify(target, manifest);
    assert.equal(await exists(path.join(target, 'delete.txt')), false);
    const empty = seal([]), emptyTarget = path.join(root, 'empty-target');
    await receiveUsb(Readable.from(encodeUsb(source, empty, { basisManifest: manifest })), emptyTarget,
        { basis: { payload: target, manifest }, onProgress: value => { received = value; } });
    assert.deepEqual(await fs.readdir(emptyTarget), []); assert.deepEqual(received, { bytes: 0, files: 0 });
    assert.equal(await fs.readFile(path.join(target, 'shared.txt'), 'utf8'), 'identical');
});

test('USB delta recreates file-to-directory and directory-to-file changes without carrying target-only paths', async t => {
    const { source, target, root } = await fixture(t), basisPath = path.join(root, 'basis');
    await fs.mkdir(basisPath); await fs.mkdir(path.join(basisPath, 'directory'));
    await fs.mkdir(path.join(source, 'file'));
    await fs.writeFile(path.join(basisPath, 'directory/old'), 'old child');
    await fs.writeFile(path.join(basisPath, 'file'), 'old file');
    await fs.writeFile(path.join(source, 'directory'), 'new file');
    await fs.writeFile(path.join(source, 'file/new'), 'new child');
    const manifest = await scan(source), basisManifest = await scan(basisPath);
    assert.equal(planUsb(manifest, basisManifest).reusedFiles, 0);
    await receiveUsb(Readable.from(encodeUsb(source, manifest, { basisManifest })), target, { basis: { payload: basisPath, manifest: basisManifest } });
    await verify(target, manifest);
    assert.equal(await fs.readFile(path.join(target, 'directory'), 'utf8'), 'new file');
    assert.equal(await fs.readFile(path.join(target, 'file/new'), 'utf8'), 'new child');
    assert.equal(await fs.readFile(path.join(basisPath, 'file'), 'utf8'), 'old file');
});

test('USB delta rejects corrupted, resized, missing or replaced basis files, including same-size same-mtime corruption', async t => {
    const { source, root } = await fixture(t); await fs.writeFile(path.join(source, 'data'), 'abcd');
    const manifest = await scan(source);
    for (const [index, change] of ['content', 'size', 'missing', 'directory'].entries()) {
        const basisPath = path.join(root, `basis-${index}`), target = path.join(root, `target-${index}`);
        await fs.mkdir(basisPath); await fs.writeFile(path.join(basisPath, 'data'), 'abcd');
        const basisManifest = await scan(basisPath), stat = await fs.stat(path.join(basisPath, 'data'));
        if (change === 'content' || change === 'size') {
            await fs.writeFile(path.join(basisPath, 'data'), change === 'content' ? 'efgh' : 'longer');
            await fs.utimes(path.join(basisPath, 'data'), stat.atime, stat.mtime);
        } else {
            await fs.unlink(path.join(basisPath, 'data'));
            if (change === 'directory') await fs.mkdir(path.join(basisPath, 'data'));
        }
        const input = Readable.from(encodeUsb(source, manifest, { basisManifest }));
        await assert.rejects(receiveUsb(input, target, { basis: { payload: basisPath, manifest: basisManifest } }), { code: 'USB_BASIS_CHANGED' });
        assert.equal(input.destroyed, true);
        assert.equal(await fs.readFile(path.join(source, 'data'), 'utf8'), 'abcd');
    }
});

test('USB delta validates its envelope, both manifests and basis identity before creating a target', async t => {
    const { source, root } = await fixture(t), basisPath = path.join(root, 'basis'); await fs.mkdir(basisPath);
    const manifest = await scan(source), basisManifest = await scan(basisPath), basis = { payload: basisPath, manifest: basisManifest };
    const envelope = { manifest, basisDigest: basisManifest.digest };
    const cases = [
        [null, basis, 'MANIFEST'], [[], basis, 'MANIFEST'], [{ manifest }, basis, 'MANIFEST'],
        [{ basisDigest: basisManifest.digest }, basis, 'MANIFEST'], [{ ...envelope, extra: true }, basis, 'MANIFEST'],
        [{ ...envelope, basisDigest: 'bad' }, basis, 'MANIFEST'],
        [{ ...envelope, manifest: { ...manifest, digest: '0'.repeat(64) } }, basis, 'MANIFEST'],
        [envelope, null, 'USB_BASIS'], [{ ...envelope, basisDigest: '0'.repeat(64) }, basis, 'USB_BASIS'],
        [envelope, { ...basis, manifest: { ...basisManifest, digest: '0'.repeat(64) } }, 'MANIFEST'],
        [envelope, { ...basis, payload: path.join(root, 'missing') }, 'USB_BASIS'],
    ];
    for (const [index, [value, candidate, code]] of cases.entries()) {
        const target = path.join(root, `invalid-${index}`);
        await assert.rejects(receiveUsb(Readable.from([packet(value, Buffer.alloc(0), 'TSUSB002')]), target, { basis: candidate }), { code });
        assert.equal(await exists(target), false);
    }
    const nested = path.join(basisPath, 'nested');
    await assert.rejects(receiveUsb(Readable.from([packet(envelope, Buffer.alloc(0), 'TSUSB002')]), nested, { basis }), { code: 'USB_BASIS' });
    assert.equal(await exists(nested), false);
    assert.throws(() => planUsb(manifest, seal([file('a'), file('a/b')])), { code: 'FILENAME_COLLISION' });
});

test('USB delta rejects truncated, corrupt and trailing changed-file bytes', async t => {
    const { source, root } = await fixture(t), basisPath = path.join(root, 'basis'); await fs.mkdir(basisPath);
    await fs.writeFile(path.join(source, 'data'), randomBytes(4096));
    const manifest = await scan(source), basisManifest = await scan(basisPath);
    const wire = await collect(encodeUsb(source, manifest, { basisManifest })), corrupt = Buffer.from(wire); corrupt[corrupt.length - 1] ^= 1;
    const cases = [[wire.subarray(0, -1), 'USB_TRUNCATED'], [corrupt, 'INTEGRITY'], [Buffer.concat([wire, Buffer.from('extra')]), 'USB_TRAILING']];
    for (const [index, [value, code]] of cases.entries()) {
        let transferred = false;
        await assert.rejects(receiveUsb(Readable.from(fragmented(value)), path.join(root, `target-${index}`),
            { basis: { payload: basisPath, manifest: basisManifest }, onTransferred: () => { transferred = true; } }), { code });
        assert.equal(transferred, false);
    }
});

test('USB delta acknowledges a fully verified wire stream before hashing and moving local reuse files', async t => {
    const { source, target, root } = await fixture(t), basisPath = path.join(root, 'basis'); await fs.mkdir(basisPath);
    for (const directory of [source, basisPath]) await fs.writeFile(path.join(directory, 'a-reused'), 'same');
    await fs.writeFile(path.join(source, 'z-changed'), 'new file');
    const manifest = await scan(source), basisManifest = await scan(basisPath);
    const wire = await collect(encodeUsb(source, manifest, { basisManifest }));
    let ended = false, transferred = false;
    async function* stream() { yield* fragmented(wire); ended = true; }
    await receiveUsb(stream(), target, { basis: { payload: basisPath, manifest: basisManifest },
        onTransferred: async (value, plan) => {
            assert.equal(ended, true); assert.deepEqual(value, manifest); assert.equal(plan.reusedFiles, 1);
            assert.equal(await fs.readFile(path.join(target, 'z-changed'), 'utf8'), 'new file');
            assert.equal(await exists(path.join(target, 'a-reused')), false);
            assert.equal(await fs.readFile(path.join(basisPath, 'a-reused'), 'utf8'), 'same');
            transferred = true;
        },
    });
    assert.equal(transferred, true); assert.equal(await exists(path.join(basisPath, 'a-reused')), false);
    await verify(target, manifest);
});

test('USB full streams still transfer everything when a basis option is present', async t => {
    const { source, target, root } = await fixture(t), basisPath = path.join(root, 'basis');
    await fs.mkdir(basisPath); await fs.writeFile(path.join(source, 'data'), 'identical'); await fs.writeFile(path.join(basisPath, 'data'), 'identical');
    const manifest = await scan(source), basisManifest = await scan(basisPath); let planned, received;
    await receiveUsb(Readable.from(encodeUsb(source, manifest)), target, { basis: { payload: basisPath, manifest: basisManifest },
        onManifest: (_value, plan) => { planned = plan; }, onProgress: value => { received = value; } });
    assert.equal(planned.mode, 'full'); assert.equal(planned.reusedFiles, 0); assert.equal(planned.bytes, manifest.bytes);
    assert.deepEqual(received, { bytes: manifest.bytes, files: manifest.files.length });
    assert.equal(await fs.readFile(path.join(basisPath, 'data'), 'utf8'), 'identical'); await verify(target, manifest);
});

test('USB delta rejects symlinked and hard-linked reuse sources without touching their external files', { skip: process.platform === 'win32' }, async t => {
    const { source, root } = await fixture(t); await fs.writeFile(path.join(source, 'data'), 'identical');
    const manifest = await scan(source), external = path.join(root, 'external'); await fs.writeFile(external, 'identical');
    for (const link of ['symlink', 'hardlink']) {
        const basisPath = path.join(root, link), target = path.join(root, `${link}-target`); await fs.mkdir(basisPath);
        await fs.writeFile(path.join(basisPath, 'data'), 'identical'); const basisManifest = await scan(basisPath);
        await fs.unlink(path.join(basisPath, 'data'));
        if (link === 'symlink') await fs.symlink(external, path.join(basisPath, 'data'));
        else await fs.link(external, path.join(basisPath, 'data'));
        const before = await fs.stat(external);
        await assert.rejects(receiveUsb(Readable.from(encodeUsb(source, manifest, { basisManifest })), target,
            { basis: { payload: basisPath, manifest: basisManifest } }), { code: link === 'symlink' ? 'UNSAFE_PATH' : 'USB_BASIS_CHANGED' });
        assert.equal(await fs.readFile(external, 'utf8'), 'identical'); assert.equal((await fs.stat(external)).mtimeMs, before.mtimeMs);
    }
});
