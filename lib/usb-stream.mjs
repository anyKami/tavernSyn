import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exists, inside, noLinks, renamePath, requireThat, SyncError } from './io.mjs';
import { validateManifest } from './manifest.mjs';

const MAGIC = Buffer.from('TSUSB001');
const DELTA_MAGIC = Buffer.from('TSUSB002');
const CHUNK_BYTES = 64 * 1024;
export const USB_MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const USB_DELTA_CAPABILITY = 'file-delta-v1';

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

/** Compare canonical snapshot bytes, not timestamps or device-local JSON hashes. */
export function planUsb(manifest, basisManifest = null) {
    manifest = usbManifest(manifest);
    const basis = new Map(basisManifest === null ? [] : usbManifest(basisManifest).files.map(file => [file.path, file]));
    const transfer = [], reused = [];
    let bytes = 0, reusedBytes = 0;
    for (const file of manifest.files) {
        const previous = basis.get(file.path);
        if (previous && previous.size === file.size && previous.sha256 === file.sha256) {
            reused.push(file); reusedBytes += file.size;
        } else { transfer.push(file); bytes += file.size; }
    }
    return { mode: basisManifest === null ? 'full' : 'incremental', bytes, files: transfer.length, reusedBytes, reusedFiles: reused.length,
        totalBytes: manifest.bytes, totalFiles: manifest.files.length, transfer, reused };
}

/** A bounded header followed by manifest-ordered raw file bytes; no archive paths. */
export async function* encodeUsb(payload, manifest, { basisManifest = null, onProgress = () => {} } = {}) {
    const plan = planUsb(manifest, basisManifest), incremental = basisManifest !== null;
    await noLinks(payload);
    requireThat((await fs.lstat(payload)).isDirectory(), 'USB_PAYLOAD', 'USB 快照目录无效。');
    const json = Buffer.from(JSON.stringify(incremental ? { manifest, basisDigest: basisManifest.digest } : manifest), 'utf8');
    requireThat(json.length > 0 && json.length <= USB_MAX_MANIFEST_BYTES, 'MANIFEST', 'USB 文件清单过大。');
    const header = Buffer.alloc(12);
    (incremental ? DELTA_MAGIC : MAGIC).copy(header); header.writeUInt32BE(json.length, 8);
    yield header; yield json;
    let transferred = 0, files = 0, updated = 0;
    if (incremental) await onProgress({ bytes: 0, files: 0 });
    for (const file of plan.transfer) {
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
                if (Date.now() - updated >= 125 || transferred === plan.bytes) {
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

async function moveBasisFile(basis, payload, file) {
    const source = path.join(basis, ...file.path.split('/'));
    const destination = path.join(payload, ...file.path.split('/'));
    await noLinks(source); await noLinks(destination);
    const original = await fs.lstat(source).catch(error => {
        if (error.code === 'ENOENT') throw new SyncError('USB_BASIS_CHANGED', 'USB 本机复用文件已经消失，未应用数据。');
        throw error;
    });
    requireThat(original.isFile() && original.size === file.size && original.nlink === 1,
        'USB_BASIS_CHANGED', 'USB 本机复用文件类型、大小或链接状态已经改变。');
    const handle = await fs.open(source, 'r').catch(error => {
        if (error.code === 'ENOENT') throw new SyncError('USB_BASIS_CHANGED', 'USB 本机复用文件已经消失，未应用数据。');
        throw error;
    });
    let before;
    try {
        before = await handle.stat();
        requireThat(before.isFile() && before.size === file.size && before.nlink === 1 && before.dev === original.dev && before.ino === original.ino,
            'USB_BASIS_CHANGED', 'USB 本机复用文件类型、大小或链接状态已经改变。');
        let ctimeMs = before.ctimeMs;
        // Windows rejects a read/write open on a read-only file. Clear the
        // attribute through the checked handle while it is still in the snapshot.
        if (process.platform === 'win32' && !(before.mode & 0o200)) {
            await handle.chmod(0o600);
            ctimeMs = (await handle.stat()).ctimeMs;
        }
        const hash = createHash('sha256');
        let remaining = file.size;
        while (remaining) {
            const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, remaining));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            requireThat(bytesRead > 0, 'USB_BASIS_CHANGED', 'USB 本机复用文件读取提前结束。');
            hash.update(buffer.subarray(0, bytesRead)); remaining -= bytesRead;
        }
        const after = await handle.stat();
        requireThat(hash.digest('hex') === file.sha256 && after.size === before.size
            && after.mtimeMs === before.mtimeMs && after.ctimeMs === ctimeMs && after.nlink === 1,
        'USB_BASIS_CHANGED', 'USB 本机复用文件校验失败，未应用数据。');
        before = after;
    } finally { await handle.close(); }
    // The basis is an isolated snapshot, never a live data root. Moving its
    // verified files avoids a second complete temporary copy or hard links.
    await noLinks(source); await noLinks(destination);
    const current = await fs.lstat(source);
    requireThat(current.isFile() && current.dev === before.dev && current.ino === before.ino
        && current.size === before.size && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs && current.nlink === 1,
    'USB_BASIS_CHANGED', 'USB 本机复用文件在核验后发生变化，未应用数据。');
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    requireThat(!await exists(destination), 'USB_PAYLOAD_EXISTS', 'USB 暂存文件已经存在，拒绝覆盖。');
    await renamePath(source, destination);
    const moved = await fs.open(destination, 'r+');
    try {
        const stat = await moved.stat();
        requireThat(stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
            && stat.mtimeMs === before.mtimeMs && stat.nlink === 1,
        'USB_BASIS_CHANGED', 'USB 本机复用文件在移动时发生变化，未应用数据。');
        await moved.chmod(0o600); await moved.utimes(file.mtime, file.mtime); await moved.sync();
    } finally { await moved.close(); }
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
export async function receiveUsb(readable, payload, { basis = null, onManifest = async () => {}, onProgress = () => {},
    onTransferred = async () => {} } = {}) {
    const reader = new ByteReader(readable);
    try {
        await noLinks(payload);
        requireThat(!await exists(payload), 'USB_PAYLOAD_EXISTS', 'USB 暂存目录已经存在，拒绝覆盖。');
        const header = await reader.exact(12);
        const incremental = header.subarray(0, 8).equals(DELTA_MAGIC);
        requireThat(incremental || header.subarray(0, 8).equals(MAGIC), 'USB_PROTOCOL', 'USB 数据格式或协议版本不匹配。');
        const length = header.readUInt32BE(8);
        requireThat(length > 0 && length <= USB_MAX_MANIFEST_BYTES, 'MANIFEST', 'USB 文件清单长度无效或过大。');
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.exact(length))); }
        catch (error) {
            if (error instanceof SyncError) throw error;
            throw new SyncError('MANIFEST', 'USB 文件清单不是有效的 UTF-8 JSON。');
        }
        if (incremental) {
            requireThat(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && Object.keys(parsed).length === 2 && Object.keys(parsed).every(key => ['manifest', 'basisDigest'].includes(key))
                && /^[a-f0-9]{64}$/.test(parsed.basisDigest ?? ''), 'MANIFEST', 'USB 增量清单格式无效。');
            requireThat(basis && typeof basis.payload === 'string' && basis.payload.length > 0 && basis.manifest,
                'USB_BASIS', 'USB 增量同步缺少本机已准备的完整基准。');
            usbManifest(basis.manifest);
            requireThat(parsed.basisDigest === basis.manifest.digest, 'USB_BASIS', 'USB 增量同步基准已改变，请重新同步。');
            requireThat(!inside(basis.payload, payload, true) && !inside(payload, basis.payload, true),
                'USB_BASIS', 'USB 本机基准与接收暂存目录不能相同或相互嵌套。');
            await noLinks(basis.payload);
            const basisStat = await fs.lstat(basis.payload).catch(error => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            requireThat(basisStat?.isDirectory(), 'USB_BASIS', 'USB 本机基准目录无效。');
        }
        const manifest = usbManifest(incremental ? parsed.manifest : parsed);
        const plan = planUsb(manifest, incremental ? basis.manifest : null);
        await onManifest(manifest, plan);
        await noLinks(payload);
        await fs.mkdir(path.dirname(payload), { recursive: true, mode: 0o700 });
        await fs.mkdir(payload, { mode: 0o700 }); // Atomic refusal of a concurrently created destination.
        let bytes = 0, files = 0;
        if (incremental) await onProgress({ bytes: 0, files: 0 });
        for (const file of plan.transfer) {
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
        // Finish the HTTP body before local reuse work. Its SHA verification may
        // take longer than the connection idle timeout for a large snapshot.
        // This callback acknowledges transfer only; receive/apply are not done.
        await onTransferred(manifest, plan);
        for (const file of plan.reused) {
            await moveBasisFile(basis.payload, payload, file);
            await onProgress({ bytes, files });
        }
        return manifest;
    } finally { await reader.close().catch(() => {}); }
}
