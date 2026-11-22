import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exists, noLinks, requireThat, SyncError } from './io.mjs';
import { validateManifest } from './manifest.mjs';

const MAGIC = Buffer.from('TSUSB001');
const CHUNK_BYTES = 64 * 1024;
export const USB_MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

function usbManifest(value) {
    try { validateManifest(value); }
    catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('MANIFEST', 'USB 文件清单格式无效。');
    }
    requireThat(Number.isSafeInteger(value.bytes) && value.bytes >= 0, 'MANIFEST', 'USB 文件清单总大小无效。');
    // File-only manifests also need directory collision checks: A/x and a/y
    // cannot form a portable tree, and a file must never be another file's parent.
    const names = new Map();
    let bytes = 0;
    for (const file of value.files) {
        bytes += file.size;
        requireThat(Number.isSafeInteger(bytes) && Number.isFinite(new Date(file.mtime * 1000).getTime()), 'MANIFEST', 'USB 文件大小或时间无效。');
        const parts = file.path.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const name = parts.slice(0, i).join('/'), folded = name.normalize('NFC').toLowerCase();
            const kind = i === parts.length ? 'file' : 'directory', previous = names.get(folded);
            requireThat(!previous || (kind === 'directory' && previous.kind === kind && previous.name === name),
                'FILENAME_COLLISION', 'USB 清单存在文件、目录或大小写冲突。');
            names.set(folded, { name, kind });
        }
    }
    return value;
}

/** A bounded header followed by manifest-ordered raw file bytes; no archive paths. */
export async function* encodeUsb(payload, manifest, { onProgress = () => {} } = {}) {
    manifest = usbManifest(manifest);
    await noLinks(payload);
    requireThat((await fs.lstat(payload)).isDirectory(), 'USB_PAYLOAD', 'USB 快照目录无效。');
    const json = Buffer.from(JSON.stringify(manifest), 'utf8');
    requireThat(json.length > 0 && json.length <= USB_MAX_MANIFEST_BYTES, 'MANIFEST', 'USB 文件清单过大。');
    const header = Buffer.alloc(12);
    MAGIC.copy(header); header.writeUInt32BE(json.length, 8);
    yield header; yield json;
    let transferred = 0, files = 0, updated = 0;
    for (const file of manifest.files) {
        const source = path.join(payload, ...file.path.split('/'));
        await noLinks(source);
        const handle = await fs.open(source, 'r');
        try {
            const before = await handle.stat();
            requireThat(before.isFile() && before.size === file.size, 'SOURCE_CHANGED', 'USB 快照文件类型或大小已经改变。');
            const hash = createHash('sha256');
            let remaining = file.size;
            while (remaining) {
                const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
                requireThat(bytesRead > 0, 'SOURCE_CHANGED', '读取 USB 快照时文件提前结束。');
                const chunk = buffer.subarray(0, bytesRead);
                hash.update(chunk); remaining -= bytesRead; yield chunk;
                transferred += bytesRead;
                if (Date.now() - updated >= 125 || transferred === manifest.bytes) {
                    updated = Date.now(); await onProgress({ bytes: transferred, files });
                }
            }
            const after = await handle.stat();
            requireThat(hash.digest('hex') === file.sha256 && after.size === before.size
                && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
            'SOURCE_CHANGED', 'USB 快照内容已经改变，未发送有效的完整快照。');
        } finally { await handle.close(); }
        files++; await onProgress({ bytes: transferred, files });
    }
}

class ByteReader {
    constructor(readable) {
        requireThat(readable && typeof readable[Symbol.asyncIterator] === 'function', 'USB_STREAM', 'USB 输入不是有效的字节流。');
        this.iterator = readable[Symbol.asyncIterator](); this.chunk = null; this.offset = 0; this.done = false;
    }
    async take(limit) {
        while (!this.chunk || this.offset === this.chunk.length) {
            const result = await this.iterator.next();
            if (result.done) { this.done = true; this.chunk = null; return null; }
            requireThat(result.value instanceof Uint8Array, 'USB_STREAM', 'USB 传输只能包含原始字节。');
            this.chunk = Buffer.from(result.value.buffer, result.value.byteOffset, result.value.byteLength); this.offset = 0;
        }
        const next = this.chunk.subarray(this.offset, this.offset + Math.min(limit, this.chunk.length - this.offset));
        this.offset += next.length; return next;
    }
    async exact(length) {
        const result = Buffer.allocUnsafe(length);
        let offset = 0;
        while (offset < length) {
            const chunk = await this.take(length - offset);
            requireThat(chunk, 'USB_TRUNCATED', 'USB 传输提前结束，未收到完整快照。');
            chunk.copy(result, offset); offset += chunk.length;
        }
        return result;
    }
    async close() { if (!this.done) await this.iterator.return?.(); }
}

/** Receive only into a new, private staging directory. Errors never apply data. */
export async function receiveUsb(readable, payload, { onManifest = async () => {}, onProgress = () => {} } = {}) {
    const reader = new ByteReader(readable);
    try {
        await noLinks(payload);
        requireThat(!await exists(payload), 'USB_PAYLOAD_EXISTS', 'USB 暂存目录已经存在，拒绝覆盖。');
        const header = await reader.exact(12);
        requireThat(header.subarray(0, 8).equals(MAGIC), 'USB_PROTOCOL', 'USB 数据格式或协议版本不匹配。');
        const length = header.readUInt32BE(8);
        requireThat(length > 0 && length <= USB_MAX_MANIFEST_BYTES, 'MANIFEST', 'USB 文件清单长度无效或过大。');
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.exact(length))); }
        catch (error) {
            if (error instanceof SyncError) throw error;
            throw new SyncError('MANIFEST', 'USB 文件清单不是有效的 UTF-8 JSON。');
        }
        const manifest = usbManifest(parsed);
        await onManifest(manifest);
        await noLinks(payload);
        await fs.mkdir(path.dirname(payload), { recursive: true, mode: 0o700 });
        await fs.mkdir(payload, { mode: 0o700 }); // Atomic refusal of a concurrently created destination.
        let bytes = 0, files = 0;
        for (const file of manifest.files) {
            const destination = path.join(payload, ...file.path.split('/'));
            await noLinks(destination);
            await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
            const handle = await fs.open(destination, 'wx', 0o600);
            try {
                const hash = createHash('sha256');
                let remaining = file.size;
                while (remaining) {
                    const chunk = await reader.take(Math.min(CHUNK_BYTES, remaining));
                    requireThat(chunk, 'USB_TRUNCATED', 'USB 传输提前结束，未收到完整文件。');
                    let offset = 0;
                    while (offset < chunk.length) {
                        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
                        requireThat(bytesWritten > 0, 'USB_WRITE', 'USB 暂存文件未能完整写入。');
                        offset += bytesWritten;
                    }
                    hash.update(chunk); remaining -= chunk.length; bytes += chunk.length;
                    await onProgress({ bytes, files });
                }
                requireThat(hash.digest('hex') === file.sha256, 'INTEGRITY', 'USB 文件 SHA-256 校验失败，未应用数据。');
                await handle.utimes(file.mtime, file.mtime);
                await handle.sync();
            } finally { await handle.close(); }
            files++; await onProgress({ bytes, files });
        }
        requireThat(await reader.take(1) === null, 'USB_TRAILING', 'USB 快照包含清单以外的数据，未应用。');
        return manifest;
    } finally { await reader.close().catch(() => {}); }
}
