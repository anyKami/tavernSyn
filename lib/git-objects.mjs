import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { exists, removeOwned, requireThat, SyncError } from './io.mjs';

// Transport ordinary loose objects: their content-addressed paths survive a
// small new commit, unlike the name of a newly created shallow-clone pack.
export async function unpackSnapshotObjects(repository, stagingRoot, id) {
    const packs = path.join(repository, '.git/objects/pack');
    if (!await exists(packs)) return;
    const source = path.join(stagingRoot, `repository-packs-${id}`);
    // Git skips objects already visible in its object database. Move the packs
    // out before feeding them back, and stream so large plugins do not fill RAM.
    await fs.rename(packs, source);
    await fs.mkdir(packs);
    for (const name of (await fs.readdir(source)).filter(name => name.endsWith('.pack')).sort()) {
        const child = spawn('git', ['-C', repository, 'unpack-objects', '-q'], {
            windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
        });
        child.stderr.resume();
        const exited = new Promise((resolve, reject) => {
            child.once('error', () => reject(new SyncError('PLUGIN_GIT', '无法展开插件 Git 对象。')));
            child.once('close', code => code === 0 ? resolve() : reject(new SyncError('PLUGIN_GIT', '插件 Git 对象展开失败，未制作可发布快照。')));
        });
        const copied = pipeline(createReadStream(path.join(source, name)), child.stdin).catch(error => {
            child.kill(); throw error;
        });
        await Promise.all([exited, copied]);
    }
    requireThat((await fs.readdir(packs)).length === 0, 'PLUGIN_GIT', 'Git 对象展开后仍有未处理的数据包。');
    await removeOwned(stagingRoot, source);
}
