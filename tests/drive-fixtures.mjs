import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DriveApi } from '../lib/drive-api.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
const response = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), { status, headers });
const error = status => response({ error: { errors: [{ reason: status === 404 ? 'notFound' : 'conflict' }], message: 'not forwarded' } }, status);

/** In-memory implementation of the Drive HTTP contract, with fault injection. */
export class MemoryDrive {
    constructor() {
        this.files = new Map(); this.sessions = new Map(); this.requests = []; this.serial = 0;
        this.api = new DriveApi({ accessToken: async () => 'test-token', fetchImpl: this.fetch.bind(this), chunkBytes: 256 * 1024, retryBaseMs: 0 });
    }
    put(metadata, data = Buffer.alloc(0)) {
        const bytes = Buffer.from(data);
        this.files.set(metadata.id, { metadata: { ...metadata, size: String(bytes.length),
            md5Checksum: createHash('md5').update(bytes).digest('hex'), sha256Checksum: hash(bytes) }, data: bytes });
    }
    readJson(id) { return JSON.parse(this.files.get(id).data.toString()); }
    writeJson(id, value) { this.put(this.files.get(id).metadata, Buffer.from(JSON.stringify(value))); }
    async fetch(input, options = {}) {
        const url = new URL(input), method = options.method ?? 'GET';
        const request = { url, method, ...options }; this.requests.push(request);
        const injected = await this.before?.(request, this);
        if (injected) return injected;
        if (url.pathname.endsWith('/generateIds')) {
            return response({ ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => `drive_file_${++this.serial}`) });
        }
        if (url.pathname === '/drive/v3/files' && method === 'POST') {
            const metadata = JSON.parse(options.body);
            if (this.files.has(metadata.id)) return error(409);
            this.put(metadata); return response({ id: metadata.id });
        }
        if (url.pathname === '/drive/v3/files' && method === 'GET') {
            const q = url.searchParams.get('q'), parent = /^'([^']+)'/.exec(q)?.[1];
            const kind = /key='kind' and value='([^']+)'/.exec(q)?.[1];
            const dataset = /key='repositoryId' and value='([^']+)'/.exec(q)?.[1];
            return response({ files: [...this.files.values()].map(file => file.metadata).filter(file => file.parents?.includes(parent)
                && file.appProperties?.kind === kind && file.appProperties?.repositoryId === dataset) });
        }
        if (url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'multipart') {
            const boundary = /boundary=(.+)/.exec(options.headers['content-type'])[1];
            const parts = Buffer.from(options.body).toString().split(`--${boundary}`);
            const metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
            const value = parts[2].split('\r\n\r\n')[1].replace(/\r\n$/, '');
            if (this.files.has(metadata.id)) return error(409);
            this.put(metadata, Buffer.from(value));
            await this.afterCreate?.(metadata, JSON.parse(value));
            return response({ id: metadata.id });
        }
        if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
            const metadata = JSON.parse(options.body);
            if (this.files.has(metadata.id)) return error(409);
            const sessionId = `session_${++this.serial}`;
            this.sessions.set(sessionId, { metadata, bytes: Buffer.alloc(0), total: Number(options.headers['x-upload-content-length']) });
            return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sessionId}` } });
        }
        if (url.pathname === '/upload/drive/v3/files' && method === 'PUT') {
            const session = this.sessions.get(url.searchParams.get('upload_id'));
            if (!session) return error(404);
            if (session.complete) return response(session.metadata);
            const range = options.headers['content-range'];
            if (range.startsWith('bytes */')) return new Response(null, { status: 308,
                headers: session.bytes.length ? { range: `bytes=0-${session.bytes.length - 1}` } : {} });
            const parsed = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
            if (!parsed || Number(parsed[1]) !== session.bytes.length || Number(parsed[3]) !== session.total) return error(400);
            session.bytes = Buffer.concat([session.bytes, Buffer.from(options.body)]);
            if (session.bytes.length === session.total) {
                this.put(session.metadata, session.bytes); session.complete = true;
                await this.afterUpload?.(session);
                return response(this.files.get(session.metadata.id).metadata);
            }
            return new Response(null, { status: 308, headers: { range: `bytes=0-${session.bytes.length - 1}` } });
        }
        const fileId = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)?.[1];
        if (fileId) {
            const file = this.files.get(fileId);
            if (!file) return error(404);
            if (method === 'DELETE') { this.files.delete(fileId); return new Response(null, { status: 204 }); }
            if (url.searchParams.get('alt') === 'media') return response(file.data);
            return response(file.metadata);
        }
        throw new Error(`Unexpected fake request: ${method} ${url.pathname}`);
    }
}
export async function driveFixture(t, content = Buffer.alloc(700_000, 97)) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const dir = await fs.mkdtemp(path.join(parent, 'drive-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const archiveFile = path.join(dir, 'snapshot.tsenc'); await fs.writeFile(archiveFile, content);
    const drive = new MemoryDrive();
    return { dir, archiveFile, content, archiveSha256: hash(content), drive, api: drive.api, dataset: randomUUID() };
}
