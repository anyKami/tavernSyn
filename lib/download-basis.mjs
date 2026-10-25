import fs from 'node:fs/promises';
import path from 'node:path';
import { rootsFor } from './snapshot.mjs';
import { sharedSettings } from './settings.mjs';
import { validateManifest } from './manifest.mjs';
import { atomicJson, inside, noLinks, readJson, requireThat } from './io.mjs';

// A missing transport cache need not mean a cold network download. Seed only
// requested portable files from mapped live roots, never a whole user directory.
export async function seedDownloadBasis(device, payload, manifest) {
    validateManifest(manifest);
    await noLinks(payload);
    const roots = await rootsFor(device);
    let files = 0;
    for (const entry of manifest.files) {
        const root = roots.find(root => entry.path.startsWith(root.id + '/'));
        if (!root) continue; // environment and Git transport data are not live roots
        const relative = entry.path.slice(root.id.length + 1);
        if (root.exclude(relative)) continue;
        const source = path.join(root.path, ...relative.split('/')), target = path.join(payload, ...entry.path.split('/'));
        requireThat(inside(root.path, source) && inside(payload, target), 'UNSAFE_PATH', '下载差分基础路径越界。');
        try {
            await noLinks(source); await noLinks(target);
            if (!(await fs.lstat(source)).isFile()) continue;
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            const policy = entry.path === 'profile/settings.json' ? device.pointers : device.preserveJson.find(p => p.path === entry.path)?.pointers;
            if (policy) await atomicJson(target, sharedSettings(await readJson(source), policy));
            else { await fs.copyFile(source, target); await fs.chmod(target, 0o600); }
            // Force rsync to compare blocks even when live data has the same size
            // and timestamp as a different VPS file. Final SHA-256 still applies.
            const time = new Date(entry.mtime === 0 ? 1000 : 0);
            await fs.utimes(target, time, time); files++;
        } catch (error) {
            // A live autosave can replace a source between inventory and copy.
            // This is an optional basis; the pinned remote download remains authoritative.
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        }
    }
    return { files };
}
