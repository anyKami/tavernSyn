import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { atomicJson, exists, noLinks, readJson, requireThat, SyncError } from './io.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const pending = new Map(), refreshing = new Map();
export const credentialPath = device => path.join(device.state, 'credentials/google-drive.json');
export function validateClient(clientId, clientSecret) {
    requireThat(typeof clientId === 'string' && /^[a-zA-Z0-9_-]{5,200}\.apps\.googleusercontent\.com$/.test(clientId),
        'DRIVE_CLIENT', '请输入 Google Cloud 的桌面应用 OAuth Client ID。');
    requireThat(typeof clientSecret === 'string' && clientSecret.length > 0 && clientSecret.length <= 512 && !/[\s\x00-\x1f]/.test(clientSecret),
        'DRIVE_CLIENT', '请输入对应桌面应用的 Client secret。');
}
export async function readDriveCredentials(device) {
    const file = await noLinks(credentialPath(device));
    if (!await exists(file)) return {};
    const stat = await fs.stat(file);
    requireThat(stat.isFile() && stat.size <= 64 * 1024, 'DRIVE_CREDENTIALS', 'Google 云盘本机凭据文件无效，请重新授权。');
    const credentials = await readJson(file);
    requireThat(credentials && !Array.isArray(credentials) && typeof credentials === 'object', 'DRIVE_CREDENTIALS', 'Google 云盘凭据格式无效。');
    return credentials;
}
export async function writeDriveCredentials(device, value) {
    await noLinks(credentialPath(device));
    await atomicJson(credentialPath(device), value);
}
export function authorizationState(device) {
    const flow = pending.get(device.state);
    return { authPending: !!flow?.active, ...(flow?.error ? { authError: flow.error } : {}) };
}
export function cancelDriveAuthorization(device) {
    const flow = pending.get(device.state);
    if (flow) { flow.active = false; clearTimeout(flow.timer); flow.server?.close(); pending.delete(device.state); }
}
async function tokenRequest(fields, fetchImpl) {
    let response;
    try {
        response = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(), redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { throw new SyncError('DRIVE_NETWORK', '无法连接 Google 授权服务，请检查当前设备网络。'); }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
        bytes += chunk.length; requireThat(bytes <= 64 * 1024, 'DRIVE_AUTH', 'Google 授权响应无效。'); chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let value; try { value = JSON.parse(text); } catch { throw new SyncError('DRIVE_AUTH', 'Google 授权响应无效。'); }
    requireThat(response.ok, 'DRIVE_AUTH', value?.error === 'invalid_grant'
        ? 'Google 授权已过期或被撤销，请重新授权；测试状态的 OAuth 应用授权可能在七天后过期。'
        : 'Google 拒绝了授权请求，请检查桌面应用 Client ID、Client secret 和授权设置。');
    requireThat(typeof value.access_token === 'string' && value.access_token.length > 0 && value.access_token.length <= 16384
        && (!value.token_type || value.token_type.toLowerCase() === 'bearer')
        && Number.isFinite(value.expires_in) && value.expires_in > 0, 'DRIVE_AUTH', 'Google 返回的令牌无效。');
    if (value.scope) requireThat(value.scope.split(' ').includes(DRIVE_SCOPE), 'DRIVE_AUTH', '未取得此应用所创建文件的 Google 云盘权限。');
    return { accessToken: value.access_token, expiresAt: Date.now() + Math.min(value.expires_in, 86400) * 1000,
        ...(typeof value.refresh_token === 'string' && value.refresh_token ? { refreshToken: value.refresh_token } : {}) };
}
export async function driveAccessToken(device, { force = false, fetchImpl = fetch } = {}) {
    const file = credentialPath(device);
    if (refreshing.has(file)) return refreshing.get(file);
    const work = (async () => {
        const saved = await readDriveCredentials(device);
        validateClient(saved.clientId, saved.clientSecret);
        requireThat(!device.drive?.clientId || saved.clientId === device.drive.clientId, 'CONFIG_CHANGED', 'Google OAuth 应用已改变，请重新保存云盘配置。');
        if (!force && saved.accessToken && saved.expiresAt > Date.now() + 60000) return saved.accessToken;
        requireThat(saved.refreshToken, 'DRIVE_AUTH', '请先在 TavernSyn 设置中授权 Google 云盘。');
        const token = await tokenRequest({ client_id: saved.clientId, client_secret: saved.clientSecret,
            grant_type: 'refresh_token', refresh_token: saved.refreshToken }, fetchImpl);
        const latest = await readDriveCredentials(device);
        requireThat(latest.clientId === saved.clientId && latest.refreshToken === saved.refreshToken,
            'CONFIG_CHANGED', 'Google 授权已改变，本次令牌刷新已停止。');
        await writeDriveCredentials(device, { ...latest, ...token });
        return token.accessToken;
    })();
    refreshing.set(file, work);
    try { return await work; } finally { if (refreshing.get(file) === work) refreshing.delete(file); }
}

// Only the state-bound loopback callback receives authorization codes. Neither
// tokens nor codes are returned to the ST extension or written to its logs.
export async function beginDriveAuthorization(device, { fetchImpl = fetch, save = async action => action(), timeoutMs = 10 * 60 * 1000 } = {}) {
    const saved = await readDriveCredentials(device);
    validateClient(saved.clientId, saved.clientSecret);
    cancelDriveAuthorization(device);
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('hex');
    const flow = { active: true, error: null, server: null, timer: null };
    pending.set(device.state, flow);
    let redirectUri, expectedHost;
    const finish = error => { flow.active = false; flow.error = error ?? null; clearTimeout(flow.timer); flow.server.close(); };
    const server = http.createServer(async (req, res) => {
        const reply = (status, message) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
            'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }); res.end(message); };
        if (req.method !== 'GET' || req.headers.host !== expectedHost || (req.url?.length ?? 0) > 8192) { reply(400, '无效的授权回调。'); return; }
        const url = new URL(req.url, redirectUri);
        const received = url.searchParams.get('state') ?? '';
        if (url.pathname !== '/oauth2callback' || !/^[a-f0-9]{64}$/.test(received)
            || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) { reply(400, '授权状态不匹配，请返回 TavernSyn 重新授权。'); return; }
        if (!flow.active || flow.exchanging) { reply(409, '该授权请求已处理。'); return; }
        flow.exchanging = true;
        try {
            requireThat(!url.searchParams.has('error') && url.searchParams.get('code'), 'DRIVE_AUTH', 'Google 授权未完成，请返回 TavernSyn 重试。');
            const token = await tokenRequest({ client_id: saved.clientId, client_secret: saved.clientSecret,
                grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirectUri }, fetchImpl);
            requireThat(token.refreshToken, 'DRIVE_AUTH', '未取得离线访问令牌，请重新授权。');
            await save(async () => {
                const latest = await readDriveCredentials(device);
                requireThat(pending.get(device.state) === flow && flow.active && latest.clientId === saved.clientId
                    && latest.clientSecret === saved.clientSecret, 'CONFIG_CHANGED', '授权期间配置已改变，请重新授权。');
                await writeDriveCredentials(device, { ...latest, ...token });
            });
            reply(200, 'Google 云盘授权成功。可以关闭此页面，返回 TavernSyn 创建仓库或加入另一台设备的仓库。');
            finish();
        } catch (error) {
            const message = error.code ? error.message : '保存授权失败，请返回 TavernSyn 重试。';
            reply(400, message); finish(message);
        }
    });
    flow.server = server;
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    expectedHost = `127.0.0.1:${server.address().port}`; redirectUri = `http://${expectedHost}/oauth2callback`;
    flow.timer = setTimeout(() => finish('Google 授权等待超时，请重新点击授权。'), timeoutMs); flow.timer.unref(); server.unref();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: saved.clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: DRIVE_SCOPE, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' }).toString();
    return { authorizationUrl: url.toString() };
}
