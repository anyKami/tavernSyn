import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exists, inside, noLinks, readJson, renamePath, requireThat } from './io.mjs';
import { copyTree } from './manifest.mjs';

const CODE_FOLDERS = ['adapters', 'bin', 'helper', 'lib', 'server', 'ui', 'vps', 'docs', 'tests', 'probes', '.github'];
const CODE_FILES = ['package.json', 'package-lock.json', 'index.mjs', 'manifest.json', 'install.ps1', 'install.sh', 'README.md',
    'device.example.json', '.gitattributes', '.gitignore', 'LICENSE'];

export async function repositoryPath(install, requested, { dataRoot, extraRoots = [] } = {}) {
    const standard = path.join(install, 'plugins/tavernsyn');
    const repository = await noLinks(path.resolve(requested ?? standard));
    requireThat(path.relative(standard, repository) === '', 'INSTALL', 'TavernSyn 代码统一安装到酒馆的 plugins/tavernsyn 目录，请省略自定义仓库路径。');
    const reserved = [dataRoot, ...extraRoots.map(item => item.path)].filter(Boolean);
    for (const root of reserved) requireThat(!inside(root, repository, true) && !inside(repository, root, true),
        'INSTALL', 'TavernSyn 代码目录不能与用户数据或额外同步目录重叠。');
    return repository;
}

export async function prepareRepository(source, destination, install) {
    source = await noLinks(source); destination = await noLinks(destination);
    requireThat(path.relative(path.join(install, 'plugins/tavernsyn'), destination) === '', 'INSTALL', '代码必须安装到酒馆的 plugins/tavernsyn 目录。');
    requireThat((await readJson(path.join(source, 'package.json'))).name === 'tavernsyn', 'INSTALL', '安装源不是 TavernSyn。');
    if (source === destination) return { repository: destination };
    // Copy only release code. Never bring along local credentials, jobs, caches or node_modules.
    for (const name of CODE_FOLDERS) requireThat(!inside(path.join(source, name), destination, true), 'INSTALL', '目标代码目录不能位于安装源的组件目录内。');
    if (await exists(destination)) {
        const entries = await fs.readdir(destination);
        const wrapper = entries.length === 1 && entries[0] === 'index.mjs'
            ? await fs.readFile(path.join(destination, 'index.mjs'), 'utf8') : '';
        const legacy = /^process\.env\.TAVERNSYN_STATE = ("(?:[^"\\]|\\.)*");\s*const plugin = await import\(("(?:[^"\\]|\\.)*")\);\s*export const \{ info, init, exit \} = plugin;\s*$/.exec(wrapper);
        const owned = (await readJson(path.join(destination, 'package.json')).catch(() => ({}))).name === 'tavernsyn';
        requireThat(owned || (legacy && JSON.parse(legacy[2]).endsWith('/server/index.mjs')), 'INSTALL', '目标目录已存在且不是 TavernSyn，未覆盖。');
    }
    // Keep staging and backups out of plugins: SillyTavern loads every directory there.
    const stage = path.join(install, `.tavernsyn-code-install-${randomUUID()}`), backup = path.join(install, `.tavernsyn-code-backup-${randomUUID()}`);
    for (const file of [stage, backup]) {
        requireThat(inside(install, path.resolve(file)), 'INSTALL', '代码暂存或备份目录超出酒馆目录。');
        await noLinks(file);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.mkdir(stage, { mode: 0o700 });
    for (const name of CODE_FOLDERS) if (await exists(path.join(source, name))) await copyTree(path.join(source, name), path.join(stage, name));
    for (const name of CODE_FILES) if (await exists(path.join(source, name))) {
        await noLinks(path.join(source, name)); await fs.copyFile(path.join(source, name), path.join(stage, name));
    }
    let hadOld = false, movedGit = false;
    try {
        if (await exists(destination)) {
            await renamePath(destination, backup); hadOld = true;
            if (await exists(path.join(backup, '.git'))) {
                await noLinks(path.join(backup, '.git'));
                requireThat((await fs.stat(path.join(backup, '.git'))).isDirectory(), 'INSTALL', '不自动搬迁 Git worktree，请使用普通代码目录。');
                await renamePath(path.join(backup, '.git'), path.join(stage, '.git')); movedGit = true;
            }
        }
        await renamePath(stage, destination);
    } catch (error) {
        if (movedGit) await renamePath(path.join(stage, '.git'), path.join(backup, '.git'));
        if (hadOld) await renamePath(backup, destination);
        throw error;
    }
    return { repository: destination, ...(hadOld ? { repositoryBackup: backup } : {}) };
}
