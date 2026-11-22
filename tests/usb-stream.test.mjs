import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { encodeUsb, receiveUsb, USB_MAX_MANIFEST_BYTES } from '../lib/usb-stream.mjs';
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
function packet(manifest, content = Buffer.alloc(0)) {
    const json = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(12);
    header.write('TSUSB001'); header.writeUInt32BE(json.length, 8);
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
