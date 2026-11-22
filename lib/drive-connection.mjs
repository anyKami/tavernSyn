import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { atomicJson, readJson, requireThat } from './io.mjs';
import { DriveApi } from './drive-api.mjs';
import { DriveRepository, createRepository } from './drive-repository.mjs';
import { authorizationState, beginDriveAuthorization, cancelDriveAuthorization, driveAccessToken,
    readDriveCredentials, validateClient, writeDriveCredentials } from './drive-auth.mjs';

export const driveFingerprint = key => createHash('sha256').update(key).digest('hex');
export function driveKey(credentials) {
    requireThat(typeof credentials.key === 'string' && /^[a-f0-9]{64}$/.test(credentials.key), 'DRIVE_KEY', '缺少仓库密钥，请从另一台设备导入配对信息。');
    return Buffer.from(credentials.key, 'hex');
}
export function driveApi(device, options = {}) {
    return new DriveApi({ accessToken: ({ force = false } = {}) => driveAccessToken(device, { force }), ...options });
}
export async function driveConfiguration(device) {
    const credentials = await readDriveCredentials(device), drive = device.drive ?? {};
    return { clientConfigured: !!credentials.clientId && !!credentials.clientSecret, clientId: credentials.clientId ?? '',
        authorized: !!credentials.refreshToken, configured: !!credentials.refreshToken && !!credentials.key
            && !!drive.rootId && !!drive.folderId && !!drive.dataset && drive.clientId === credentials.clientId,
        rootId: drive.rootId ?? '', folderId: drive.folderId ?? '', dataset: drive.dataset ?? '', ...authorizationState(device) };
}
async function saveBinding(device, credentials, drive) {
    const file = path.join(device.state, 'device.json'), saved = await readJson(file);
    const previous = await readDriveCredentials(device);
    await writeDriveCredentials(device, credentials);
    try { await atomicJson(file, { ...saved, provider: 'google-drive', drive }); }
    catch (error) { if (!error.atomicCommitted) await writeDriveCredentials(device, previous); throw error; }
    device.provider = 'google-drive'; device.drive = drive;
}
export async function configureDrive(device, body) {
    requireThat(body && !Array.isArray(body) && Object.keys(body).every(key => ['provider', 'clientId', 'clientSecret'].includes(key)), 'INPUT', 'Google 云盘连接参数无效。');
    requireThat((body.clientId === undefined || typeof body.clientId === 'string')
        && (body.clientSecret === undefined || typeof body.clientSecret === 'string'), 'INPUT', 'OAuth 客户端字段必须为文本。');
    const previous = await readDriveCredentials(device);
    const clientId = body.clientId === undefined ? previous.clientId : body.clientId?.trim();
    const sameClient = previous.clientId === clientId;
    requireThat(!device.drive?.rootId || sameClient, 'DRIVE_CLIENT', '本机已绑定加密仓库，请保留原 OAuth Client ID；更换应用前应先保存仓库配对信息并迁移仓库。');
    const clientSecret = body.clientSecret || (sameClient ? previous.clientSecret : '');
    validateClient(clientId, clientSecret);
    cancelDriveAuthorization(device);
    const credentials = sameClient ? { ...previous, clientSecret } : { clientId, clientSecret };
    const drive = sameClient ? { ...device.drive, clientId } : { clientId };
    await saveBinding(device, credentials, drive);
}
export function encodePairing(drive, key) {
    return `TSDRIVE1.${Buffer.from(JSON.stringify({ rootId: drive.rootId, folderId: drive.folderId, dataset: drive.dataset,
        clientId: drive.clientId, key: key.toString('hex') })).toString('base64url')}`;
}
export function decodePairing(value) {
    requireThat(typeof value === 'string' && value.length <= 4096 && /^TSDRIVE1\.[A-Za-z0-9_-]+$/.test(value.trim()), 'DRIVE_PAIRING', '仓库配对信息格式无效。');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(value.trim().slice(9), 'base64url').toString('utf8')); } catch { /* Validation below is intentionally generic. */ }
    requireThat(parsed && Object.keys(parsed).sort().join(',') === 'clientId,dataset,folderId,key,rootId'
        && ['rootId', 'folderId'].every(k => /^[A-Za-z0-9_-]{10,200}$/.test(parsed[k]))
        && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(parsed.dataset)
        && /^[a-f0-9]{64}$/.test(parsed.key) && typeof parsed.clientId === 'string', 'DRIVE_PAIRING', '仓库配对信息不完整。');
    return parsed;
}
export async function driveAction(device, action, body = {}, { withLock, apiFactory = driveApi } = {}) {
    requireThat(body && !Array.isArray(body) && Object.keys(body).every(k => action === 'drive-join' && k === 'pairingCode'), 'INPUT', 'Google 云盘操作参数无效。');
    if (action === 'drive-authorize') return beginDriveAuthorization(device, { save: callback => withLock(device, callback) });
    const credentials = await readDriveCredentials(device);
    if (action === 'drive-disconnect') {
        cancelDriveAuthorization(device);
        const { accessToken: _access, refreshToken: _refresh, expiresAt: _expiry, ...remaining } = credentials;
        await writeDriveCredentials(device, remaining);
        return { ok: true };
    }
    if (action === 'drive-pairing') {
        requireThat(device.drive?.rootId, 'DRIVE_CONFIG', '请先创建或加入云盘仓库。');
        return { pairingCode: encodePairing(device.drive, driveKey(credentials)) };
    }
    requireThat(['drive-create', 'drive-join'].includes(action), 'ACTION', '不支持的云盘操作。');
    validateClient(credentials.clientId, credentials.clientSecret);
    requireThat(credentials.refreshToken, 'DRIVE_AUTH', '请先授权 Google 云盘。');
    const api = apiFactory(device);
    if (action === 'drive-create') {
        requireThat(!device.drive?.rootId, 'DRIVE_CONFIG', '本机已绑定仓库。请使用配对信息让另一台设备加入，避免误建空仓库。');
        const key = randomBytes(32), binding = await createRepository(api, { key });
        const drive = { ...binding, clientId: credentials.clientId, keyFingerprint: driveFingerprint(key) };
        // Token refresh during the API call may have updated the credential file.
        await saveBinding(device, { ...await readDriveCredentials(device), key: key.toString('hex') }, drive);
        return { pairingCode: encodePairing(drive, key) };
    }
    const paired = decodePairing(body.pairingCode);
    requireThat(paired.clientId === credentials.clientId, 'DRIVE_CLIENT', '两台设备必须使用同一个 Google OAuth Client ID。请先保存对应客户端并授权。');
    const key = driveKey(paired), { rootId, folderId, dataset } = paired;
    requireThat(!device.drive?.rootId || (device.drive.rootId === rootId && device.drive.folderId === folderId
        && device.drive.dataset === dataset && device.drive.keyFingerprint === driveFingerprint(key)),
    'DRIVE_CONFIG', '本机已绑定另一个加密仓库，不能覆盖其唯一密钥。请保留原配对码，使用独立设备控制目录迁移。');
    await new DriveRepository(api, { rootId, folderId, dataset, key }).open();
    await saveBinding(device, { ...await readDriveCredentials(device), key: paired.key },
        { rootId, folderId, dataset, clientId: credentials.clientId, keyFingerprint: driveFingerprint(key) });
    return { ok: true };
}
