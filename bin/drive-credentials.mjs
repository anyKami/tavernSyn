import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevice } from '../lib/device.mjs';
import { withDeviceLock } from '../lib/connection.mjs';
import { cancelDriveAuthorization, driveAccessToken, readDriveCredentials, validateClient, writeDriveCredentials } from '../lib/drive-auth.mjs';
import { atomicJson, cliOptions, inside, noLinks, readJson, requireThat } from '../lib/io.mjs';

export async function transferDriveCredentials(device, options, { fetchImpl = fetch } = {}) {
    requireThat(!!options.export !== !!options.import, 'INPUT', '请选择 --export 文件 或 --import 文件。');
    return withDeviceLock(device, async () => {
        const file = await noLinks(path.resolve(options.export ?? options.import));
        if (options.export) {
            requireThat(![device.install, device.dataRoot, ...device.extraRoots.map(r => r.path)].some(root => inside(root, file, true)),
                'UNSAFE_PATH', '授权导出文件必须放在酒馆及同步范围之外。');
            const credentials = await readDriveCredentials(device); validateClient(credentials.clientId, credentials.clientSecret);
            requireThat(credentials.refreshToken, 'DRIVE_AUTH', '请先在本设备完成 Google 浏览器授权。');
            const handle = await fs.open(file, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify({ format: 'tavernsyn-google-auth-v1', clientId: credentials.clientId,
                    clientSecret: credentials.clientSecret, refreshToken: credentials.refreshToken })); await handle.sync();
            } finally { await handle.close(); }
            return { exported: true };
        }
        const stat = await fs.stat(file);
        requireThat(stat.isFile() && stat.size <= 64 * 1024, 'DRIVE_CREDENTIALS', '授权导入文件无效。');
        const incoming = await readJson(file);
        requireThat(incoming?.format === 'tavernsyn-google-auth-v1' && Object.keys(incoming).every(k => ['format', 'clientId', 'clientSecret', 'refreshToken'].includes(k))
            && typeof incoming.refreshToken === 'string' && incoming.refreshToken.length > 0 && incoming.refreshToken.length <= 16384,
        'DRIVE_CREDENTIALS', '这不是 TavernSyn 导出的 Google 授权文件。');
        validateClient(incoming.clientId, incoming.clientSecret);
        requireThat(!device.drive?.rootId || device.drive.clientId === incoming.clientId, 'DRIVE_CLIENT', '授权文件的 OAuth 应用与已绑定仓库不同。');
        const previous = await readDriveCredentials(device), savedFile = path.join(device.state, 'device.json'), saved = await readJson(savedFile);
        const next = { ...(previous.clientId === incoming.clientId ? previous : {}), clientId: incoming.clientId,
            clientSecret: incoming.clientSecret, refreshToken: incoming.refreshToken };
        delete next.accessToken; delete next.expiresAt; cancelDriveAuthorization(device);
        await writeDriveCredentials(device, next);
        try {
            await driveAccessToken({ ...device, drive: { ...device.drive, clientId: incoming.clientId } }, { fetchImpl });
            const drive = { ...device.drive, clientId: incoming.clientId };
            await atomicJson(savedFile, { ...saved, provider: 'google-drive', drive });
            device.drive = drive; device.provider = 'google-drive';
        } catch (error) { if (!error.atomicCommitted) await writeDriveCredentials(device, previous); throw error; }
        return { imported: true };
    });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const options = cliOptions();
    loadDevice(options.state).then(device => transferDriveCredentials(device, options)).then(result => {
        console.log(result.exported ? '授权文件已导出。它含 Google 离线访问令牌，请仅经可信方式传给自己的设备，导入后删除临时副本。'
            : 'Google 授权已导入。请在 TavernSyn 的 Google 云盘设置中导入仓库配对信息。');
    }).catch(error => { console.error(`操作失败：${error.code ? error.message : '无法读写授权文件，请检查路径与权限。'}`); process.exitCode = 1; });
}
