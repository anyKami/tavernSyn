import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { exists, removeOwned, requireThat, run, SyncError } from './io.mjs';

// Read the current version as data; never clone a live repository or copy its
// hooks/config. The portable worktree already contains the user's local edits.
export async function packSnapshotObjects(directory, repository, commit) {
    const args = ['-c', 'safe.directory=*', '-C', directory];
    const tree = (await run('git', [...args, 'rev-parse', `${commit}^{tree}`])).stdout.trim();
    const entries = (await run('git', [...args, 'ls-tree', '-r', '-t', '-z', commit])).stdout.split('\0');
    const objects = new Set([commit, tree]);
    for (const entry of entries) {
        const match = /^\d+ (?:tree|blob) ([a-f0-9]{40,64})\t/.exec(entry);
        if (match) objects.add(match[1]); // Gitlinks belong to another repository.
    }
    const packs = path.join(repository, '.git/objects/pack'); await fs.mkdir(packs, { recursive: true });
    const child = spawn('git', [...args, 'pack-objects', '--stdout', '--no-reuse-delta'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    });
    child.stderr.resume(); child.stdin.on('error', () => {});
    const exited = new Promise((resolve, reject) => {
        child.once('error', () => reject(new SyncError('PLUGIN_GIT', '无法读取插件当前版本的 Git 对象。')));
        child.once('close', code => code === 0 ? resolve() : reject(new SyncError('PLUGIN_GIT', '插件当前版本的 Git 对象不完整，未制作可发布数据。')));
    });
    const written = pipeline(child.stdout, createWriteStream(path.join(packs, 'snapshot.pack'), { flags: 'wx', mode: 0o600 }));
    child.stdin.end([...objects].join('\n') + '\n');
    try { await Promise.all([exited, written]); }
    catch (error) { child.kill(); await Promise.allSettled([exited, written]); throw error; }
}

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
