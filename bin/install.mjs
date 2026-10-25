import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, cliOptions, exists, inside, noLinks, readJson, requireThat, run } from '../lib/io.mjs';
import { copyTree } from '../lib/manifest.mjs';
import { checkCompatibility } from '../adapters/release-1.19.mjs';
import { prepareRepository, repositoryPath } from '../lib/repository.mjs';
import { codeFingerprint, termuxLauncher, windowsLauncher } from './startup.mjs';
import { prepareDependencyCache } from '../lib/dependencies.mjs';

export async function install({ st, state, profile = 'default-user', repository }) {
    requireThat(st && path.isAbsolute(st), 'INSTALL', '请使用 --st 指定酒馆完整路径。');
    const directory = await noLinks(st);
    state = await noLinks(state ?? path.join(path.dirname(directory), `.tavernsyn-${path.basename(directory)}`));
    requireThat(!inside(directory, state, true) && !inside(state, directory, true) && !inside(PROJECT, state, true) && !inside(state, PROJECT, true), 'INSTALL', '设备控制目录必须独立于酒馆及插件发布目录。');
    await checkCompatibility(directory);
    requireThat(!await exists(path.join(state, 'instance.lock')) && !await exists(path.join(state, 'operation.lock')) && !await exists(path.join(state, 'launcher.lock')), 'BUSY', '请先关闭受控酒馆和同步任务再安装或更新。');
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
        const who = (await run('whoami', ['/user', '/fo', 'csv', '/nh'])).stdout.match(/S-1-5-[\d-]+/)?.[0];
        requireThat(who, 'ACL', '无法识别当前 Windows 用户，未创建含密码的设备状态。');
        await run('icacls', [state, '/inheritance:r', '/grant:r', `*${who}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
    } else await fs.chmod(state, 0o700);
    await prepareDependencyCache({ state });
    const configFile = path.join(directory, 'config.yaml');
    requireThat(await exists(configFile), 'INSTALL', '请先完成酒馆首次安装，生成 config.yaml。');
    const YAML = createRequire(path.join(directory, 'package.json'))('yaml');
    const document = YAML.parseDocument(await fs.readFile(configFile, 'utf8'));
    requireThat(document.get('listen') !== true && !document.getIn(['ssl', 'enabled']), 'INSTALL', '首版安装需要本机 HTTP 配置 listen: false。');
    const dataRoot = path.resolve(directory, document.get('dataRoot') ?? './data');
    requireThat(await exists(path.join(dataRoot, profile, 'settings.json')), 'INSTALL', '指定用户尚未初始化，请先正常启动一次酒馆。');
    repository = await repositoryPath(directory, repository, { dataRoot });
    const prepared = await prepareRepository(PROJECT, repository, directory);
    const deviceFile = path.join(state, 'device.json');
    if (await exists(deviceFile)) requireThat((await readJson(deviceFile)).install === directory, 'INSTALL', '控制目录已属于另一个酒馆。');
    else {
        const npmCandidates = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
        let npmCli;
        for (const candidate of npmCandidates) if (await exists(candidate)) { npmCli = candidate; break; }
        await atomicJson(deviceFile, { format: 1, install: directory, profile, deviceId: randomUUID(), deviceName: os.hostname(), restoreDependencies: true, npmCli,
            preserveSettings: [], preserveJson: [], extraRoots: [], tools: process.platform === 'win32' ? { rsync: 'C:/msys64/usr/bin/rsync.exe', ssh: 'C:/msys64/usr/bin/ssh.exe' } : { rsync: 'rsync', ssh: 'ssh' } });
    }
    await loadDevice(state);
    const backup = path.join(state, 'config.before-install.yaml');
    if (!await exists(backup)) await fs.copyFile(configFile, backup);
    const front = path.join(directory, 'public/scripts/extensions/third-party/tavernsyn');
    await fs.mkdir(front, { recursive: true });
    await fs.copyFile(path.join(repository, 'manifest.json'), path.join(front, 'manifest.json'));
    await copyTree(path.join(repository, 'ui'), path.join(front, 'ui'));
    await atomicJson(path.join(repository, '.tavernsyn-install.json'), { state, codeFingerprint: await codeFingerprint(repository) });
    document.set('enableServerPlugins', true);
    const tempConfig = path.join(directory, 'config.tavernsyn-install.tmp');
    await fs.writeFile(tempConfig, document.toString()); await fs.rename(tempConfig, configFile);
    await fs.copyFile(new URL('./startup.mjs', import.meta.url), path.join(directory, 'TavernSyn-Startup.mjs'));
    if (process.platform === 'win32') {
        const script = windowsLauncher({ node: process.execPath, repository, state });
        await fs.writeFile(path.join(directory, 'Start-TavernSyn.cmd'), script);
    } else {
        await fs.writeFile(path.join(directory, 'start-tavernsyn.sh'), termuxLauncher({ node: process.execPath, install: directory, state }), { mode: 0o700 });
    }
    return { state, deviceId: (await readJson(deviceFile)).deviceId, install: directory, ...prepared };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    install(cliOptions()).then(result => console.log(JSON.stringify({ ...result, next: '使用酒馆目录的 TavernSyn 启动入口，在扩展设置中配置 VPS。' }, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
