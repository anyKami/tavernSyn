import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { install } from './install.mjs';
import { windowsRuntime } from './windows-runtime.mjs';
import { recoverStopped } from './recover.mjs';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { configuration } from '../lib/connection.mjs';
import { repositoryPath } from '../lib/repository.mjs';
import { atomicJson, cliOptions, exists, inside, noLinks, readJson, requireThat, run } from '../lib/io.mjs';

async function windowsTools(directory) {
    if (!directory || !path.isAbsolute(directory)) return null;
    if (!(await Promise.all(['ssh.exe', 'rsync.exe', 'sh.exe', 'cygpath.exe', 'msys-2.0.dll']
        .map(name => exists(path.join(directory, name))))).every(Boolean)) return null;
    return { ssh: path.join(directory, 'ssh.exe'), rsync: path.join(directory, 'rsync.exe') };
}
export async function setupDevice(options) {
    requireThat(Number(process.versions.node.split('.')[0]) >= 20, 'NODE', '需要 Node.js 20 或以上版本。');
    requireThat(options.st, 'INSTALL', '请指定酒馆目录。');
    const st = await noLinks(path.resolve(options.st));
    const state = await noLinks(path.resolve(options.state ?? path.join(path.dirname(st), `.tavernsyn-${path.basename(st)}`)));
    requireThat(!inside(st, state, true) && !inside(state, st, true) && !inside(PROJECT, state, true) && !inside(state, PROJECT, true), 'INSTALL', '设备控制目录必须独立于酒馆和同步插件仓库。');
    const YAML = createRequire(path.join(st, 'package.json'))('yaml');
    const config = YAML.parse(await fs.readFile(path.join(st, 'config.yaml'), 'utf8'));
    const dataRoot = await noLinks(path.resolve(st, config.dataRoot ?? './data'));
    requireThat(!inside(dataRoot, state, true) && !inside(state, dataRoot, true), 'INSTALL', '设备控制目录不能与酒馆数据目录重叠。');
    const port = Number(config.port ?? 8000);
    requireThat(Number.isInteger(port) && port > 0 && port < 65536, 'CONFIG', '酒馆端口无效。');
    const savedFile = path.join(state, 'device.json');
    const previous = await exists(savedFile) ? await loadDevice(state) : null;
    const repository = await repositoryPath(st, options.repository, { dataRoot, extraRoots: previous?.extraRoots });
    requireThat(!previous || previous.install === st, 'INSTALL', '设备控制目录已属于另一个酒馆。');
    requireThat(!previous || !options.profile || options.profile === previous.profile, 'INSTALL', '已有设备绑定其他用户，不能通过重装切换。');
    for (const name of ['launcher.lock', 'instance.lock', 'operation.lock']) {
        if (await exists(path.join(state, name))) { await recoverStopped({ state, origin: `http://127.0.0.1:${port}` }); break; }
    }
    await new Promise((resolve, reject) => {
        const probe = net.createServer(); probe.once('error', () => reject(new Error('酒馆仍在运行或端口被占用，请关闭后再安装。')));
        probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
    const status = await exists(path.join(state, 'status.json')) ? await readJson(path.join(state, 'status.json')) : { phase: 'IDLE' };
    requireThat(['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED'].includes(status.phase), 'BUSY', '请先完成待应用、恢复或未结束的同步任务，再安装。');
    await run('git', ['--version']);
    console.log('正在安装 TavernSyn 前后端和启动入口…');
    const installed = await install({ st, state, repository, profile: options.profile ?? previous?.profile ?? 'default-user' });
    const device = await loadDevice(state);
    if (process.platform === 'win32') {
        let tools = !options.runtime && await windowsTools(path.dirname(device.tools?.ssh ?? ''));
        if (!tools) {
            const runtime = path.resolve(options.runtime ?? path.join(path.dirname(state), `.tavernsyn-runtime-${path.basename(st)}`));
            requireThat(!inside(runtime, state, true) && !inside(state, runtime, true) && !inside(st, runtime, true), 'RUNTIME', '同步运行库必须独立于酒馆和设备控制目录。');
            tools = await windowsTools(path.join(runtime, 'usr/bin')) ?? await windowsRuntime(runtime);
        }
        await run(tools.rsync, ['--version']); await run(tools.ssh, ['-V']);
        const saved = await readJson(savedFile); saved.tools = tools; await atomicJson(savedFile, saved); device.tools = tools;
    } else {
        await run('rsync', ['--version']); await run('ssh', ['-V']);
    }
    const current = await configuration(device);
    const launcher = path.join(st, process.platform === 'win32' ? 'Start-TavernSyn.cmd' : 'start-tavernsyn.sh');
    return { ...installed, launcher, configured: current.configured };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    setupDevice(cliOptions()).then(result => {
        console.log(`\n安装完成。\n代码目录：${result.repository}\n启动入口：${result.launcher}\n设备控制目录：${result.state}\n设备 ID：${result.deviceId}\n`);
        if (result.repositoryBackup) console.log(`原代码备份：${result.repositoryBackup}`);
        console.log(result.configured ? '已有 VPS 配置和账号密码已保留。' : '请从酒馆「扩展设置 → TavernSyn」填写 VPS 地址、同步账号和密码，再检查连接。');
    }).catch(error => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
}
