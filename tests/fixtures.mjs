import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { PROJECT } from '../lib/device.mjs';
import { atomicJson, readJson } from '../lib/io.mjs';
import { copyTree, verify } from '../lib/manifest.mjs';
import { DEVICE_POINTERS } from '../lib/settings.mjs';

export const ST = path.resolve(process.env.SILLYTAVERN_SOURCE ?? path.join(PROJECT, '../tavern/SillyTavern'));
export const YAML = createRequire(path.join(ST, 'package.json'))('yaml');
export async function temporary(name) { await fs.mkdir(path.join(PROJECT, '.tmp'), { recursive: true }); return fs.mkdtemp(path.join(PROJECT, `.tmp/${name}-`)); }
export async function fixture() {
    const root = await temporary('unit'), install = path.join(root, 'SillyTavern'), state = path.join(root, 'state'), dataRoot = path.join(install, 'data');
    const stConfig = { dataRoot: './data', port: 8000, listen: false, backups: { common: { numberOfBackups: 3 } }, enableServerPlugins: true };
    for (const folder of ['default-user/worlds', 'default-user/chats', 'default-user/characters', 'default-user/vertex-paygo', '_css', '_storage']) await fs.mkdir(path.join(dataRoot, folder), { recursive: true });
    await fs.mkdir(state); await fs.mkdir(path.join(install, 'plugins/tavernsyn'), { recursive: true }); await fs.mkdir(path.join(install, 'public/scripts/extensions/third-party/tavernsyn'), { recursive: true });
    await atomicJson(path.join(dataRoot, 'default-user/settings.json'), { username: 'fixture', extension_settings: { tavernsyn: { local: true }, custom: { enabled: true } }, power_user: { chat_width: 90, theme: 'dark' }, oai_settings: {}, textgenerationwebui_settings: {} });
    await atomicJson(path.join(dataRoot, 'default-user/secrets.json'), { fake_api_key: 'SYNTHETIC_NOT_A_KEY' });
    await atomicJson(path.join(dataRoot, 'default-user/worlds/book.json'), { entries: { one: { content: 'synthetic world' } } });
    await atomicJson(path.join(dataRoot, 'default-user/vertex-paygo/state.json'), { persistent: true });
    await fs.writeFile(path.join(dataRoot, '_storage/private-account.txt'), 'local only');
    await fs.writeFile(path.join(install, 'plugins/tavernsyn/index.mjs'), '// local helper wrapper');
    await fs.writeFile(path.join(install, 'plugins/package.json'), '{"type":"commonjs"}');
    await fs.writeFile(path.join(install, 'public/scripts/extensions/third-party/tavernsyn/local.txt'), 'local UI');
    await fs.writeFile(path.join(install, 'config.yaml'), YAML.stringify(stConfig));
    return { root, format: 1, deviceId: randomUUID(), deviceName: 'fixture', install, state, dataRoot, profile: 'default-user', stConfig, YAML,
        yamlPath: path.join(install, 'config.yaml'), origin: 'http://127.0.0.1:8000', pointers: DEVICE_POINTERS, extraRoots: [], preserveJson: [], restoreDependencies: false,
        remote: { dataset: randomUUID() } };
}
export class MemoryTransport {
    constructor(root) { this.root = root; this.current = null; this.last = null; }
    async connect(device) { return { hello: { current: this.current, dataset: device?.remote?.dataset ?? 'fixture', protocol: 1 }, control: {
        close() {}, request: async op => { if (op !== 'hello') throw new Error('Unexpected memory control request'); return { current: this.current, dataset: device?.remote?.dataset ?? 'fixture' }; },
    } }; }
    async push(_session, _device, job, payload, manifest, _progress, onBegin) {
        await onBegin?.({ job });
        await verify(payload, manifest);
        const stored = path.join(this.root, job); await copyTree(payload, stored);
        this.last = { payload: stored, manifest }; this.current = { generation: job, digest: manifest.digest };
        return { ...this.current, stats: { sentBytes: manifest.bytes, receivedBytes: 30, literalBytes: manifest.bytes } };
    }
    async pull(_session, _device, _job, payload, _progress, onBegin) {
        if (!this.current) throw Object.assign(new Error('empty test remote'), { code: 'EMPTY_REMOTE' });
        await onBegin?.({ job: _job });
        await copyTree(this.last.payload, payload);
        await atomicJson(path.join(path.dirname(payload), 'manifest.json'), this.last.manifest);
        return { ...this.current, manifest: this.last.manifest, stats: { sentBytes: 30, receivedBytes: this.last.manifest.bytes } };
    }
}
export class FakeLifecycle {
    constructor() { this.stopped = false; this.starts = 0; this.failNext = false; }
    async receipt() { return { created: Date.now(), files: [] }; }
    async verifyReceipt() {}
    async stop() { this.stopped = true; }
    async start() { this.starts++; this.stopped = false; if (this.failNext) { this.failNext = false; this.stopped = true; throw Object.assign(new Error('synthetic health failure'), { code: 'HEALTH' }); } }
    async resume() {}
}
export async function phase(manager, expected, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const current = await manager.status();
        if (current.phase === expected) return current;
        if (['FAILED', 'RECOVERY_REQUIRED'].includes(current.phase)) throw new Error(`Unexpected ${JSON.stringify(current)}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Waiting for ${expected}; current ${JSON.stringify(await manager.status())}`);
}
export async function handoff(manager) {
    const waiting = await phase(manager, 'AWAITING_SAVE');
    await manager.action('ready', { id: waiting.id, tab: waiting.tab, receipt: randomUUID() });
    const page = await phase(manager, 'WAITING_PAGE');
    await manager.action('page', { id: page.id, tab: page.tab, ticket: page.ticket });
}
