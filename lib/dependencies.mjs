import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, exists, inside, noLinks, readJson, requireThat, run, SyncError } from './io.mjs';

function redact(text) {
    return text.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, '$1[redacted]@')
        .replace(/((?:authorization|api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s]+/gi, '$1[redacted]');
}
function staleLock(output) {
    return /\bEUSAGE\b/.test(output) && /npm ci[\s\S]*can only install packages/.test(output)
        && /package-lock\.json|npm-shrinkwrap\.json/.test(output) && /in sync/.test(output);
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
    async function invoke(command, extra = [], lockOnly = false) {
        let output = '', error;
        log(`${code}：npm ${command}`);
        try {
            await execute(process.execPath, [npmCli, command, ...(lockOnly ? [] : ['--omit=dev']), '--no-audit', '--no-fund', ...extra], {
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
        throw new SyncError('PLUGIN_DEPENDENCIES', `插件 ${code} 依赖准备失败${npmCode ? `（npm ${npmCode}）` : ''}。详细日志：${logFile}`);
    }
    requireThat(digest(await readJson(packageFile)) === digest(pkg), 'PLUGIN_DEPENDENCIES', `插件 ${code} 的依赖安装改变了 package.json，保留候选目录并停止应用。`);
    return { repairedLock, logFile };
}
