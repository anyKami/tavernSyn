import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTRIBUTES } from './file-attributes.mjs';
import { digest, noLinks, requireThat, run } from './io.mjs';
import { portablePath } from './manifest.mjs';
import { rootsFor, sharedConfig } from './snapshot.mjs';

const STAT_BATCH = 16;

function lstat(file) {
    return fs.lstat(file, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
    });
}

function stamp(key, stat) {
    if (!stat) return [key, 'missing'];
    requireThat(stat.isDirectory() || stat.isFile(), 'LINK', '同步范围含链接或特殊文件，已停止操作。');
    const identity = [stat.dev, stat.ino, stat.mode];
    // A directory's timestamps and link count also change when an excluded
    // cache folder is created or removed. Its identity and included paths suffice.
    if (stat.isFile()) identity.push(stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs);
    return [key, stat.isDirectory() ? 'directory' : 'file', ...identity.map(String)];
}

async function walk(directory, accept, visit, prefix = '') {
    const names = (await fs.readdir(directory)).sort().filter(name => accept(prefix + name));
    for (let index = 0; index < names.length; index += STAT_BATCH) {
        const children = await Promise.all(names.slice(index, index + STAT_BATCH).map(async name => {
            const file = path.join(directory, name), stat = await lstat(file);
            requireThat(stat, 'LOCAL_CHANGED', '扫描期间本机路径发生变化，请重试。');
            return { file, relative: prefix + name, stat };
        }));
        for (const { file, relative, stat } of children) {
            await visit(file, relative, stat);
            if (stat.isDirectory()) await walk(file, accept, visit, `${relative}/`);
        }
    }
}

async function readGitPointer(file, stat) {
    requireThat(stat.isFile() && stat.size > 0n && stat.size <= 16384n, 'PLUGIN_GIT', '插件 Git 目录指针无效。');
    return (await fs.readFile(file, 'utf8')).replace(/\r?\n$/, '');
}

async function gitStamp(entries, plugin, key) {
    let directory = path.join(plugin, '.git');
    const local = await lstat(directory);
    if (!local) return;
    entries.push(stamp(`${key}/.git`, local));
    if (local.isFile()) {
        const pointer = /^gitdir: ([^\r\n\0]+)$/.exec(await readGitPointer(directory, local));
        requireThat(pointer, 'PLUGIN_GIT', '插件 Git 目录指针无效。');
        directory = await noLinks(path.resolve(plugin, pointer[1]));
        entries.push(stamp(`${key}/.git/gitdir`, await lstat(directory)));
    }
    const commonPointer = path.join(directory, 'commondir');
    const commonStat = await lstat(commonPointer);
    let common = directory;
    if (commonStat) {
        entries.push(stamp(`${key}/.git/commondir`, commonStat));
        const pointer = await readGitPointer(commonPointer, commonStat);
        requireThat(pointer && !/[\0\r\n]/.test(pointer), 'PLUGIN_GIT', '插件 Git 公共目录指针无效。');
        common = await noLinks(path.resolve(directory, pointer));
        entries.push(stamp(`${key}/.git/common`, await lstat(common)));
    }
    for (const [base, names] of [[directory, ['HEAD', 'index', 'config.worktree']], [common, ['config', 'packed-refs']]]) {
        for (const name of names) entries.push(stamp(`${key}/.git/${name}`, await lstat(path.join(base, name))));
    }
    const stores = [[common, `${key}/.git`]];
    if (common !== directory) stores.push([directory, `${key}/.git/worktree`]);
    for (const [base, prefix] of stores) {
        for (const name of ['refs', 'reftable']) {
            const storage = path.join(base, name), stat = await lstat(storage);
            entries.push(stamp(`${prefix}/${name}`, stat));
            if (stat?.isDirectory()) await walk(storage, relative => !relative.endsWith('.lock'),
                (_file, relative, child) => entries.push(stamp(`${prefix}/${name}/${relative}`, child)));
        }
    }
    // Git resolves include files and url.insteadOf outside this repository.
    // A single local query captures the same effective origin as snapshot().
    try {
        const { stdout } = await run('git', ['-c', 'safe.directory=*', '-C', plugin, 'remote', 'get-url', 'origin']);
        entries.push([`${key}/.git/origin`, stdout.trim()]);
    } catch (error) {
        if (error.code !== 'PROCESS_FAILED' || error.exitCode !== 2) throw error; // No origin is configured.
    }
}

function isPlugin(root, relative) {
    if (root === 'profile') return /^extensions\/[^/]+$/.test(relative);
    return (root === 'extensions' || root === 'server-plugins') && !relative.includes('/');
}

/** Fast local mutation guard for a stopped USB session. File contents are verified separately. */
export async function usbLocalState(device) {
    const config = await noLinks(device.yamlPath), attributes = await noLinks(path.join(device.state, ATTRIBUTES));
    const initialConfig = stamp('config.yaml', await lstat(config));
    await sharedConfig(device);
    const checkedConfig = stamp('config.yaml', await lstat(config));
    requireThat(initialConfig.join('\0') === checkedConfig.join('\0'), 'CONFIG_CHANGED', '读取期间酒馆配置发生变化，请重试。');
    const entries = [checkedConfig, stamp(ATTRIBUTES, await lstat(attributes))];
    for (const root of await rootsFor(device)) {
        await noLinks(root.path);
        const stat = await lstat(root.path);
        requireThat(!stat || stat.isDirectory(), 'LINK', '同步位置须为真实目录。');
        entries.push(stamp(root.id, stat));
        if (!stat) continue;
        const seen = new Set();
        await walk(root.path, relative => !root.exclude(relative), async (file, relative, child) => {
            portablePath(relative);
            const folded = relative.normalize('NFC').toLowerCase();
            requireThat(!seen.has(folded), 'FILENAME_COLLISION', '文件名存在大小写或 Unicode 冲突。');
            seen.add(folded);
            const key = `${root.id}/${relative}`;
            entries.push(stamp(key, child));
            if (child.isDirectory() && isPlugin(root.id, relative)) await gitStamp(entries, file, key);
        });
    }
    return { digest: digest(entries) };
}
