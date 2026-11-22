import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkRemoteConfig, validateRemote } from './device.mjs';
import { atomicJson, exists, noLinks, readJson, requireThat, SyncError } from './io.mjs';
import { configureDrive, driveAction, driveConfiguration } from './drive-connection.mjs';
import { readCompletion } from './completion.mjs';

function paths(device) {
    return { passwordFile: path.join(device.state, 'credentials/ssh-password.json'),
        knownHostsFile: device.remote?.knownHostsFile ?? path.join(device.state, 'credentials/known_hosts') };
}
export function validPassword(value) {
    requireThat(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\r\n\x00]/.test(value),
        'PASSWORD', '请输入同步账号的密码（不支持换行或空密码）。');
    return value;
}
export async function readPassword(file) {
    await noLinks(file);
    const stat = await fs.stat(file);
    requireThat(stat.isFile() && stat.size <= 16 * 1024, 'PASSWORD', '保存的同步密码文件无效，请重新填写密码。');
    return validPassword((await readJson(file)).password);
}
export async function configuration(device) {
    const files = paths(device);
    const passwordSaved = !!device.remote?.passwordFile && await exists(device.remote.passwordFile);
    const runtimeReady = process.platform !== 'win32' || (await Promise.all(['ssh.exe', 'rsync.exe', 'sh.exe', 'cygpath.exe']
        .map(name => exists(path.join(path.dirname(device.tools?.ssh ?? ''), name))))).every(Boolean);
    const provider = device.provider ?? 'vps', drive = await driveConfiguration(device);
    return { provider, remoteLabel: provider === 'google-drive' ? 'Google 云盘' : 'VPS', drive,
        host: device.remote?.host ?? '', user: device.remote?.user ?? 'tavernsyn', dataset: device.remote?.dataset ?? '',
        deviceId: device.deviceId, passwordSaved, runtimeReady: provider === 'google-drive' || runtimeReady,
        configured: provider === 'google-drive' ? drive.configured : !!device.remote && passwordSaved,
        serverRemembered: await exists(files.knownHostsFile) };
}
async function save(device, body) {
    requireThat(body && !Array.isArray(body) && Object.keys(body).every(k => ['host', 'user', 'password', 'dataset'].includes(k)), 'INPUT', '不接受未定义的连接参数。');
    requireThat(['host', 'user'].every(k => typeof body[k] === 'string')
        && (body.password === undefined || typeof body.password === 'string')
        && (body.dataset === undefined || typeof body.dataset === 'string'), 'INPUT', '连接参数格式无效。');
    const host = body.host.trim().toLowerCase(), user = body.user.trim();
    const sameTarget = host === device.remote?.host && user === device.remote?.user;
    const remote = validateRemote({ host, user,
        dataset: body.dataset === undefined ? (sameTarget ? device.remote?.dataset ?? '' : '') : body.dataset.trim().toLowerCase(), ...paths(device) });
    for (const file of [remote.passwordFile, remote.knownHostsFile]) await noLinks(file);
    await checkRemoteConfig({ ...device, remote }, { allowMissingPassword: true });
    const password = body.password ? validPassword(body.password) : null;
    requireThat(password || (sameTarget && device.remote?.passwordFile === remote.passwordFile && await exists(remote.passwordFile)),
        'PASSWORD', '请输入这个 VPS 同步账号的密码。');
    const file = path.join(device.state, 'device.json'), config = await readJson(file);
    const previous = await exists(remote.passwordFile) ? await readJson(remote.passwordFile) : null;
    if (password) await atomicJson(remote.passwordFile, { password });
    try { config.remote = remote; config.provider = 'vps'; await atomicJson(file, config); }
    catch (error) {
        if (password) {
            if (previous) await atomicJson(remote.passwordFile, previous);
            else await fs.unlink(remote.passwordFile);
        }
        throw error;
    }
    device.remote = remote; device.provider = 'vps';
    return configuration(device);
}
export async function withDeviceLock(device, action) {
    const lock = path.join(device.state, 'operation.lock'), id = randomUUID();
    const handle = await fs.open(lock, 'wx', 0o600).catch(() => { throw new SyncError('BUSY', '同步或配置正在进行，请结束任务后再修改连接。'); });
    try {
        await handle.writeFile(JSON.stringify({ id, pid: process.pid, purpose: 'configuration' }));
        const status = await exists(path.join(device.state, 'status.json')) ? await readJson(path.join(device.state, 'status.json')) : { phase: 'IDLE' };
        requireThat(!status.maintenancePending, 'FINALIZATION_PENDING', '已提交任务的本机收尾尚未完成，请先核对同步结果再修改连接。');
        if (status.phase !== 'SUCCEEDED' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(status.id ?? '')) {
            requireThat(!await readCompletion(device, status.id), 'FINALIZATION_PENDING', '发现已提交任务回执，请先核对同步结果再修改连接。');
            const applyFile = path.join(device.state, 'apply.json');
            if (await exists(applyFile)) {
                const apply = await readJson(applyFile);
                requireThat(!(apply.phase === 'committed' && apply.completion?.id === status.id), 'FINALIZATION_PENDING', '本机应用已提交，请先核对结果再修改连接。');
            }
        }
        requireThat(['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED'].includes(status.phase), 'BUSY', '请先处理待应用、恢复或未完成任务，再修改连接。');
        return await action();
    } finally {
        await handle.close();
        if ((await readJson(lock).catch(() => ({}))).id === id) await fs.unlink(lock);
    }
}
export async function configureDevice(device, action, body = {}) {
    requireThat(action === 'configure' || ['drive-authorize', 'drive-create', 'drive-join', 'drive-pairing', 'drive-disconnect'].includes(action), 'INPUT', '不支持的连接配置操作。');
    return withDeviceLock(device, async () => {
        if (action !== 'configure') return driveAction(device, action, body, { withLock: withDeviceLock });
        requireThat(body && !Array.isArray(body) && (body.provider === undefined || ['vps', 'google-drive'].includes(body.provider)), 'INPUT', '同步存储类型无效。');
        if (body.provider === 'google-drive') { await configureDrive(device, body); return configuration(device); }
        if (Object.keys(body).length === 1 && body.provider === 'vps') {
            const file = path.join(device.state, 'device.json'), config = await readJson(file);
            await atomicJson(file, { ...config, provider: 'vps' }); device.provider = 'vps'; return configuration(device);
        }
        const { provider: _provider, ...vps } = body;
        return save(device, vps);
    });
}
