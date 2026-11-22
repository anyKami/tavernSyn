import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { packDriveArchive, unpackDriveArchive } from '../lib/drive-archive.mjs';
import { scan, verify, hashFile } from '../lib/manifest.mjs';
import { exists } from '../lib/io.mjs';

async function fixture(t) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'drive-archive-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'); await fs.mkdir(source);
    await fs.writeFile(path.join(source, '秘密配置.json'), JSON.stringify({ token: 'SYNTHETIC_DO_NOT_DISCLOSE', text: '测试'.repeat(10000) }));
    await fs.writeFile(path.join(source, 'large.bin'), randomBytes(2 * 1024 * 1024 + 71));
    const key = randomBytes(32), manifest = await scan(source), binding = { rootId: 'fixture_root_123456', generation: randomUUID(), digest: manifest.digest };
    const file = path.join(root, 'archive.bin'), packed = await packDriveArchive(source, manifest, file, key, binding);
    return { root, source, key, manifest, binding, file, packed };
}
test('compressed encrypted archives round-trip binary and Unicode files with authenticated manifest binding', async t => {
    const f = await fixture(t), target = path.join(f.root, 'target');
    assert.equal(f.packed.sha256, await hashFile(f.file));
    const bytes = await fs.readFile(f.file); assert(!bytes.includes(Buffer.from('SYNTHETIC_DO_NOT_DISCLOSE')));
    let checked = false;
    const result = await unpackDriveArchive(f.file, target, f.key, { ...f.binding, archiveSha256: f.packed.sha256 }, { onManifest: async value => {
        checked = true; assert.equal(await exists(target), false); assert.equal(value.digest, f.manifest.digest);
    } });
    assert(checked); assert.equal(result.digest, f.manifest.digest); await verify(target, f.manifest);
});
test('wrong key and cross-repository or cross-generation substitution never yield an accepted snapshot', async t => {
    const f = await fixture(t);
    for (const [i, [key, binding]] of [[randomBytes(32), f.binding], [f.key, { ...f.binding, rootId: 'other_root_123456' }],
        [f.key, { ...f.binding, generation: randomUUID() }]].entries()) {
        await assert.rejects(unpackDriveArchive(f.file, path.join(f.root, `bad-${i}`), key, binding), { code: 'DRIVE_INTEGRITY' });
    }
});
test('ciphertext and authentication tag corruption are rejected before application', async t => {
    const f = await fixture(t), original = await fs.readFile(f.file);
    for (const [i, offset] of [28, original.length - 1].entries()) {
        const corrupt = Buffer.from(original); corrupt[offset] ^= 1; const file = path.join(f.root, `corrupt-${i}.bin`); await fs.writeFile(file, corrupt);
        await assert.rejects(unpackDriveArchive(file, path.join(f.root, `bad-${i}`), f.key, f.binding));
    }
    await assert.rejects(unpackDriveArchive(f.file, path.join(f.root, 'hash-mismatch'), f.key, { ...f.binding, archiveSha256: '0'.repeat(64) }), { code: 'DRIVE_INTEGRITY' });
    assert.equal(await exists(path.join(f.root, 'hash-mismatch')), false);
});
test('encrypted archive packing and extraction cannot overwrite existing files or staging trees', async t => {
    const f = await fixture(t), before = await hashFile(f.file);
    await assert.rejects(packDriveArchive(f.source, f.manifest, f.file, f.key, f.binding), { code: 'EEXIST' });
    assert.equal(await hashFile(f.file), before);
    await assert.rejects(unpackDriveArchive(f.file, f.source, f.key, f.binding), { code: 'USB_PAYLOAD_EXISTS' });
    await verify(f.source, f.manifest);
});
