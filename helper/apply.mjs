import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, exists, inside, noLinks, readJson, requireThat, removeOwned, renamePath } from '../lib/io.mjs';
import { copyTree, verify } from '../lib/manifest.mjs';
import { preserveSettings } from '../lib/settings.mjs';
import { CONFIG_POINTERS } from '../lib/device.mjs';
import { restoreRepositories, rootsFor, preparePluginDependencies } from '../lib/snapshot.mjs';
import { enoughSpace, validateContent } from '../lib/content.mjs';
import { ATTRIBUTES, applyExecutables, gitExecutables, validateExecutables } from '../lib/file-attributes.mjs';
import { inScope, normalizeScope, sameScope } from '../lib/scope.mjs';

async function flushTree(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue; // Only locally generated dependency links can exist here.
        if (entry.isDirectory()) await flushTree(file);
        else {
            const handle = await fs.open(file, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
        }
    }
    if (process.platform !== 'win32') {
        const handle = await fs.open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }
}

export async function prepare(device, payload, manifest, jobRoot, { scope = null } = {}) {
    scope = normalizeScope(scope);
    await verify(payload, manifest);
    await validateContent(payload, manifest, { scope }); await enoughSpace(device.state, manifest.bytes, 1);
    const environment = await readJson(path.join(payload, 'environment.json'));
    requireThat(sameScope(environment.scope, scope), 'PAYLOAD_SCOPE', '下载范围与任务不一致，未应用。');
    const candidate = path.join(jobRoot, 'candidate');
    requireThat(!await exists(candidate), 'CANDIDATE_EXISTS', '候选目录已存在，请先处理之前的恢复记录。');
    await copyTree(payload, candidate, { exclude: p => p === 'repositories' || p.startsWith('repositories/') });
    const metadata = scope ? environment : await restoreRepositories(device, payload, candidate);
    // Legacy snapshots have no execution metadata. Git index modes can still
    // recover tracked scripts; arbitrary legacy files cannot be inferred safely.
    metadata.executables = metadata.executables === undefined
        ? [...new Set((await Promise.all(metadata.plugins.map(p => gitExecutables(path.join(candidate, ...p.code.split('/')), p.code)))).flat())]
        : validateExecutables(metadata.executables, manifest);
    await applyExecutables(candidate, metadata.executables, manifest);
    // Attachments/custom user data are portable content, not plugin runtime.
    const nativeFiles = manifest.files.filter(f => /^(?:extensions|server-plugins|profile\/extensions)\/[^/]+\//.test(f.path)
        && /\.(?:exe|dll|node|so(?:\.\d+)*|dylib)$/i.test(f.path));
    requireThat(!nativeFiles.length || (metadata.sourcePlatform === process.platform && metadata.sourceArch === process.arch), 'NATIVE_RESOURCE', '插件包含跨平台二进制资源。请在目标平台单独安装对应资源后，再重新准备同步。');
    requireThat((metadata.extraRoots ?? []).every(id => device.extraRoots.some(x => x.id === id)), 'EXTRA_ROOT', '远端包含本机尚未映射的自定义目录，请先配置映射。');
    if (!scope) await preparePluginDependencies(device, candidate);
    return { candidate, metadata, scope };
}
async function preserveFile(source, target) {
    if (!await exists(source)) return;
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(source, target);
}
async function syncDirectories(root) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    return entries.filter(entry => entry.isDirectory() && entry.name.toLowerCase() === 'tavernsyn').map(entry => entry.name);
}
export async function buildPlan(device, prepared, jobRoot) {
    if (prepared.scope) return buildScopedPlan(device, prepared, jobRoot);
    const { candidate, metadata } = prepared;
    const settings = path.join(candidate, 'profile/settings.json'), localSettings = path.join(device.dataRoot, device.profile, 'settings.json');
    await atomicJson(settings, preserveSettings(await readJson(settings), await readJson(localSettings), device.pointers));
    for (const policy of device.preserveJson) {
        const next = path.join(candidate, ...policy.path.split('/'));
        const roots = await rootsFor(device); const root = roots.find(r => policy.path.startsWith(`${r.id}/`));
        requireThat(root, 'CONFIG', '本机 JSON 字段策略不在同步范围内。');
        const local = path.join(root.path, ...policy.path.slice(root.id.length + 1).split('/'));
        if (await exists(next) && await exists(local)) await atomicJson(next, preserveSettings(await readJson(next), await readJson(local), policy.pointers));
    }
    // Synchronization code and local loader format never come from the remote mirror.
    for (const [relative, target] of [['plugins', 'server-plugins'], ['public/scripts/extensions/third-party', 'extensions']]) {
        const root = path.join(device.install, ...relative.split('/'));
        for (const name of await syncDirectories(root)) await copyTree(path.join(root, name), path.join(candidate, target, name));
    }
    await preserveFile(path.join(device.install, 'plugins/package.json'), path.join(candidate, 'server-plugins/package.json'));
    const document = device.YAML.parseDocument(await fs.readFile(device.yamlPath, 'utf8'));
    for (const pointer of CONFIG_POINTERS) if (Object.hasOwn(metadata.config ?? {}, pointer)) document.setIn(pointer.slice(1).split('/'), metadata.config[pointer]);
    document.setIn(['enableServerPlugins'], true);
    const nextConfig = path.join(candidate, 'config.yaml'); await fs.writeFile(nextConfig, document.toString(), { mode: 0o600 });
    const nextAttributes = path.join(candidate, ATTRIBUTES);
    await atomicJson(nextAttributes, { format: 1, executables: metadata.executables });
    const recovery = path.join(device.state, 'recovery');
    requireThat(!await exists(recovery), 'RECOVERY_EXISTS', '存在上一次恢复数据，请完成上次任务或明确归档后重试。');
    const steps = [];
    for (const root of await rootsFor(device)) {
        const next = path.join(candidate, ...root.id.split('/'));
        if (!await exists(next)) await fs.mkdir(next, { recursive: true }); // Mirrors deletion of previously populated shared/plugin roots.
        const destinationParent = await fs.stat(path.dirname(root.path)); const stageStat = await fs.stat(next);
        requireThat(destinationParent.dev === stageStat.dev && path.parse(root.path).root.toLowerCase() === path.parse(next).root.toLowerCase(), 'VOLUME', '安全替换要求工作区与目标位于同一文件系统。');
        steps.push({ live: root.path, next, old: path.join(recovery, String(steps.length)), hadOld: await exists(root.path), phase: 'planned' });
    }
    steps.push({ live: device.yamlPath, next: nextConfig, old: path.join(recovery, 'config.yaml'), hadOld: true, phase: 'planned' });
    steps.push({ live: path.join(device.state, ATTRIBUTES), next: nextAttributes, old: path.join(recovery, ATTRIBUTES), hadOld: await exists(path.join(device.state, ATTRIBUTES)), phase: 'planned' });
    await flushTree(candidate);
    await fs.mkdir(recovery, { mode: 0o700 });
    const journal = { format: 2, jobRoot, candidate, recovery, phase: 'prepared', steps };
    await atomicJson(path.join(device.state, 'apply.json'), journal); return journal;
}
export async function validatePlan(device, journal) {
    const scope = journal.format === 3 ? normalizeScope(journal.scope) : null;
    requireThat(journal.format !== 3 || scope, 'JOURNAL', '分类恢复记录缺少范围。');
    const allowed = [...(await rootsFor(device, { scope })).map(r => path.resolve(r.path)),
        ...(!scope ? [path.resolve(device.yamlPath)] : []), ...([2, 3].includes(journal.format) ? [path.join(device.state, ATTRIBUTES)] : [])];
    requireThat([1, 2, 3].includes(journal.format) && Array.isArray(journal.steps) && journal.steps.length === allowed.length, 'JOURNAL', '恢复记录格式无效。');
    requireThat(new Set(journal.steps.map(s => path.resolve(s.live))).size === allowed.length && new Set(journal.steps.map(s => s.old)).size === allowed.length, 'JOURNAL', '恢复记录存在重复目标。');
    for (const step of journal.steps) {
        requireThat(allowed.includes(path.resolve(step.live)) && inside(path.join(device.state, 'jobs'), step.next) && inside(path.join(device.state, 'recovery'), step.old), 'JOURNAL', '恢复记录含越界路径。');
        await noLinks(step.live); await noLinks(step.next); await noLinks(step.old);
    }
}
async function buildScopedPlan(device, { candidate, metadata, scope }, jobRoot) {
    scope = normalizeScope(scope);
    requireThat(sameScope(metadata.scope, scope), 'PAYLOAD_SCOPE', '候选目录范围不匹配。');
    for (const policy of device.preserveJson) {
        if (!inScope(policy.path, scope)) continue;
        const next = path.join(candidate, ...policy.path.split('/'));
        const local = path.join(device.dataRoot, device.profile, ...policy.path.slice('profile/'.length).split('/'));
        if (await exists(next) && await exists(local)) await atomicJson(next, preserveSettings(await readJson(next), await readJson(local), policy.pointers));
    }
    const attributesFile = path.join(device.state, ATTRIBUTES);
    const oldAttributes = await exists(attributesFile) ? await readJson(attributesFile) : { format: 1, executables: [] };
    requireThat(oldAttributes.format === 1, 'FILE_ATTRIBUTES', '本机文件属性记录无效。');
    const executables = validateExecutables([...validateExecutables(oldAttributes.executables).filter(name => !inScope(name, scope)), ...metadata.executables]);
    const nextAttributes = path.join(candidate, ATTRIBUTES);
    await atomicJson(nextAttributes, { format: 1, executables });
    const recovery = path.join(device.state, 'recovery');
    requireThat(!await exists(recovery), 'RECOVERY_EXISTS', '存在上一次恢复数据，请先处理。');
    const steps = [];
    for (const root of await rootsFor(device, { scope })) {
        const next = path.join(candidate, ...root.id.split('/'));
        await fs.mkdir(next, { recursive: true, mode: 0o700 });
        const parent = await fs.stat(path.dirname(root.path)), stage = await fs.stat(next);
        requireThat(parent.dev === stage.dev && path.parse(root.path).root.toLowerCase() === path.parse(next).root.toLowerCase(), 'VOLUME', '安全替换要求候选与目标位于同一文件系统。');
        steps.push({ live: root.path, next, old: path.join(recovery, String(steps.length)), hadOld: await exists(root.path), phase: 'planned' });
    }
    steps.push({ live: attributesFile, next: nextAttributes, old: path.join(recovery, ATTRIBUTES), hadOld: await exists(attributesFile), phase: 'planned' });
    await flushTree(candidate); await fs.mkdir(recovery, { mode: 0o700 });
    const journal = { format: 3, scope, jobRoot, candidate, recovery, phase: 'prepared', steps };
    await atomicJson(path.join(device.state, 'apply.json'), journal);
    return journal;
}
export async function applyPlan(device, journal, { afterRename } = {}) {
    await validatePlan(device, journal);
    journal.phase = 'applying'; await atomicJson(path.join(device.state, 'apply.json'), journal);
    for (const step of journal.steps) {
        step.phase = 'moving-old'; await atomicJson(path.join(device.state, 'apply.json'), journal);
        if (step.hadOld) await renamePath(step.live, step.old);
        await afterRename?.(step, 'old');
        step.phase = 'moving-new'; await atomicJson(path.join(device.state, 'apply.json'), journal);
        await renamePath(step.next, step.live);
        await afterRename?.(step, 'new');
        step.phase = 'installed'; await atomicJson(path.join(device.state, 'apply.json'), journal);
    }
    journal.phase = 'applied'; await atomicJson(path.join(device.state, 'apply.json'), journal);
}
export async function rollback(device, journal) {
    await validatePlan(device, journal);
    journal.phase = 'rolling-back'; await atomicJson(path.join(device.state, 'apply.json'), journal);
    for (const step of [...journal.steps].reverse()) {
        const old = await exists(step.old), live = await exists(step.live), next = await exists(step.next);
        if (old) {
            if (live && !next) await renamePath(step.live, step.next);
            else requireThat(!live, 'RECOVERY_REQUIRED', '恢复位置存在两个候选，已停止自动回滚。');
            await renamePath(step.old, step.live);
        } else if (!step.hadOld && live && !next) await renamePath(step.live, step.next);
        else requireThat(live || !step.hadOld, 'RECOVERY_REQUIRED', '原数据和备份均未找到，请手动恢复。');
        step.phase = 'restored'; await atomicJson(path.join(device.state, 'apply.json'), journal);
    }
    journal.phase = 'rolled-back'; await atomicJson(path.join(device.state, 'apply.json'), journal);
    // An empty recovery directory can be removed. Payload/candidate remain available for diagnosis.
    if (!(await fs.readdir(journal.recovery)).length) await removeOwned(device.state, journal.recovery);
}
export async function commitPlan(device, journal) {
    const committed = { ...journal, phase: 'committed', committedAt: new Date().toISOString() };
    try { await atomicJson(path.join(device.state, 'apply.json'), committed); }
    catch (error) { if (!error.atomicCommitted) throw error; }
    Object.assign(journal, committed);
}
export async function recoveryStatus(device) {
    const file = path.join(device.state, 'apply.json');
    if (!await exists(file)) return { available: false };
    try {
        const journal = await readJson(file);
        if (journal.phase !== 'committed') return { available: false };
        await validatePlan(device, journal);
        for (const step of journal.steps) if (await exists(step.old) !== step.hadOld || await exists(step.next)) return { available: false };
        return { available: true, created: journal.committedAt ?? (await fs.stat(file)).mtime.toISOString(), ...(journal.scope ? { scope: journal.scope } : {}) };
    } catch { return { available: false, reason: '恢复记录或副本异常，请先查看恢复说明。' }; }
}
export async function preserveSyncCode(device, journal) {
    // Manual restore keeps the currently installed synchronization entry points.
    await validatePlan(device, journal);
    for (const live of [path.join(device.install, 'plugins'), path.join(device.install, 'public/scripts/extensions/third-party')]) {
        const step = journal.steps.find(item => item.live === live);
        if (step?.hadOld) for (const name of await syncDirectories(live)) {
            const target = path.join(step.old, name);
            // Git objects can be read-only. Replace this owned code directory rather
            // than overwriting existing objects or retaining removed source files.
            if (await exists(target)) await removeOwned(step.old, target);
            await copyTree(path.join(live, name), target);
        }
    }
}
export async function retireRecovery(device) {
    // Only called before a new operation after verifying the previous transaction was healthy.
    const file = path.join(device.state, 'apply.json');
    if (!await exists(file)) return;
    const journal = await readJson(file);
    requireThat(['committed', 'rolled-back'].includes(journal.phase), 'RECOVERY_REQUIRED', '上次应用尚未完成，禁止启动新任务。');
    await validatePlan(device, journal);
    if (await exists(path.join(device.state, 'recovery'))) await removeOwned(device.state, path.join(device.state, 'recovery'));
    await fs.rename(file, path.join(device.state, 'last-apply.json'));
}
