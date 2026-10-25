import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, exists, inside, noLinks, readJson, requireThat, run, SyncError } from './io.mjs';

function redact(text) {
    return text.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, '$1[redacted]@')
        .replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]');
}
function staleLock(output) {
    return /\bEUSAGE\b/.test(output) && /npm ci[\s\S]*can only install packages/.test(output)
        && /package-lock\.json|npm-shrinkwrap\.json/.test(output) && /in sync/.test(output);
}

export async function prepareDependencyCache(device) {
    const cache = path.join(device.state, 'npm-cache');
    try {
        // npm writes temporary downloads and logs below these directories. A
        // writable cache root alone does not prove an existing child is usable.
        for (const relative of ['', '_cacache', '_cacache/tmp', '_logs']) {
            const directory = await noLinks(path.join(cache, relative));
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            await noLinks(directory);
            const probe = path.join(directory, `.tavernsyn-write-${randomUUID()}`);
            const handle = await fs.open(probe, 'wx', 0o600);
            try { await handle.writeFile('cache write check\n'); }
            finally { await handle.close(); await fs.unlink(probe); }
        }
    } catch (error) {
        if (error.code === 'UNSAFE_PATH') throw error;
        throw new SyncError('DEPENDENCY_CACHE', `无法写入 npm 专用缓存（${error.code ?? 'IO'}）：${cache}。请检查该目录的写入权限、文件占用和磁盘空间后重试。`);
    }
    return cache;
}

export async function installPluginDependencies(device, directory, { log = message => console.log(`TavernSyn 依赖：${message}`) } = {}, execute = run) {
    const jobs = path.join(device.state, 'jobs'), relative = path.relative(jobs, directory).split(path.sep);
    requireThat(inside(jobs, directory) && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(relative[0])
        && relative[1] === 'candidate' && /^(extensions\/|server-plugins\/|profile\/extensions\/)/.test(relative.slice(2).join('/')),
    'DEPENDENCY_SCOPE', '插件依赖只能在本次任务的候选目录中准备。');
    await noLinks(directory);
    const code = relative.slice(2).join('/'), packageFile = path.join(directory, 'package.json'), pkg = await readJson(packageFile);
    if (!Object.keys(pkg.dependencies ?? {}).length && !Object.keys(pkg.optionalDependencies ?? {}).length) return { skipped: true };
    requireThat(device.restoreDependencies !== false, 'DEPENDENCIES_REQUIRED', '插件需要在本机安装依赖，请开启 restoreDependencies 后重试。');
    const npmCli = device.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    requireThat(await exists(npmCli), 'DEPENDENCY', '请在设备配置中设置 Node 随附的 npmCli 路径。');
    const logFile = await noLinks(path.join(jobs, relative[0], 'dependencies.log'));
    // The system npm cache can be owned by an administrator or another device.
    // Keep dependency downloads in the private, writable device control directory.
    const cache = await prepareDependencyCache(device);
    async function invoke(command, extra = [], lockOnly = false) {
        let output = '', error;
        log(`${code}：npm ${command}`);
        try {
            await execute(process.execPath, [npmCli, command, ...(lockOnly ? [] : ['--omit=dev']), '--no-audit', '--no-fund', ...extra, '--cache', cache], {
                cwd: directory, onOutput: text => { output = (output + text).slice(-128 * 1024); },
            });
        } catch (failure) { error = failure; }
        await fs.appendFile(logFile, `\n[${new Date().toISOString()}] ${code}: npm ${command}\n${redact(output)}\n`, { mode: 0o600 });
        return { output, error };
    }
    const packageLock = await noLinks(path.join(directory, 'package-lock.json'));
    const shrinkwrap = await noLinks(path.join(directory, 'npm-shrinkwrap.json'));
    const hadShrinkwrap = await exists(shrinkwrap);
    const command = await exists(packageLock) || hadShrinkwrap ? 'ci' : 'install';
    let result = await invoke(command), repairedLock = false;
    if (result.error?.code === 'PROCESS_FAILED' && command === 'ci' && staleLock(result.output)) {
        log(`${code}：依赖锁文件与声明不一致，仅在候选目录重建完整清单，再安装运行依赖；原始下载与 VPS 不变。`);
        // ci validates the entire graph even when dev packages are omitted.
        // Discard only candidate lock files: merging the invalid graph can retain
        // conflicting optional dev entries (observed with npm 11 on Android).
        // The original sealed payload remains available and is never edited.
        for (const file of [packageLock, shrinkwrap]) if (await exists(file)) await fs.unlink(file);
        // Resolve dev metadata without installing it or running build scripts.
        result = await invoke('install', ['--package-lock=true', '--package-lock-only', '--include=dev', '--ignore-scripts'], true);
        if (!result.error) {
            requireThat(await exists(packageLock), 'PLUGIN_DEPENDENCIES', `插件 ${code} 未能生成候选锁文件。详细日志：${logFile}`);
            if (hadShrinkwrap) await fs.rename(packageLock, shrinkwrap);
            result = await invoke('ci');
        }
        repairedLock = true;
    }
    if (result.error) {
        const npmCode = result.output.match(/(?:npm\s+(?:ERR!|error)\s+code\s+)([A-Z][A-Z0-9_]+)/)?.[1];
        const hint = ['EPERM', 'EACCES', 'EBUSY'].includes(npmCode)
            ? '请检查该任务候选目录和 npm 专用缓存的写入权限及文件占用；已保留下载，尚未应用数据。'
            : '';
        throw new SyncError('PLUGIN_DEPENDENCIES', `插件 ${code} 依赖准备失败${npmCode ? `（npm ${npmCode}）` : ''}。${hint}详细日志：${logFile}`);
    }
    requireThat(digest(await readJson(packageFile)) === digest(pkg), 'PLUGIN_DEPENDENCIES', `插件 ${code} 的依赖安装改变了 package.json，保留候选目录并停止应用。`);
    return { repairedLock, logFile };
}
