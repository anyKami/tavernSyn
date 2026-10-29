import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest, requireThat, noLinks } from './io.mjs';

export function portablePath(relative) {
    requireThat(typeof relative === 'string' && relative.length > 0 && relative.length <= 220 && !relative.includes('\\'), 'FILENAME', '同步路径为空、过长或含反斜杠。');
    for (const part of relative.split('/')) {
        requireThat(part && part !== '.' && part !== '..' && part.length <= 120 && !/[<>:"|?*\x00-\x1f\x7f]/.test(part) && !/[. ]$/.test(part)
            && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
            && part !== '.tavernsyn-partial' && !['__proto__', 'prototype', 'constructor'].includes(part), 'FILENAME', '发现不兼容的文件名，已停止以保护引用关系。');
    }
    return relative;
}
export async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
export async function scan(root, { exclude = () => false, onFile = () => {} } = {}) {
    await noLinks(root);
    const files = [], seen = new Set();
    async function visit(directory, prefix) {
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (exclude(relative, entry)) continue;
            portablePath(relative);
            const folded = relative.normalize('NFC').toLowerCase();
            requireThat(!seen.has(folded), 'FILENAME_COLLISION', '文件名存在大小写或 Unicode 冲突。'); seen.add(folded);
            const full = path.join(root, ...relative.split('/')); const stat = await fs.lstat(full);
            requireThat(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'LINK', '不允许同步链接或特殊文件。');
            if (stat.isDirectory()) await visit(full, relative);
            else {
                const sha256 = await hashFile(full); const after = await fs.stat(full);
                requireThat(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'SOURCE_CHANGED', '扫描期间文件发生变化，请重试。');
                files.push({ path: relative, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000), sha256 });
                await onFile(relative, stat);
            }
        }
    }
    await visit(root, ''); files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    return seal(files);
}
export function seal(files) {
    return { format: 1, files, bytes: files.reduce((n, f) => n + f.size, 0), digest: digest(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))) };
}
export function validateManifest(manifest) {
    requireThat(manifest?.format === 1 && Array.isArray(manifest.files) && manifest.files.length <= 200000, 'MANIFEST', '不支持或过大的文件清单。');
    const seen = new Set();
    for (const f of manifest.files) {
        portablePath(f.path); const folded = f.path.normalize('NFC').toLowerCase();
        requireThat(!seen.has(folded) && Number.isSafeInteger(f.size) && f.size >= 0 && /^[a-f0-9]{64}$/.test(f.sha256) && Number.isSafeInteger(f.mtime), 'MANIFEST', '文件清单含重复路径或无效摘要。'); seen.add(folded);
    }
    const sorted = [...manifest.files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    requireThat(seal(sorted).digest === manifest.digest && seal(sorted).bytes === manifest.bytes, 'MANIFEST', '清单摘要不匹配。');
    return manifest;
}
export function difference(expected, actual) {
    validateManifest(expected); validateManifest(actual);
    const wanted = new Map(expected.files.map(f => [f.path, f])); const have = new Map(actual.files.map(f => [f.path, f]));
    const missing = [], changed = [], extra = [];
    for (const [name, file] of wanted) { if (!have.has(name)) missing.push(name); else if (have.get(name).sha256 !== file.sha256 || have.get(name).size !== file.size) changed.push(name); }
    for (const name of have.keys()) if (!wanted.has(name)) extra.push(name);
    return { missing, changed, extra, equal: !missing.length && !changed.length && !extra.length };
}
export function transferSummary(manifest, diff) {
    const pending = new Set([...(diff.missing ?? []), ...diff.changed]);
    const files = manifest.files.filter(file => pending.has(file.path));
    requireThat(files.length === pending.size, 'MANIFEST', '待传输文件不在已核验的来源清单中。');
    return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}
export async function verify(root, expected) {
    const actual = await scan(root); const diff = difference(expected, actual);
    requireThat(diff.equal, 'INTEGRITY', '文件完整性校验未通过，数据不会被发布或应用。');
    return actual;
}
export async function copyTree(source, target, { exclude = () => false, onFile = () => {} } = {}) {
    await noLinks(source); await noLinks(target); await fs.mkdir(target, { recursive: true, mode: 0o700 });
    async function visit(directory, prefix) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (exclude(relative, entry)) continue;
            portablePath(relative);
            const src = path.join(source, ...relative.split('/')), dst = path.join(target, ...relative.split('/'));
            const stat = await fs.lstat(src);
            requireThat(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'LINK', '源目录含链接或特殊文件。');
            if (stat.isDirectory()) { await fs.mkdir(dst, { recursive: true, mode: 0o700 }); await visit(src, relative); }
            else { await fs.copyFile(src, dst); await fs.chmod(dst, 0o600 | (stat.mode & 0o111 ? 0o100 : 0)); await fs.utimes(dst, stat.atime, stat.mtime); await onFile(relative, stat); }
        }
    }
    await visit(source, '');
}
