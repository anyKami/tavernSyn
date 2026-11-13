import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, digest, noLinks, requireThat, renamePath } from './io.mjs';
import { validateManifest } from './manifest.mjs';
import { uuidPattern } from './device.mjs';
import { normalizeScope } from './scope.mjs';

export const HYBRID_PROTOCOL = 'hybrid-v1';
export const SMALL_LIMIT = 256 * 1024, BUNDLE_LIMIT = 16 * 1024 * 1024, FILE_LIMIT = 2000;
const MAGIC = Buffer.from('TSHYB001'), HEADER_LIMIT = 1024 * 1024;
const sha = data => createHash('sha256').update(data).digest('hex');
const check = (v, m) => requireThat(v, 'HYBRID', m);
const record = f => ({ path: f.path, size: f.size, sha256: f.sha256, mtime: f.mtime });

// The plan freezes both selected files and metadata; callers persist it before transfer.
export function createPlan(binding, manifest, changed) {
    validateManifest(manifest);
    check(binding && uuidPattern.test(binding.job) && uuidPattern.test(binding.dataset) && uuidPattern.test(binding.generation)
        && (binding.base === null || /^[a-f0-9]{64}$/.test(binding.base)) && (binding.scope === null || Array.isArray(binding.scope)), '无效计划绑定。');
    check(canonical(normalizeScope(binding.scope)) === canonical(binding.scope), '无效范围。');
    check(Array.isArray(changed) && new Set(changed).size === changed.length, '无效变更列表。');
    const selected = new Set(changed), files = [...manifest.files].sort((a,b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).filter(f => selected.has(f.path));
    check(files.length === selected.size, '变更不在清单中。');
    const groups = [], large = []; let group = [], bytes = 0;
    for (const file of files) {
        if (file.size > SMALL_LIMIT) { large.push(file.path); continue; }
        if (group.length && (group.length === FILE_LIMIT || bytes + file.size > BUNDLE_LIMIT)) { groups.push(group); group = []; bytes = 0; }
        group.push(record(file)); bytes += file.size;
    }
    if (group.length) groups.push(group);
    const plan = { format: 1, protocol: HYBRID_PROTOCOL, job: binding.job, dataset: binding.dataset, generation: binding.generation, base: binding.base, scope: binding.scope, manifestDigest: manifest.digest, groups, large };
    return { ...plan, digest: digest(plan) };
}
export function validatePlan(plan, manifest) {
    validateManifest(manifest);
    check(plan && plan.format === 1 && plan.protocol === HYBRID_PROTOCOL && plan.manifestDigest === manifest.digest && Array.isArray(plan.groups) && Array.isArray(plan.large), '计划格式无效。');
    const { digest: actual, ...body } = plan;
    check(actual === digest(body), '计划摘要不匹配。');
    const names = [...plan.groups.flat().map(f => f.path), ...plan.large];
    const expected = createPlan(plan, manifest, names);
    check(canonical(expected) === canonical(plan), '计划不符合固定分组或清单。');
    return plan;
}
async function checkedPath(root, relative) { const target = path.join(root, ...relative.split('/')); await noLinks(target); return target; }
async function regular(file) { const s = await fs.lstat(file); check(s.isFile() && !s.isSymbolicLink(), '包或源文件不是普通文件。'); return s; }
async function readSource(root, f) {
    const p = await checkedPath(root, f.path), before = await regular(p), data = await fs.readFile(p), after = await regular(p);
    check(before.size === f.size && after.size === f.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && sha(data) === f.sha256, '源文件发生变化。'); return data;
}
function header(plan, index) { check(Number.isInteger(index) && index >= 0 && index < plan.groups.length, '包序号无效。'); return { format: 1, planDigest: plan.digest, index, files: plan.groups[index] }; }
export async function createBundle(root, target, plan, manifest, index) {
    validatePlan(plan, manifest); const head = Buffer.from(canonical(header(plan, index))); check(head.length <= HEADER_LIMIT, '包头过大。');
    const chunks = []; for (const f of plan.groups[index]) chunks.push(await readSource(root, f));
    const len = Buffer.alloc(4); len.writeUInt32BE(head.length); const bytes = Buffer.concat([MAGIC, len, head, ...chunks]);
    await noLinks(target); await fs.mkdir(path.dirname(target), { recursive: true }); await noLinks(target);
    const tmp = `${target}.${randomUUID()}.tmp`; let h;
    try { h = await fs.open(tmp, 'wx', 0o600); await h.writeFile(bytes); await h.sync(); await h.close(); h = null;
        // Reuse matching bundles; rebuild a corrupt local cache from the verified source.
        try { await regular(target); if (sha(await fs.readFile(target)) !== sha(bytes)) await renamePath(tmp, target); } catch (e) { if (e.code !== 'ENOENT') throw e; await renamePath(tmp, target); }
    } finally { if (h) await h.close(); await fs.unlink(tmp).catch(() => {}); }
    return { size: bytes.length, sha256: sha(bytes) };
}
export async function verifyBundle(file, plan, manifest, index, expectedHash) {
    validatePlan(plan, manifest); await noLinks(file); const st = await regular(file);
    check(st.size <= MAGIC.length + 4 + HEADER_LIMIT + BUNDLE_LIMIT, '包过大。'); const data = await fs.readFile(file);
    check(typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash) && sha(data) === expectedHash, '包摘要不匹配。');
    check(data.length >= 12 && data.subarray(0,8).equals(MAGIC), '包魔术字无效。'); const len = data.readUInt32BE(8);
    check(len <= HEADER_LIMIT && 12 + len <= data.length, '包头长度无效。');
    const text = data.subarray(12,12+len).toString('utf8'); check(text === canonical(header(plan,index)), '包头与计划不一致。');
    let offset = 12 + len; const entries = [];
    for (const f of plan.groups[index]) { const end = offset + f.size; check(end <= data.length && sha(data.subarray(offset,end)) === f.sha256, '包中文件损坏。'); entries.push({ file: f, data: data.subarray(offset,end) }); offset = end; }
    check(offset === data.length, '包尾存在多余数据。'); return entries;
}
export async function applyBundle(file, root, plan, manifest, index, expectedHash) {
    const entries = await verifyBundle(file, plan, manifest, index, expectedHash); await noLinks(root); await fs.mkdir(root, { recursive: true });
    for (const {file: f, data} of entries) { const dest = await checkedPath(root, f.path); await fs.mkdir(path.dirname(dest), { recursive: true }); await noLinks(dest);
        const tmp = `${dest}.${randomUUID()}.tmp`; let handle;
        try { handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null; await fs.utimes(tmp, f.mtime, f.mtime); await noLinks(dest); await renamePath(tmp, dest); }
        finally { if (handle) await handle.close(); await fs.unlink(tmp).catch(() => {}); }
    }
}
