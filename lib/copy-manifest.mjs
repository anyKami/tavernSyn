import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { noLinks, requireThat } from './io.mjs';
import { portablePath } from './manifest.mjs';

const READ_FLAGS = process.platform === 'win32' ? constants.O_RDONLY
    : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function sameFile(first, second) {
    return second?.isFile() && first.dev === second.dev && first.ino === second.ino
        && first.mode === second.mode && first.size === second.size
        && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

async function copyFileWithHash(source, target, name, expected, buffer) {
    const input = await fs.open(source, READ_FLAGS);
    try {
        const before = await input.stat({ bigint: true });
        requireThat(sameFile(expected, before), 'SOURCE_CHANGED', '复制前源文件已改变。');
        const size = Number(before.size);
        requireThat(Number.isSafeInteger(size), 'MANIFEST', '文件大小超出支持范围。');
        const mode = (before.mode & 0o111n) ? 0o700 : 0o600;
        const output = await fs.open(target, 'wx', mode);
        try {
            const hash = createHash('sha256');
            let remaining = size;
            while (remaining > 0) {
                const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null);
                requireThat(bytesRead > 0, 'SOURCE_CHANGED', '复制时源文件提前结束。');
                let offset = 0;
                while (offset < bytesRead) {
                    const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null);
                    requireThat(bytesWritten > 0, 'USB_WRITE', 'USB 快照文件未能完整写入。');
                    offset += bytesWritten;
                }
                hash.update(buffer.subarray(0, bytesRead));
                remaining -= bytesRead;
            }
            const after = await input.stat({ bigint: true });
            const current = await fs.lstat(source, { bigint: true }).catch(error => {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
                throw error;
            });
            requireThat(sameFile(before, after) && sameFile(before, current), 'SOURCE_CHANGED', '复制时源文件已改变。');
            await output.chmod(mode);
            await output.utimes(new Date(Number(before.atimeMs)), new Date(Number(before.mtimeMs)));
            const { mtimeMs } = await output.stat();
            return { path: name, size, mtime: Math.floor(mtimeMs / 1000), sha256: hash.digest('hex') };
        } finally { await output.close(); }
    } finally { await input.close(); }
}

export async function copyManifestTree(source, target, { prefix, exclude, onFile }) {
    await noLinks(source); await noLinks(target);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    const files = [], seen = new Set(), buffer = Buffer.allocUnsafe(256 * 1024);
    async function visit(directory) {
        for (const entry of await fs.readdir(path.join(source, directory), { withFileTypes: true })) {
            const relative = directory ? `${directory}/${entry.name}` : entry.name;
            if (exclude(relative, entry)) continue;
            const name = portablePath(prefix ? `${prefix}/${relative}` : relative), folded = name.normalize('NFC').toLowerCase();
            requireThat(!seen.has(folded), 'FILENAME_COLLISION', '文件名存在大小写或 Unicode 冲突。');
            seen.add(folded);
            const src = path.join(source, relative), dst = path.join(target, relative);
            const stat = await fs.lstat(src, { bigint: true });
            requireThat(stat.isDirectory() || stat.isFile(), 'LINK', '源目录含链接或特殊文件。');
            if (stat.isDirectory()) {
                await fs.mkdir(dst, { mode: 0o700 });
                await visit(relative);
            } else {
                files.push(await copyFileWithHash(src, dst, name, stat, buffer));
                onFile(relative, { mode: Number(stat.mode) });
            }
        }
    }
    await visit('');
    return files;
}
