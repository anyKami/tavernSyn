import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, noLinks, readJson, requireThat, run } from './io.mjs';
import { portablePath } from './manifest.mjs';
import { validatePayloadPaths } from './content.mjs';

export const ATTRIBUTES = 'file-attributes.json';
export function validateExecutables(files, manifest) {
    requireThat(Array.isArray(files) && files.length <= 200000, 'FILE_ATTRIBUTES', '可执行文件清单无效。');
    const seen = new Set(), allowed = manifest && new Set(manifest.files.map(f => f.path));
    for (const name of files) {
        portablePath(name); validatePayloadPaths({ files: [{ path: name }] });
        requireThat(!seen.has(name) && name !== 'environment.json' && !name.startsWith('repositories/')
            && (!allowed || allowed.has(name)), 'FILE_ATTRIBUTES', '可执行文件清单含重复、缺失或范围外路径。');
        seen.add(name);
    }
    return [...seen].sort();
}
export async function localExecutables(device, platform = process.platform) {
    if (platform !== 'win32') return [];
    const file = path.join(device.state, ATTRIBUTES);
    if (!await exists(file)) return [];
    await noLinks(file);
    const attributes = await readJson(file);
    requireThat(attributes.format === 1, 'FILE_ATTRIBUTES', '本机文件属性记录无效。');
    return validateExecutables(attributes.executables);
}
export async function gitFileAttributes(directory, prefix) {
    const { stdout } = await run('git', ['-c', 'safe.directory=*', '-C', directory, 'ls-files', '--stage', '-z']);
    return stdout.split('\0').filter(line => /^100(?:644|755) [a-f0-9]+ 0\t/.test(line))
        .map(line => ({ path: `${prefix}/${line.slice(line.indexOf('\t') + 1)}`, executable: line.startsWith('100755 ') }));
}
export async function gitExecutables(directory, prefix) {
    return (await gitFileAttributes(directory, prefix)).filter(f => f.executable).map(f => f.path);
}
export async function applyExecutables(candidate, files, manifest, platform = process.platform) {
    const executable = new Set(validateExecutables(files, manifest));
    if (platform === 'win32') return;
    // The transport is deliberately permission-agnostic. Restore only owner
    // execution; ownership, group/world bits and special bits never travel.
    for (const entry of manifest.files) {
        if (entry.path === 'environment.json' || entry.path.startsWith('repositories/')) continue;
        const file = path.join(candidate, ...entry.path.split('/'));
        await noLinks(file); await fs.chmod(file, executable.has(entry.path) ? 0o700 : 0o600);
    }
}
