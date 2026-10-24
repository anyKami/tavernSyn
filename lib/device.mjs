import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exists, inside, noLinks, readJson, requireThat } from './io.mjs';
import { DEVICE_POINTERS, sharedSettings } from './settings.mjs';
import { portablePath } from './manifest.mjs';

export const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const CONFIG_POINTERS = ['/backups/common/numberOfBackups', '/backups/chat/enabled', '/backups/chat/checkIntegrity'];
export async function loadDevice(stateRoot) {
    requireThat(stateRoot && path.isAbsolute(stateRoot), 'CONFIG', '请指定设备控制目录 --state。');
    const state = await noLinks(stateRoot), config = await readJson(path.join(state, 'device.json'));
    requireThat(config.format === 1 && uuidPattern.test(config.deviceId) && typeof config.install === 'string' && typeof config.profile === 'string', 'CONFIG', '设备配置格式无效。');
    portablePath(config.profile); requireThat(!config.profile.includes('/'), 'CONFIG', '第一版只支持明确绑定的一个用户目录。');
    config.install = await noLinks(config.install);
    const YAML = createRequire(path.join(config.install, 'package.json'))('yaml');
    const yamlPath = path.join(config.install, 'config.yaml');
    const stConfig = YAML.parse(await fs.readFile(yamlPath, 'utf8'));
    const dataRoot = await noLinks(path.resolve(config.install, stConfig.dataRoot ?? './data'));
    requireThat(!inside(config.install, state, true) && !inside(state, config.install, true) && !inside(dataRoot, state, true) && !inside(state, dataRoot, true), 'CONFIG', '控制目录必须与酒馆及其数据目录分离。');
    requireThat(!inside(PROJECT, state, true) && !inside(state, PROJECT, true), 'CONFIG', '设备状态与插件发布代码必须分离。');
    const pointers = [...new Set([...DEVICE_POINTERS, ...(config.preserveSettings ?? [])])]; sharedSettings({}, pointers);
    const extra = config.extraRoots ?? [];
    const jsonPolicies = config.preserveJson ?? [];
    requireThat(Array.isArray(jsonPolicies) && jsonPolicies.length <= 128, 'CONFIG', '本机 JSON 字段策略无效。');
    for (const policy of jsonPolicies) {
        portablePath(policy.path);
        requireThat(/^(profile|extensions|server-plugins|shared|extra)\//.test(policy.path) && Array.isArray(policy.pointers), 'CONFIG', '本机 JSON 策略必须位于共享载荷中。');
        sharedSettings({}, policy.pointers);
    }
    requireThat(Array.isArray(extra) && extra.length <= 16, 'CONFIG', '额外同步目录配置无效。');
    const roots = [dataRoot, path.join(config.install, 'plugins'), path.join(config.install, 'public/scripts/extensions/third-party')];
    const extraNames = new Set();
    for (const item of extra) {
        portablePath(item.id); requireThat(!item.id.includes('/') && !extraNames.has(item.id), 'CONFIG', '额外目录标识重复或无效。'); extraNames.add(item.id);
        item.path = await noLinks(item.path);
        requireThat(path.isAbsolute(item.path) && item.path !== path.parse(item.path).root && path.resolve(item.path) !== path.resolve(os.homedir()), 'CONFIG', '禁止同步系统根目录或整个个人目录。');
        const systemRoots = process.platform === 'win32' ? [process.env.SystemRoot, process.env.ProgramFiles, process.env.ProgramData].filter(Boolean)
            : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/proc', '/sys', '/dev', '/run'];
        requireThat(!systemRoots.some(r => inside(r, item.path, true) || inside(item.path, r, true)), 'CONFIG', '系统目录不能作为额外同步根。');
        for (const reserved of [state, PROJECT, ...roots, ...extra.filter(x => x !== item).map(x => x.path)]) {
            requireThat(!inside(reserved, item.path, true) && !inside(item.path, reserved, true), 'CONFIG', '额外目录与控制目录或其他同步根重叠。');
        }
        requireThat(!inside(item.path, path.join(os.homedir(), '.ssh'), true) && !inside(path.join(os.homedir(), '.ssh'), item.path, true), 'CONFIG', 'SSH 目录不能进入同步范围。');
    }
    requireThat(new URL(`http://127.0.0.1:${stConfig.port ?? 8000}`).port !== '', 'CONFIG', '酒馆端口配置无效。');
    requireThat(stConfig.listen !== true, 'CONFIG', '首版受控启动要求本机监听 listen: false；请保留本地访问模式。');
    requireThat(!stConfig.ssl?.enabled, 'CONFIG', '首版本机受控入口使用 HTTP；HTTPS 实例请先采用独立本机配置。');
    return { ...config, state, dataRoot, stConfig, YAML, yamlPath, pointers,
        origin: `http://127.0.0.1:${stConfig.port ?? 8000}`, extraRoots: extra,
        preserveJson: jsonPolicies, deviceName: config.deviceName ?? os.hostname() };
}
export function validateRemote(remote) {
    requireThat(remote && (remote.dataset === undefined || remote.dataset === '' || uuidPattern.test(remote.dataset))
        && /^[a-z_][a-z0-9_-]{0,31}$/.test(remote.user) && remote.user !== 'root', 'CONFIG', '请配置专用非 root 同步账号；数据集编号由服务器自动提供。');
    requireThat(typeof remote.host === 'string' && (/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(remote.host) || /^(?:[a-z0-9-]+\.)+[a-z0-9-]+\.ts\.net$/i.test(remote.host)), 'CONFIG', '服务器应为登记的 Tailscale IPv4 或 MagicDNS 名称。');
    if (remote.host.startsWith('100.')) {
        const octets = remote.host.split('.').map(Number);
        requireThat(octets[1] >= 64 && octets[1] <= 127 && octets.every(n => n <= 255), 'CONFIG', '地址不在 Tailscale IPv4 范围。');
    }
    return remote;
}
export async function checkRemoteConfig(device, { allowMissingPassword = false } = {}) {
    const remote = validateRemote(device.remote);
    for (const name of ['passwordFile', 'knownHostsFile']) {
        requireThat(typeof remote[name] === 'string' && path.isAbsolute(remote[name])
            && (name === 'knownHostsFile' || allowMissingPassword || await exists(remote[name])), 'SSH_CONFIG', '请先在 VPS 配置中保存账号密码。');
        const resolved = await noLinks(remote[name]);
        requireThat(!inside(device.dataRoot, resolved, true) && !inside(device.install, resolved, true) && !device.extraRoots.some(x => inside(x.path, resolved, true)), 'SSH_CONFIG', 'SSH 凭据必须置于镜像范围之外。');
    }
    return remote;
}
