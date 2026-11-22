import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { noLinks, requireThat, SyncError } from './io.mjs';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,mimeType,parents,appProperties,size,md5Checksum,sha256Checksum,trashed';
const JSON_LIMIT = 1024 * 1024;
export const driveIdPattern = /^[A-Za-z0-9_-]{8,200}$/;
const shaPattern = /^[a-f0-9]{64}$/;

function id(value) { requireThat(driveIdPattern.test(value ?? ''), 'DRIVE_ID', 'Google 云盘文件标识无效。'); return value; }
function apiError(status, reason) {
    const code = status === 401 ? 'DRIVE_AUTH' : status === 404 ? 'DRIVE_NOT_FOUND'
        : status === 409 ? 'DRIVE_CONFLICT' : 'DRIVE_HTTP';
    return Object.assign(new SyncError(code, `Google 云盘请求未成功（HTTP ${status}），本机数据未因此被覆盖。`),
        { status, ...(reason ? { reason } : {}) });
}
function networkError() { return new SyncError('DRIVE_NETWORK', 'Google 云盘连接中断或超时，请检查网络后重试。'); }
function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(networkError());
        if (signal.aborted) { Promise.resolve(promise).catch(() => {}); aborted(); return; }
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve(promise).then(value => {
            signal.removeEventListener('abort', aborted); resolve(value);
        }, error => { signal.removeEventListener('abort', aborted); reject(error); });
    });
}
function props(kind, repositoryId) {
    requireThat(['root', 'commit', 'payload'].includes(kind) && typeof repositoryId === 'string'
        && /^[a-f0-9-]{36}$/.test(repositoryId), 'DRIVE_METADATA', 'Google 云盘仓库标记无效。');
    return { tavernsyn: '1', kind, repositoryId };
}
async function json(response, limit = JSON_LIMIT) {
    const chunks = []; let size = 0;
    try {
        for await (const chunk of response.body ?? []) {
            size += chunk.length;
            requireThat(size <= limit, 'DRIVE_RESPONSE', 'Google 云盘响应超过大小限制。');
            chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        if (error instanceof SyncError) throw error;
        throw new SyncError('DRIVE_RESPONSE', 'Google 云盘返回的数据格式无效。');
    }
}
async function discard(response) { await response.body?.cancel?.().catch(() => {}); }
function retryable(error) {
    return error.code === 'DRIVE_NETWORK' || error.status === 429 || error.status >= 500
        || (error.status === 403 && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(error.reason));
}
function sessionUrl(value) {
    let url; try { url = new URL(value); } catch { /* Checked below. */ }
    requireThat(url?.origin === 'https://www.googleapis.com' && url.pathname === '/upload/drive/v3/files'
        && !url.username && !url.password && !url.hash && url.searchParams.get('uploadType') === 'resumable'
        && !!url.searchParams.get('upload_id'), 'DRIVE_SESSION', 'Google 云盘返回的上传会话地址无效。');
    return url.href;
}
function nextOffset(response, total) {
    const range = response.headers.get('range');
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    const value = match ? Number(match[1]) + 1 : NaN;
    requireThat(Number.isSafeInteger(value) && value > 0 && value <= total,
        'DRIVE_RANGE', 'Google 云盘返回的续传位置无效。');
    return value;
}
async function hashes(file) {
    await noLinks(file);
    const handle = await fs.open(file, 'r');
    try {
        const before = await handle.stat();
        requireThat(before.isFile() && Number.isSafeInteger(before.size), 'DRIVE_ARCHIVE', '上传归档不是有效的普通文件。');
        const sha = createHash('sha256'), md5 = createHash('md5'), buffer = Buffer.allocUnsafe(256 * 1024);
        let offset = 0;
        while (offset < before.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            requireThat(bytesRead > 0, 'SOURCE_CHANGED', '上传归档在读取时发生变化。');
            const chunk = buffer.subarray(0, bytesRead); sha.update(chunk); md5.update(chunk); offset += bytesRead;
        }
        const after = await handle.stat();
        requireThat(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
            'SOURCE_CHANGED', '上传归档在读取时发生变化。');
        return { size: before.size, sha256: sha.digest('hex'), md5Checksum: md5.digest('hex'), stat: before };
    } finally { await handle.close(); }
}

/** Drive REST adapter. Credentials and resumable session URLs never appear in errors. */
export class DriveApi {
    constructor({ accessToken, fetchImpl = globalThis.fetch, timeoutMs = 60_000, attempts = 4,
        retryBaseMs = 250, chunkBytes = 8 * 1024 * 1024 } = {}) {
        requireThat(typeof accessToken === 'function' && typeof fetchImpl === 'function', 'DRIVE_AUTH', 'Google 云盘授权尚未配置。');
        requireThat(Number.isInteger(attempts) && attempts >= 1 && attempts <= 8
            && Number.isInteger(chunkBytes) && chunkBytes >= 256 * 1024 && chunkBytes <= 32 * 1024 * 1024
            && chunkBytes % (256 * 1024) === 0 && timeoutMs > 0 && retryBaseMs >= 0,
        'DRIVE_OPTIONS', 'Google 云盘传输参数无效。');
        Object.assign(this, { accessToken, fetchImpl, timeoutMs, attempts, retryBaseMs, chunkBytes });
    }
    async request(url, options = {}, { statuses = [200], retry = false } = {}) {
        let endpoint; try { endpoint = new URL(url); } catch { /* Checked below. */ }
        requireThat(endpoint?.origin === 'https://www.googleapis.com' && !endpoint.username && !endpoint.password && !endpoint.hash
            && (endpoint.pathname.startsWith('/drive/v3/') || endpoint.pathname === '/upload/drive/v3/files'),
        'DRIVE_ENDPOINT', '拒绝向 Google 云盘接口以外的地址发送授权信息。');
        let refreshed = false, force = false;
        for (let attempt = 0; ; attempt++) {
            let response;
            try {
                // Downloads supply a resettable inactivity deadline. All other
                // requests retain a fixed deadline including credential lookup.
                const signal = options.signal ?? AbortSignal.timeout(this.timeoutMs);
                const token = await abortable(this.accessToken({ force }), signal); force = false;
                requireThat(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token), 'DRIVE_AUTH', 'Google 云盘访问令牌无效，请重新授权。');
                try {
                    response = await abortable(this.fetchImpl(url, { ...options, redirect: 'manual', signal,
                        headers: { ...options.headers, authorization: `Bearer ${token}` } }), signal);
                } catch { throw networkError(); }
                if (statuses.includes(response.status)) return response;
                let reason;
                try {
                    const body = await json(response, 64 * 1024), value = body?.error?.errors?.[0]?.reason;
                    if (typeof value === 'string' && /^[a-zA-Z]{1,64}$/.test(value)) reason = value;
                } catch { await discard(response); }
                if (response.status === 401 && !refreshed) { refreshed = true; force = true; attempt--; continue; }
                throw apiError(response.status, reason);
            } catch (error) {
                const safe = error instanceof SyncError ? error : new SyncError('DRIVE_AUTH', 'Google 云盘授权读取失败，请重新授权。');
                if (!retry || options.signal?.aborted || !retryable(safe) || attempt + 1 >= this.attempts) throw safe;
                await delay(this.retryBaseMs * 2 ** attempt);
            }
        }
    }
    async generateIds(count = 1) {
        requireThat(Number.isInteger(count) && count > 0 && count <= 1000, 'DRIVE_ID', '预生成文件标识数量无效。');
        const data = await json(await this.request(`${API}/files/generateIds?count=${count}&space=drive`, {}, { retry: true }));
        requireThat(Array.isArray(data.ids) && data.ids.length === count && new Set(data.ids).size === count, 'DRIVE_RESPONSE', 'Google 云盘未返回所需文件标识。');
        return data.ids.map(id);
    }
    async createFolder(name) {
        requireThat(typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\x00-\x1f]/.test(name), 'DRIVE_METADATA', 'Google 云盘文件夹名称无效。');
        const [folderId] = await this.generateIds(1);
        try {
            await json(await this.request(`${API}/files?fields=id`, { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: folderId, name, mimeType: 'application/vnd.google-apps.folder' }) }, { statuses: [200, 201] }));
        } catch (error) {
            // A timed-out create may have committed; the pre-generated ID is safe to inspect.
            if (error.code !== 'DRIVE_NETWORK' && error.status !== 409 && !(error.status >= 500)) throw error;
            const actual = await this.metadata(folderId).catch(() => null);
            if (actual?.mimeType !== 'application/vnd.google-apps.folder' || actual.name !== name) throw error;
        }
        return folderId;
    }
    async createJson(fileId, object, { parentId, kind, repositoryId } = {}) {
        id(fileId); id(parentId);
        const content = JSON.stringify(object);
        requireThat(Buffer.byteLength(content) <= 64 * 1024, 'DRIVE_METADATA', 'Google 云盘提交记录过大。');
        const boundary = `tavernsyn-${randomUUID()}`;
        const metadata = { id: fileId, name: `${kind}-${fileId}.json`, parents: [parentId], mimeType: 'application/json', appProperties: props(kind, repositoryId) };
        const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--\r\n`);
        const result = await json(await this.request(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST',
            headers: { 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': String(body.length) }, body }, { statuses: [200, 201] }));
        requireThat(result.id === fileId, 'DRIVE_RESPONSE', 'Google 云盘提交文件标识不一致。');
        return fileId;
    }
    async getJson(fileId) { return json(await this.request(`${API}/files/${id(fileId)}?alt=media`, {}, { retry: true }), 64 * 1024); }
    async metadata(fileId) {
        const value = await json(await this.request(`${API}/files/${id(fileId)}?fields=${FIELDS}`, {}, { retry: true }));
        requireThat(value?.id === fileId && !value.trashed, 'DRIVE_METADATA', 'Google 云盘文件已删除或标识不一致。');
        return value;
    }
    async list({ parentId, kind, repositoryId } = {}) {
        id(parentId); props(kind, repositoryId);
        const q = `'${parentId}' in parents and trashed = false and appProperties has { key='tavernsyn' and value='1' } and appProperties has { key='kind' and value='${kind}' } and appProperties has { key='repositoryId' and value='${repositoryId}' }`;
        const files = []; let pageToken;
        for (let page = 0; page < 100; page++) {
            const query = new URLSearchParams({ q, spaces: 'drive', fields: `nextPageToken,incompleteSearch,files(${FIELDS})`, pageSize: '100', ...(pageToken ? { pageToken } : {}) });
            const data = await json(await this.request(`${API}/files?${query}`, {}, { retry: true }));
            requireThat(Array.isArray(data.files) && !data.incompleteSearch, 'DRIVE_RESPONSE', 'Google 云盘文件列表不完整。');
            files.push(...data.files);
            if (!data.nextPageToken) return files;
            requireThat(typeof data.nextPageToken === 'string' && data.nextPageToken !== pageToken, 'DRIVE_RESPONSE', 'Google 云盘分页响应无效。');
            pageToken = data.nextPageToken;
        }
        throw new SyncError('DRIVE_LIMIT', 'Google 云盘仓库文件数超过本次查询限制。');
    }
    async uploadFile({ id: fileId, parentId, repositoryId, file, onProgress = () => {} }) {
        id(fileId); id(parentId);
        const expected = await hashes(file);
        requireThat(expected.size > 0, 'DRIVE_ARCHIVE', '不能上传空的同步归档。');
        const metadata = { id: fileId, name: `snapshot-${fileId}.tsenc`, parents: [parentId],
            mimeType: 'application/octet-stream', appProperties: props('payload', repositoryId) };
        let session, offset = 0, restarts = 0, stalls = 0;
        const check = async () => {
            const remote = await this.metadata(fileId);
            requireThat(remote.parents?.includes(parentId) && remote.appProperties?.repositoryId === repositoryId
                && remote.appProperties?.kind === 'payload' && Number(remote.size) === expected.size
                && (remote.sha256Checksum ? remote.sha256Checksum === expected.sha256 : remote.md5Checksum === expected.md5Checksum),
            'INTEGRITY', 'Google 云盘归档校验失败，未发布同步版本。');
            const actual = await hashes(file);
            requireThat(actual.size === expected.size && actual.sha256 === expected.sha256, 'SOURCE_CHANGED', '上传期间本地归档发生变化。');
            await onProgress({ bytes: expected.size, totalBytes: expected.size });
            return { id: fileId, size: expected.size, sha256: expected.sha256, md5Checksum: expected.md5Checksum };
        };
        const handle = await fs.open(file, 'r');
        try {
            for (;;) {
                if (!session) {
                    try {
                        const response = await this.request(`${UPLOAD}?uploadType=resumable&fields=${FIELDS}`, { method: 'POST',
                            headers: { 'content-type': 'application/json', 'x-upload-content-type': 'application/octet-stream',
                                'x-upload-content-length': String(expected.size) }, body: JSON.stringify(metadata) }, { statuses: [200, 201] });
                        session = sessionUrl(response.headers.get('location')); await discard(response); offset = 0;
                    } catch (error) {
                        if (error.status === 409) return await check();
                        if (!retryable(error) || ++restarts >= this.attempts) throw error;
                        await delay(this.retryBaseMs * 2 ** (restarts - 1)); continue;
                    }
                }
                const length = Math.min(this.chunkBytes, expected.size - offset);
                requireThat(length > 0, 'DRIVE_RANGE', 'Google 云盘上传状态未确认完成。');
                const chunk = Buffer.allocUnsafe(length);
                let read = 0;
                while (read < length) {
                    const part = await handle.read(chunk, read, length - read, offset + read);
                    requireThat(part.bytesRead > 0, 'SOURCE_CHANGED', '上传归档在读取时提前结束。'); read += part.bytesRead;
                }
                let response, querying = false;
                try {
                    response = await this.request(session, { method: 'PUT', headers: { 'content-length': String(length),
                        'content-range': `bytes ${offset}-${offset + length - 1}/${expected.size}` }, body: chunk }, { statuses: [200, 201, 308] });
                } catch (error) {
                    if (error.status === 404 || error.status === 410) {
                        if (++restarts >= this.attempts) throw error;
                        // The final acknowledgement may be lost after the object commits.
                        const complete = await this.metadata(fileId).catch(() => null);
                        if (complete) return await check();
                        session = null; continue;
                    }
                    if (!retryable(error) || ++stalls >= this.attempts) throw error;
                    await delay(this.retryBaseMs * 2 ** (stalls - 1)); querying = true;
                    try {
                        response = await this.request(session, { method: 'PUT', headers: { 'content-length': '0',
                            'content-range': `bytes */${expected.size}` }, body: Buffer.alloc(0) }, { statuses: [200, 201, 308], retry: true });
                    } catch (queryError) {
                        if (queryError.status !== 404 && queryError.status !== 410) throw queryError;
                        const complete = await this.metadata(fileId).catch(() => null);
                        if (complete) return await check();
                        if (++restarts >= this.attempts) throw queryError;
                        session = null; continue;
                    }
                }
                if (response.status === 200 || response.status === 201) { await discard(response); return await check(); }
                const next = nextOffset(response, expected.size); await discard(response);
                requireThat(next >= offset && next <= offset + length && next < expected.size,
                    'DRIVE_RANGE', 'Google 云盘续传偏移与已发送内容不符。');
                if (next === offset) {
                    if (!querying && ++stalls >= this.attempts) throw new SyncError('DRIVE_STALLED', 'Google 云盘上传多次没有进展，请稍后重试。');
                } else { offset = next; stalls = 0; await onProgress({ bytes: offset, totalBytes: expected.size }); }
            }
        } finally { await handle.close(); }
    }
    async downloadFile(fileId, file, onProgress = () => {}) {
        const remote = await this.metadata(fileId), size = Number(remote.size);
        requireThat(Number.isSafeInteger(size) && size >= 0 && size <= Number.MAX_SAFE_INTEGER
            && (shaPattern.test(remote.sha256Checksum ?? '') || /^[a-f0-9]{32}$/.test(remote.md5Checksum ?? '')),
        'DRIVE_METADATA', 'Google 云盘归档大小或校验值无效。');
        await noLinks(file); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const handle = await fs.open(file, 'wx', 0o600), sha = createHash('sha256'), md5 = createHash('md5');
        let bytes = 0, complete = false, reader, timer;
        const controller = new AbortController();
        const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), this.timeoutMs); };
        try {
            touch(); // Bounds token/header wait as well as the first body chunk.
            const response = await this.request(`${API}/files/${id(fileId)}?alt=media`, { signal: controller.signal }, { retry: true });
            touch(); // Receiving headers starts a fresh first-byte inactivity window.
            reader = response.body?.getReader();
            while (reader) {
                const { value: chunk, done } = await abortable(reader.read(), controller.signal);
                if (done) break;
                touch(); // A healthy multi-minute transfer must not hit a total-duration deadline.
                bytes += chunk.length;
                requireThat(bytes <= size, 'INTEGRITY', 'Google 云盘归档超过声明大小。');
                sha.update(chunk); md5.update(chunk);
                let written = 0;
                while (written < chunk.length) {
                    const { bytesWritten } = await handle.write(chunk, written, chunk.length - written);
                    requireThat(bytesWritten > 0, 'DRIVE_WRITE', '下载归档写入磁盘没有进展，未应用本机。');
                    written += bytesWritten;
                }
                await onProgress({ bytes, totalBytes: size });
            }
            clearTimeout(timer);
            const sha256 = sha.digest('hex'), md5Checksum = md5.digest('hex');
            requireThat(bytes === size && (!remote.sha256Checksum || remote.sha256Checksum === sha256)
                && (!remote.md5Checksum || remote.md5Checksum === md5Checksum), 'INTEGRITY', 'Google 云盘下载归档校验失败，未应用本机。');
            await handle.sync(); complete = true; return { bytes, sha256, md5Checksum };
        } catch (error) {
            if (error instanceof SyncError) throw error;
            throw networkError();
        } finally {
            clearTimeout(timer); controller.abort();
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            await handle.close(); if (!complete) await fs.unlink(file).catch(() => {});
        }
    }
    async deleteFile(fileId) {
        const response = await this.request(`${API}/files/${id(fileId)}`, { method: 'DELETE' }, { statuses: [204, 404], retry: true });
        await discard(response);
    }
}
