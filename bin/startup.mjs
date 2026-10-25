// Standalone: the installed copy lives outside the backend it can replace.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY = 'https://github.com/anyKami/tavernSyn.git';
const STARTUP = 'TavernSyn-Startup.mjs';
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const exists = async file => !!await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const fail = (code, message) => Object.assign(new Error(message), { code });

export function compareVersions(a, b) {
    const parse = value => /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
    const left = parse(a), right = parse(b);
    if (!left || !right || [...left, ...right].some(n => !Number.isSafeInteger(n))) throw fail('VERSION', '版本号不是稳定版本。');
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
}

export function windowsLauncher({ node, repository, state }) {
    for (const value of [node, repository, state]) if (/["%\r\n!]/.test(value)) throw fail('INSTALL', '启动路径含批处理不支持的字符。');
    return `@echo off\r\nchcp 65001 >nul\r\npushd "%~dp0"\r\nif /I "%~1"=="--desktop-shortcut" goto desktop_shortcut\r\nset NODE_ENV=production\r\n"${node}" "%~dp0${STARTUP}" --st "%~dp0." --state "${state}" %*\r\nset "tavernsyn_exit=%ERRORLEVEL%"\r\npopd\r\nif not "%tavernsyn_exit%"=="0" pause\r\nexit /b %tavernsyn_exit%\r\n:desktop_shortcut\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${path.join(repository, 'bin/create-desktop-shortcut.ps1')}" -LauncherPath "%~f0"\r\nset "tavernsyn_exit=%ERRORLEVEL%"\r\npopd\r\nif not "%tavernsyn_exit%"=="0" pause\r\nexit /b %tavernsyn_exit%\r\n`;
}

export function termuxLauncher({ node, install, state }) {
    const portable = value => process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
    const quote = value => `'${portable(value).replaceAll("'", "'\\''")}'`;
    return `#!/data/data/com.termux/files/usr/bin/sh\ncd ${quote(install)} || exit 1\nexec ${quote(node)} ${quote(portable(install) + '/' + STARTUP)} --st ${quote(install)} --state ${quote(state)} "$@"\n`;
}

export async function codeFingerprint(directory) {
    const files = [];
    async function visit(relative) {
        const file = path.join(directory, relative), stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return;
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw fail('PATH', '后端代码包含不支持的文件类型。');
        if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name));
        else files.push([relative.split(path.sep).join('/'), createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
    }
    for (const name of ['adapters', 'bin', 'helper', 'lib', 'server', 'ui', 'vps', 'index.mjs', 'package.json', 'package-lock.json', 'manifest.json', 'install.ps1', 'install.sh']) await visit(name);
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

async function plain(file) {
    const absolute = path.resolve(file);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = await fs.lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) break;
        if (stat.isSymbolicLink()) throw fail('PATH', '更新路径包含链接，未自动替换代码。');
    }
    return absolute;
}
function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function atomic(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
}
async function command(file, args, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
        let stdout = '', settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.kill(); finish(fail('TIMEOUT', '检查或下载新版本超时。')); }, timeout);
        child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024); });
        child.stderr.resume(); // Do not echo credential-helper or proxy diagnostics.
        child.once('error', () => finish(fail('GIT', '无法启动版本检查所需的程序。')));
        child.once('close', code => finish(code === 0 ? null : fail('GIT', '无法连接版本仓库，或新版本校验失败。'), stdout));
    });
}
async function stopped(install, state) {
    const device = await read(path.join(state, 'device.json'));
    if (path.resolve(device.install) !== install) throw fail('INSTALL', '设备控制目录属于另一份酒馆。');
    for (const name of ['launcher.lock', 'instance.lock', 'operation.lock']) {
        const file = path.join(state, name);
        if (!await exists(file)) continue;
        const lock = await read(file);
        if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw fail('BUSY', '现有运行锁无法核对，请先处理上次任务。');
        try { process.kill(lock.pid, 0); throw fail('BUSY', '酒馆或同步任务仍在运行，请先关闭原启动窗口。'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const YAML = createRequire(path.join(install, 'package.json'))('yaml');
    const config = YAML.parse(await fs.readFile(path.join(install, 'config.yaml'), 'utf8'));
    const port = Number(config.port ?? 8000);
    await new Promise((resolve, reject) => {
        const server = net.createServer(); server.once('error', () => reject(fail('BUSY', '酒馆端口仍被占用，未检查或替换后端。')));
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
    });
}
async function fronts(install) {
    const root = path.join(install, 'public/scripts/extensions/third-party');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const names = entries.filter(entry => entry.name.toLowerCase() === 'tavernsyn');
    if (names.some(entry => !entry.isDirectory()) || names.length > 1) throw fail('PATH', '同步插件前端目录存在冲突，未自动更新。');
    for (const entry of names) await plain(path.join(root, entry.name));
    return { root, name: names[0]?.name ?? 'tavernsyn', existed: names.length === 1 };
}
async function ownedStage(install, stage) {
    stage = await plain(stage);
    if (path.dirname(stage) !== install || !/^\.tavernsyn-update-[a-f0-9-]{36}$/.test(path.basename(stage))) throw fail('JOURNAL', '更新暂存路径无效。');
    return stage;
}
async function rollback(install, journal) {
    const stage = await ownedStage(install, journal.stage), backend = path.join(install, 'plugins/tavernsyn');
    const front = await fronts(install), oldBackend = path.join(stage, 'old-backend'), oldFront = path.join(stage, 'old-front');
    if (typeof journal.frontName !== 'string' || journal.frontName.toLowerCase() !== 'tavernsyn' || typeof journal.hadFront !== 'boolean') throw fail('JOURNAL', '更新前端记录无效。');
    await plain(backend);
    await plain(oldBackend); await plain(oldFront);
    if (await exists(oldBackend)) {
        if (await exists(backend)) await fs.rename(backend, path.join(stage, `failed-backend-${randomUUID()}`));
        await fs.rename(oldBackend, backend);
    } else if (!await exists(backend)) throw fail('RECOVERY_REQUIRED', '原后端副本缺失，保留更新记录以便恢复。');
    if (await exists(oldFront)) {
        if (front.existed) await fs.rename(path.join(front.root, front.name), path.join(stage, `failed-front-${randomUUID()}`));
        await fs.rename(oldFront, path.join(front.root, journal.frontName));
    } else if (!journal.hadFront && front.existed) await fs.rename(path.join(front.root, front.name), path.join(stage, `failed-front-${randomUUID()}`));
}
async function recoverUpdate(install, state) {
    const file = path.join(state, 'startup-update.json');
    if (!await exists(file)) return;
    const journal = await read(file);
    if (journal.format !== 1 || journal.install !== install) throw fail('JOURNAL', '后端更新记录与当前安装不匹配。');
    await ownedStage(install, journal.stage);
    if (journal.phase !== 'committed') await rollback(install, journal);
    await fs.unlink(file);
}

export async function autoUpdate({ install, state, repositoryUrl = REPOSITORY, checkTimeout = 8000, skipCheck = false, log = console.log, afterRename = () => {} }) {
    install = await plain(install); state = await plain(state);
    if (inside(install, state) || inside(state, install) || state === install) throw fail('INSTALL', '设备控制目录必须独立于酒馆。');
    await stopped(install, state);
    const lockFile = await plain(path.join(state, 'startup-update.lock'));
    let lock;
    try { lock = await fs.open(lockFile, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const previous = await read(lockFile);
        if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw fail('BUSY', '另一个启动更新正在进行。');
        try { process.kill(previous.pid, 0); throw fail('BUSY', '另一个启动更新正在进行。'); }
        catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
        await fs.unlink(lockFile); lock = await fs.open(lockFile, 'wx', 0o600);
    }
    const nonce = randomUUID(); await lock.writeFile(JSON.stringify({ pid: process.pid, nonce })); await lock.close();
    try {
        await recoverUpdate(install, state);
        const backend = await plain(path.join(install, 'plugins/tavernsyn'));
        const metadata = await read(path.join(backend, '.tavernsyn-install.json')), local = await read(path.join(backend, 'package.json'));
        if (path.resolve(metadata.state) !== state || local.name !== 'tavernsyn') throw fail('INSTALL', '当前后端与启动入口不匹配。');
        if (skipCheck) { log(`已跳过版本检查，启动后端 ${local.version}。`); return { status: 'skipped', version: local.version }; }
        const status = await read(path.join(state, 'status.json')).catch(error => { if (error.code === 'ENOENT') return { phase: 'IDLE' }; throw error; });
        if (!['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED'].includes(status.phase)) {
            log(`TavernSyn ${local.version}：保留待处理同步任务，本次跳过更新。`); return { status: 'protected', version: local.version };
        }
        let modified = false;
        if (metadata.codeFingerprint) modified = await codeFingerprint(backend) !== metadata.codeFingerprint;
        else if (await exists(path.join(backend, '.git'))) {
            try { modified = !!(await command('git', ['-C', backend, 'status', '--porcelain'])).trim(); }
            catch { log('无法核对本机代码状态，本次跳过更新。'); return { status: 'unavailable', version: local.version }; }
        }
        if (modified) {
            log(`TavernSyn ${local.version}：后端有本机代码修改，本次保留并跳过自动更新。`); return { status: 'modified', version: local.version };
        }
        log(`TavernSyn 当前后端：${local.version}，正在检查 GitHub 稳定版本…`);
        let stage, journal;
        try {
            const refs = await command('git', ['ls-remote', '--tags', '--refs', repositoryUrl, 'refs/tags/v*'], checkTimeout);
            const releases = refs.split(/\r?\n/).flatMap(line => { const match = /^([a-f0-9]{40,64})\s+refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line); return match ? [{ revision: match[1], version: match[2] }] : []; });
            releases.sort((a, b) => compareVersions(b.version, a.version));
            const latest = releases[0];
            if (!latest) throw fail('VERSION', '仓库暂无可识别的稳定版本标签。');
            if (compareVersions(latest.version, local.version) <= 0) {
                log(`后端 ${local.version} 已是当前稳定版本，开始启动酒馆。`); return { status: 'current', version: local.version };
            }
            log(`发现后端 ${latest.version}，正在下载并准备更新…`);
            stage = await fs.mkdtemp(path.join(install, '.tavernsyn-update-'));
            // Use UUID-only stage names so recovery accepts no arbitrary directory.
            const named = path.join(install, `.tavernsyn-update-${randomUUID()}`); await fs.rename(stage, named); stage = named;
            await ownedStage(install, stage);
            const source = path.join(stage, 'source');
            await command('git', ['clone', '--depth', '1', '--single-branch', '--branch', `v${latest.version}`, '--no-checkout', repositoryUrl, source], 60000);
            if ((await command('git', ['-C', source, 'rev-parse', `refs/tags/v${latest.version}`])).trim() !== latest.revision) throw fail('VERSION', '下载期间版本标签发生变化，未更新。');
            // Keep the verified tag's exact code while retaining the documented
            // manual upgrade path: git pull --ff-only, then rerun the installer.
            await command('git', ['-C', source, 'checkout', '-b', 'main', `refs/tags/v${latest.version}`]);
            await command('git', ['-C', source, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main']);
            await command('git', ['-C', source, 'config', 'branch.main.remote', 'origin']);
            await command('git', ['-C', source, 'config', 'branch.main.merge', 'refs/heads/main']);
            const pkg = await read(path.join(source, 'package.json')), manifest = await read(path.join(source, 'manifest.json'));
            if (pkg.name !== 'tavernsyn' || pkg.version !== latest.version || manifest.version !== latest.version || pkg.main !== 'index.mjs') throw fail('VERSION', '新版本的包与前端版本标识不一致。');
            if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.optionalDependencies ?? {}).length) throw fail('DEPENDENCIES', '新版本需要额外后端依赖，请运行安装脚本升级。');
            for (const file of ['index.mjs', 'helper/launcher.mjs', 'helper/bootstrap.mjs', 'server/index.mjs', 'ui/index.js']) await command(process.execPath, ['--check', path.join(source, file)]);
            const nextFront = path.join(stage, 'new-front'); await fs.mkdir(nextFront);
            await fs.copyFile(path.join(source, 'manifest.json'), path.join(nextFront, 'manifest.json'));
            await fs.cp(path.join(source, 'ui'), path.join(nextFront, 'ui'), { recursive: true });
            await atomic(path.join(source, '.tavernsyn-install.json'), JSON.stringify({ ...metadata, codeFingerprint: await codeFingerprint(source) }, null, 2) + '\n');
            const front = await fronts(install); await fs.mkdir(front.root, { recursive: true });
            await stopped(install, state);
            journal = { format: 1, install, stage, frontName: front.name, hadFront: front.existed, phase: 'prepared', version: latest.version };
            const journalFile = path.join(state, 'startup-update.json'); await atomic(journalFile, JSON.stringify(journal));
            await fs.rename(backend, path.join(stage, 'old-backend')); await afterRename('backend-backup');
            if (front.existed) { await fs.rename(path.join(front.root, front.name), path.join(stage, 'old-front')); await afterRename('front-backup'); }
            await fs.rename(source, backend); await afterRename('backend-installed');
            await fs.rename(nextFront, path.join(front.root, front.name)); await afterRename('front-installed');
            journal.phase = 'committed'; await atomic(journalFile, JSON.stringify(journal));
            if (await exists(path.join(backend, 'bin/startup.mjs'))) await atomic(path.join(install, STARTUP), await fs.readFile(path.join(backend, 'bin/startup.mjs')));
            // Keep one previous code version; user data and credentials never move.
            const previous = await plain(path.join(install, '.tavernsyn-previous-code'));
            if (await exists(previous)) {
                const marker = await read(path.join(previous, 'startup-backup.json'));
                if (marker.format !== 1 || marker.install !== install) throw fail('PATH', '上一版代码目录未能确认归属。');
                if (!inside(install, previous)) throw fail('PATH', '上一版代码目录越界。');
                await fs.rm(previous, { recursive: true, force: true });
            }
            await atomic(path.join(stage, 'startup-backup.json'), JSON.stringify({ format: 1, install }));
            await fs.rename(stage, previous); await fs.unlink(journalFile);
            log(`后端已更新：${local.version} → ${latest.version}，开始启动酒馆。`);
            return { status: 'updated', version: latest.version };
        } catch (error) {
            if (journal?.phase === 'committed') {
                log('后端更新已完成；上一版代码保留在更新暂存目录。');
                return { status: 'updated', version: journal.version };
            }
            if (journal) {
                try { await rollback(install, journal); await fs.unlink(path.join(state, 'startup-update.json')); }
                catch { throw fail('RECOVERY_REQUIRED', '后端更新未能恢复原版本，已保留副本和记录，请先处理后再启动。'); }
            }
            log(`自动更新未完成（${error.code ?? 'UPDATE'}），继续启动原后端 ${local.version}。`);
            return { status: 'unavailable', version: local.version };
        }
    } finally {
        if ((await read(lockFile).catch(() => ({}))).nonce === nonce) await fs.unlink(lockFile);
    }
}

export async function reuseRunning(install, state) {
    const file = path.join(state, 'instance.lock');
    if (!await exists(file)) return false;
    const instance = await read(file);
    if (path.resolve(instance.install) !== install) throw fail('BUSY', '当前实例绑定了另一份酒馆。');
    const YAML = createRequire(path.join(install, 'package.json'))('yaml');
    const config = YAML.parse(await fs.readFile(path.join(install, 'config.yaml'), 'utf8'));
    const origin = `http://127.0.0.1:${Number(config.port ?? 8000)}`;
    let response;
    try { response = await fetch(origin + '/', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000) }); }
    catch { return false; }
    // Login redirects/403s are normal before a browser has authenticated. The
    // bootstrap header identifies the owned process without accessing user APIs.
    if (!/^[a-f0-9-]{36}$/.test(instance.nonce ?? '') || response.headers.get('x-tavernsyn-epoch') !== instance.nonce) throw fail('BUSY', '现有服务的受控实例标识不匹配，未启动重复酒馆。');
    console.log(`受控酒馆已在运行：${origin}；关闭原启动窗口后，再次启动即可检查更新。`);
    try {
        const { openBrowser } = await import(pathToFileURL(path.join(install, 'plugins/tavernsyn/helper/browser.mjs')).href);
        await openBrowser(origin);
    } catch { console.log(`请在浏览器打开 ${origin}`); }
    return true;
}

async function main() {
    const args = process.argv.slice(2), option = name => {
        const index = args.indexOf(name);
        if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw fail('ARGUMENT', `缺少 ${name} 参数。`);
        return args[index + 1];
    };
    const install = await plain(option('--st')), state = await plain(option('--state'));
    if (await reuseRunning(install, state)) return;
    await autoUpdate({ install, state, skipCheck: args.includes('--skip-update') });
    const entry = path.join(install, 'plugins/tavernsyn/helper/launcher.mjs');
    // Import in this same process: closing the terminal still closes its launcher.
    process.argv = [process.execPath, entry, '--state', state, '--open-browser', 'yes'];
    await import(pathToFileURL(entry).href);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`TavernSyn：${error.message}`); process.exitCode = 1; });
}
