import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, digest, exists, readJson, requireThat, run, removeOwned } from './io.mjs';
import { scan, copyTree, hashFile, portablePath, seal } from './manifest.mjs';
import { sharedSettings, preserveSettings } from './settings.mjs';
import { CONFIG_POINTERS } from './device.mjs';
import { validateContent } from './content.mjs';

const SHARED = ['_css', '_errors'];
const OMIT_PARTS = new Set(['.git', 'node_modules', '.ssh', '.tailscale', '.tavernsyn-partial']);
const CACHE = new Set(['thumbnails', 'backups', '.cache', '_cache', '_webpack', '_uploads']);
export function excluded(relative) {
    const parts = relative.split('/');
    return parts.some(p => OMIT_PARTS.has(p)) || CACHE.has(parts[0]) || parts[0] === 'tavernsyn'
        || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(parts.at(-1)) || parts.at(-1) === 'tailscaled.state';
}
function absolutePointers(value, prefix = '') {
    if (typeof value === 'string') return /^(?:[A-Za-z]:[\\/]|\/(?:home|root|opt|srv|mnt|storage|sdcard|data\/data|Users|Volumes)\/)/.test(value) ? [prefix] : [];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => absolutePointers(child, `${prefix}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
}
function ownPlugin(relative) { const name = relative.toLowerCase(); return name === 'tavernsyn' || name.startsWith('tavernsyn/'); }
export function getPointer(object, pointer) {
    let value = object;
    for (const part of pointer.slice(1).split('/')) { if (!value || !Object.hasOwn(value, part)) return undefined; value = value[part]; }
    return value;
}
export async function rootsFor(device) {
    return [
        { id: 'profile', path: path.join(device.dataRoot, device.profile), exclude: p => excluded(p) || ownPlugin(p.replace(/^extensions\//, '')) },
        { id: 'extensions', path: path.join(device.install, 'public/scripts/extensions/third-party'), exclude: p => excluded(p) || ownPlugin(p) },
        { id: 'server-plugins', path: path.join(device.install, 'plugins'), exclude: p => excluded(p) || ownPlugin(p) || p === 'package.json' || p === '.gitkeep' },
        ...SHARED.map(id => ({ id: `shared/${id}`, path: path.join(device.dataRoot, id), exclude: excluded })),
        ...device.extraRoots.map(item => ({ id: `extra/${item.id}`, path: item.path, exclude: excluded })),
    ];
}
async function gitInventory(root, relative, metadata, payload, captureGit) {
    const directory = path.join(root.path, relative);
    if (!await exists(path.join(directory, '.git'))) return;
    const gitArgs = ['-c', 'safe.directory=*', '-C', directory];
    const invoke = args => run('git', [...gitArgs, ...args]);
    const commit = (await invoke(['rev-parse', 'HEAD'])).stdout.trim();
    const origin = (await invoke(['remote', 'get-url', 'origin'])).stdout.trim();
    requireThat(/^[a-f0-9]{40,64}$/.test(commit), 'PLUGIN_GIT', '插件 Git 版本无效。');
    requireThat(/^https:\/\//.test(origin) || /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(origin), 'PLUGIN_GIT', '插件仓库须使用无凭据 HTTPS 或 SSH 地址。');
    if (origin.startsWith('https:')) { const url = new URL(origin); requireThat(!url.username && !url.password && !url.search && !url.hash, 'PLUGIN_GIT', '插件仓库地址含凭据或查询参数，请先清理。'); }
    let branch = null;
    try { branch = (await invoke(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim(); } catch { /* detached HEAD is supported */ }
    const id = String(metadata.plugins.length), code = `${root.id}/${relative}`.replace(/\/$/, '');
    const item = { code, commit, branch, origin, gitData: `repositories/${id}/gitdata` };
    metadata.plugins.push(item);
    if (!captureGit) return;
    // Copy only a shallow independent object store; the portable worktree is copied separately.
    const temp = path.join(payload, `repository-temp-${id}`), template = path.join(payload, `empty-template-${id}`);
    await fs.mkdir(template);
    await run('git', ['-c', 'protocol.file.allow=always', 'clone', '--no-local', '--depth=1', '--single-branch', '--no-tags', '--no-checkout', `--template=${template}`, pathToFileURL(directory).href, temp]);
    const cloneArgs = ['-C', temp];
    requireThat((await run('git', [...cloneArgs, 'rev-parse', 'HEAD'])).stdout.trim() === commit, 'PLUGIN_GIT', '创建插件快照时版本改变。');
    await run('git', [...cloneArgs, 'remote', 'set-url', 'origin', origin]);
    const target = path.join(payload, ...item.gitData.split('/')); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(path.join(temp, '.git'), target);
    await removeOwned(payload, temp); await removeOwned(payload, template);
}
export async function snapshot(device, payload, { captureGit = true } = {}) {
    requireThat(!await exists(payload), 'STAGE_EXISTS', '快照目录已存在，拒绝复用未确认的目录。');
    await fs.mkdir(payload, { recursive: true, mode: 0o700 });
    const metadata = { format: 1, sourceVersion: '1.19.0', sourcePlatform: process.platform, sourceArch: process.arch, plugins: [], config: {}, extraRoots: device.extraRoots.map(x => x.id), warnings: [] };
    for (const root of await rootsFor(device)) {
        requireThat(!root.id.startsWith('extra/') || await exists(root.path), 'EMPTY_EXTRA_ROOT', '配置的额外源目录不存在，拒绝把它当作空镜像。');
        if (!await exists(root.path)) continue;
        await copyTree(root.path, path.join(payload, ...root.id.split('/')), { exclude: root.exclude });
        const pluginPath = root.id === 'profile' ? path.join(root.path, 'extensions') : root.path;
        if (['profile', 'extensions', 'server-plugins'].includes(root.id) && await exists(pluginPath)) {
            for (const entry of await fs.readdir(pluginPath, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name !== 'tavernsyn') await gitInventory(root, root.id === 'profile' ? `extensions/${entry.name}` : entry.name, metadata, payload, captureGit);
            }
        }
    }
    const settingsFile = path.join(payload, 'profile/settings.json');
    requireThat(await exists(settingsFile), 'EMPTY_SOURCE', '未发现所选用户的 settings.json，禁止推送空目录。');
    const portableSettings = sharedSettings(await readJson(settingsFile), device.pointers);
    metadata.warnings = absolutePointers(portableSettings).map(pointer => `profile/settings.json#${pointer}`);
    await atomicJson(settingsFile, portableSettings);
    for (const policy of device.preserveJson) {
        portablePath(policy.path); const target = path.join(payload, ...policy.path.split('/'));
        if (await exists(target)) await atomicJson(target, sharedSettings(await readJson(target), policy.pointers));
    }
    for (const pointer of CONFIG_POINTERS) { const value = getPointer(device.stConfig, pointer); if (value !== undefined) metadata.config[pointer] = value; }
    await atomicJson(path.join(payload, 'environment.json'), metadata);
    const manifest = await scan(payload);
    const stateFiles = [];
    for (const f of manifest.files) {
        if (f.path === 'environment.json' || f.path.startsWith('repositories/')) continue;
        const policy = f.path === 'profile/settings.json' ? device.pointers : device.preserveJson.find(p => p.path === f.path)?.pointers;
        stateFiles.push({ path: f.path, sha256: policy ? digest(sharedSettings(await readJson(path.join(payload, ...f.path.split('/'))), policy)) : f.sha256 });
    }
    metadata.sourceState = stateFromFiles(stateFiles);
    await atomicJson(path.join(payload, 'environment.json'), metadata);
    const environment = manifest.files.find(f => f.path === 'environment.json');
    const stat = await fs.stat(path.join(payload, 'environment.json'));
    Object.assign(environment, { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000), sha256: await hashFile(path.join(payload, 'environment.json')) });
    const finalManifest = seal(manifest.files); await validateContent(payload, finalManifest);
    return { manifest: finalManifest, metadata };
}
export function stateFromFiles(files) {
    files = files.map(f => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    return { format: 1, digest: digest(files), files };
}
export async function portableState(device) {
    // Read-only inventory; excludes transport/Git caches and normalizes precise device fields.
    const files = [];
    for (const root of await rootsFor(device)) {
        if (!await exists(root.path)) continue;
        const manifest = await scan(root.path, { exclude: root.exclude });
        for (const file of manifest.files) {
            const key = `${root.id}/${file.path}`;
            const policy = key === 'profile/settings.json' ? device.pointers : device.preserveJson.find(p => p.path === key)?.pointers;
            files.push({ ...file, path: key, sha256: policy ? digest(sharedSettings(await readJson(path.join(root.path, ...file.path.split('/'))), policy)) : file.sha256 });
        }
    }
    // Raw size of transformed JSON is deliberately excluded from the local-change digest.
    return stateFromFiles(files);
}
export async function restoreRepositories(device, payload, candidate) {
    const metadata = await readJson(path.join(payload, 'environment.json'));
    requireThat(metadata.format === 1 && Array.isArray(metadata.plugins) && metadata.plugins.length <= 512, 'PLUGIN_MANIFEST', '插件清单无效。');
    const seen = new Set();
    for (const plugin of metadata.plugins) {
        portablePath(plugin.code); portablePath(plugin.gitData);
        requireThat(/^(extensions\/|server-plugins\/|profile\/extensions\/)/.test(plugin.code) && /^repositories\/\d+\/gitdata$/.test(plugin.gitData) && !seen.has(plugin.code) && /^[a-f0-9]{40,64}$/.test(plugin.commit), 'PLUGIN_MANIFEST', '插件清单含不受支持的路径或版本。'); seen.add(plugin.code);
        const directory = path.join(candidate, ...plugin.code.split('/'));
        requireThat(await exists(directory), 'PLUGIN_MISSING', '插件工作目录缺失。');
        await copyTree(path.join(payload, ...plugin.gitData.split('/')), path.join(directory, '.git'));
        const invoke = args => run('git', ['-C', directory, ...args]);
        requireThat((await invoke(['rev-parse', 'HEAD'])).stdout.trim() === plugin.commit, 'PLUGIN_GIT', '插件 Git 对象版本不匹配。');
        for (const [key, value] of [['core.filemode', 'false'], ['core.autocrlf', 'false'], ['core.ignorecase', process.platform === 'win32' ? 'true' : 'false'], ['core.longpaths', 'true'], ['core.hooksPath', path.join(device.state, 'disabled-hooks')]]) await invoke(['config', key, value]);
        if (plugin.branch) {
            requireThat(!plugin.branch.startsWith('-') && plugin.branch.length <= 200, 'PLUGIN_GIT', '插件分支名无效。');
            await invoke(['check-ref-format', '--branch', plugin.branch]);
            await invoke(['update-ref', `refs/heads/${plugin.branch}`, plugin.commit]); await invoke(['symbolic-ref', 'HEAD', `refs/heads/${plugin.branch}`]);
            await invoke(['config', `branch.${plugin.branch}.remote`, 'origin']); await invoke(['config', `branch.${plugin.branch}.merge`, `refs/heads/${plugin.branch}`]);
        }
        await invoke(['reset', '--mixed', '--quiet', 'HEAD']);
    }
    for (const root of ['server-plugins', 'extensions', 'profile/extensions']) {
        const folder = path.join(candidate, ...root.split('/'));
        if (!await exists(folder)) continue;
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const directory = path.join(folder, entry.name), packageFile = path.join(directory, 'package.json');
            if (!await exists(packageFile)) continue;
            const pkg = await readJson(packageFile);
            if (!Object.keys(pkg.dependencies ?? {}).length && !Object.keys(pkg.optionalDependencies ?? {}).length) continue;
            requireThat(device.restoreDependencies !== false, 'DEPENDENCIES_REQUIRED', '插件需要在本机安装依赖，请开启 restoreDependencies 后重试。');
            // Use Node to execute npm's JS entry point on Windows; never cmd /c with a data-controlled directory.
            const npmCli = device.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
            requireThat(await exists(npmCli), 'DEPENDENCY', '请在设备配置中设置 Node 随附的 npmCli 路径。');
            await run(process.execPath, [npmCli, await exists(path.join(directory, 'package-lock.json')) ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: directory });
        }
    }
    return metadata;
}
