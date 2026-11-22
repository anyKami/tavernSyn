import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable, Transform, compose } from 'node:stream';
import { pipeline, finished } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { encodeUsb, receiveUsb } from './usb-stream.mjs';
import { canonical, noLinks, requireThat, SyncError } from './io.mjs';
import { hashFile } from './manifest.mjs';

const MAGIC = Buffer.from('TSDRV001'), HEADER_BYTES = 20, TAG_BYTES = 16;
function context(key, { rootId, generation, digest }) {
    requireThat(Buffer.isBuffer(key) && key.length === 32 && /^[A-Za-z0-9_-]{10,200}$/.test(rootId ?? '')
        && /^[a-f0-9-]{36}$/.test(generation ?? '') && /^[a-f0-9]{64}$/.test(digest ?? ''),
    'DRIVE_ARCHIVE', '加密快照的仓库、代次或密钥无效。');
    return Buffer.from(canonical({ format: 'tavernsyn-drive-archive-v1', rootId, generation, digest }));
}
export async function packDriveArchive(payload, manifest, file, key, binding) {
    const aad = context(key, { ...binding, digest: manifest.digest }), nonce = randomBytes(12);
    await noLinks(file);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const encrypted = compose(Readable.from(encodeUsb(payload, manifest)), createGzip({ level: 6 }), cipher);
    const drained = finished(encrypted).catch(() => {});
    const hash = createHash('sha256'); let bytes = 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
    async function* archive() {
        yield Buffer.concat([MAGIC, nonce]);
        for await (const chunk of encrypted) yield chunk;
        yield cipher.getAuthTag();
    }
    try {
        await pipeline(Readable.from(archive()), meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
        const handle = await fs.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        return { bytes, sha256: hash.digest('hex') };
    } finally { encrypted.destroy(); await drained; }
}
export async function unpackDriveArchive(file, payload, key, binding, { onManifest, onProgress } = {}) {
    const aad = context(key, binding);
    await noLinks(file);
    const handle = await fs.open(file, 'r'); let size, header, tag;
    try {
        size = (await handle.stat()).size;
        requireThat(size > HEADER_BYTES + TAG_BYTES, 'DRIVE_ARCHIVE', '云盘加密快照不完整。');
        header = Buffer.alloc(HEADER_BYTES); tag = Buffer.alloc(TAG_BYTES);
        requireThat((await handle.read(header, 0, HEADER_BYTES, 0)).bytesRead === HEADER_BYTES
            && (await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES)).bytesRead === TAG_BYTES
            && header.subarray(0, 8).equals(MAGIC), 'DRIVE_ARCHIVE', '云盘快照格式无效。');
    } finally { await handle.close(); }
    if (binding.archiveSha256) requireThat(await hashFile(file) === binding.archiveSha256, 'DRIVE_INTEGRITY', '云盘加密快照校验失败，未应用。');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(8)); decipher.setAAD(aad); decipher.setAuthTag(tag);
    const clear = compose(createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }), decipher, createGunzip());
    const drained = finished(clear).catch(() => {});
    try {
        const result = await receiveUsb(clear, payload, { onManifest: async manifest => {
            requireThat(manifest.digest === binding.digest, 'DRIVE_INTEGRITY', '云盘清单与已发布提交不一致。');
            await onManifest?.(manifest);
        }, onProgress });
        return result;
    } catch (error) {
        if (error.code?.startsWith('DRIVE_') || error.code?.startsWith('USB_') || error.code === 'DISK_SPACE') throw error;
        throw new SyncError('DRIVE_INTEGRITY', '云盘快照无法解密或校验失败，未应用任何数据。请核对仓库配对信息。');
    } finally { clear.destroy(); await drained; }
}
