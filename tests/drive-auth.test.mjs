import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { beginDriveAuthorization, cancelDriveAuthorization, driveAccessToken, readDriveCredentials, writeDriveCredentials, authorizationState, DRIVE_SCOPE } from '../lib/drive-auth.mjs';
import { atomicJson, readJson } from '../lib/io.mjs';
import { configuration, configureDevice } from '../lib/connection.mjs';
import { encodePairing, decodePairing, driveAction } from '../lib/drive-connection.mjs';
import { transferDriveCredentials } from '../bin/drive-credentials.mjs';
import { MemoryDrive } from './drive-fixtures.mjs';

const clientId = '123456-synthetic-test.apps.googleusercontent.com', clientSecret = 'SYNTHETIC_CLIENT_SECRET';
async function fixture(t) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const state = await fs.mkdtemp(path.join(parent, 'drive-auth-'));
    const device = { state, install: path.join(state, 'not-a-real-install'), dataRoot: path.join(state, 'data'), extraRoots: [], deviceId: randomUUID() };
    await atomicJson(path.join(state, 'device.json'), { format: 1, deviceId: device.deviceId });
    t.after(async () => { cancelDriveAuthorization(device); await fs.rm(state, { recursive: true, force: true }); });
    await configureDevice(device, 'configure', { provider: 'google-drive', clientId, clientSecret });
    return device;
}
const token = { access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH', expires_in: 3600, token_type: 'Bearer', scope: DRIVE_SCOPE };
test('Drive OAuth uses PKCE, exact loopback state and scoped tokens without exposing secrets in configuration', async t => {
    const device = await fixture(t); let exchanged;
    const started = await beginDriveAuthorization(device, { fetchImpl: async (url, options) => {
        assert.equal(url, 'https://oauth2.googleapis.com/token'); exchanged = new URLSearchParams(options.body); return Response.json(token);
    } });
    const url = new URL(started.authorizationUrl), redirect = new URL(url.searchParams.get('redirect_uri'));
    assert.equal(redirect.hostname, '127.0.0.1'); assert.notEqual(redirect.port, '');
    assert.equal(url.searchParams.get('scope'), DRIVE_SCOPE); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert(!started.authorizationUrl.includes(clientSecret));
    const bad = new URL(redirect); bad.searchParams.set('state', '好'.repeat(64)); bad.searchParams.set('code', 'bad');
    assert.equal((await fetch(bad)).status, 400); assert.equal(exchanged, undefined);
    redirect.searchParams.set('state', url.searchParams.get('state')); redirect.searchParams.set('code', 'SYNTHETIC_CODE');
    assert.equal((await fetch(redirect)).status, 200);
    assert.equal(createHash('sha256').update(exchanged.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
    assert.equal(exchanged.get('redirect_uri'), url.searchParams.get('redirect_uri'));
    const publicConfig = await configuration(device);
    assert.equal(publicConfig.drive.authorized, true); assert.equal(publicConfig.drive.authPending, false);
    for (const secret of [clientSecret, token.access_token, token.refresh_token]) assert(!JSON.stringify(publicConfig).includes(secret));
    assert.equal((await readDriveCredentials(device)).refreshToken, token.refresh_token);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(device.state, 'credentials/google-drive.json'))).mode & 0o777, 0o600);
});
test('Drive refresh requests are coalesced and preserve the local encryption key', async t => {
    const device = await fixture(t), key = 'ab'.repeat(32); let calls = 0;
    await writeDriveCredentials(device, { clientId, clientSecret, refreshToken: 'REFRESH', key });
    const fetchImpl = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return Response.json(token); };
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => driveAccessToken(device, { fetchImpl }))), Array(6).fill(token.access_token));
    assert.equal(calls, 1); assert.equal((await readDriveCredentials(device)).key, key);
    assert.equal(await driveAccessToken(device, { fetchImpl }), token.access_token); assert.equal(calls, 1);
    await driveAccessToken(device, { force: true, fetchImpl }); assert.equal(calls, 2);
});
test('revoked authorization is a sanitized actionable error and does not replace credentials', async t => {
    const device = await fixture(t), saved = { clientId, clientSecret, refreshToken: 'REFRESH' };
    await writeDriveCredentials(device, saved);
    await assert.rejects(driveAccessToken(device, { fetchImpl: async () => Response.json({ error: 'invalid_grant', error_description: 'DO_NOT_EXPOSE' }, { status: 400 }) }), error => {
        assert.equal(error.code, 'DRIVE_AUTH'); assert.match(error.message, /重新授权/); assert(!error.message.includes('DO_NOT_EXPOSE')); return true;
    });
    assert.deepEqual(await readDriveCredentials(device), saved);
});
test('a callback from an old OAuth flow cannot overwrite changed client credentials', async t => {
    const device = await fixture(t); let finishExchange;
    const started = await beginDriveAuthorization(device, { fetchImpl: () => new Promise(resolve => { finishExchange = () => resolve(Response.json(token)); }) });
    const auth = new URL(started.authorizationUrl), callback = new URL(auth.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'CODE');
    const response = fetch(callback);
    while (!finishExchange) await new Promise(r => setTimeout(r, 5));
    await writeDriveCredentials(device, { clientId: 'other-synthetic.apps.googleusercontent.com', clientSecret });
    finishExchange(); assert.equal((await response).status, 400);
    assert.equal((await readDriveCredentials(device)).refreshToken, undefined);
});
test('pairing carries only repository identity and encryption key and rejects extra fields', () => {
    const drive = { rootId: 'fixture_root_1234', folderId: 'fixture_folder_1234', dataset: randomUUID(), clientId }, key = Buffer.alloc(32, 7);
    const code = encodePairing(drive, key); assert.deepEqual(decodePairing(code), { ...drive, key: key.toString('hex') });
    assert.throws(() => decodePairing('TSDRIVE1.' + Buffer.from(JSON.stringify({ ...decodePairing(code), endpoint: 'https://evil.invalid' })).toString('base64url')), { code: 'DRIVE_PAIRING' });
    assert.throws(() => decodePairing('TSDRIVE1.' + 'a'.repeat(5000)), { code: 'DRIVE_PAIRING' });
});
test('provider switching preserves VPS configuration and local Drive key without sharing credentials', async t => {
    const device = await fixture(t), key = '09'.repeat(32);
    await writeDriveCredentials(device, { ...await readDriveCredentials(device), refreshToken: 'REFRESH', key });
    await configureDevice(device, 'configure', { provider: 'vps' }); assert.equal(device.provider, 'vps');
    await configureDevice(device, 'configure', { provider: 'google-drive', clientId, clientSecret: '' });
    assert.equal((await readDriveCredentials(device)).key, key);
    await configureDevice(device, 'drive-disconnect');
    assert.equal((await configuration(device)).drive.authorized, false); assert.equal((await readDriveCredentials(device)).key, key);
    assert(!JSON.stringify(await readJson(path.join(device.state, 'device.json'))).includes(key));
});
test('OAuth export uses private permissions, refuses overwrite and rejects synced destinations', async t => {
    const device = await fixture(t); await writeDriveCredentials(device, { clientId, clientSecret, ...{ refreshToken: 'REFRESH', key: 'aa'.repeat(32) } });
    const file = path.join(device.state, 'export.json'); await transferDriveCredentials(device, { export: file });
    const contents = await readJson(file); assert.equal(contents.refreshToken, 'REFRESH'); assert.equal(contents.key, undefined);
    await assert.rejects(transferDriveCredentials(device, { export: file }), { code: 'EEXIST' });
    await assert.rejects(transferDriveCredentials(device, { export: path.join(device.install, 'bad.json') }), { code: 'UNSAFE_PATH' });
    if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
test('create and pair bind the same authenticated repository while client typos cannot discard its only key', async t => {
    const first = await fixture(t), second = await fixture(t), cloud = new MemoryDrive();
    for (const device of [first, second]) await writeDriveCredentials(device, { clientId, clientSecret, refreshToken: 'REFRESH' });
    const created = await driveAction(first, 'drive-create', {}, { apiFactory: () => cloud.api });
    assert.equal((await configuration(first)).configured, true);
    await driveAction(second, 'drive-join', created, { apiFactory: () => cloud.api });
    assert.deepEqual(second.drive, first.drive);
    const old = await readDriveCredentials(first);
    await assert.rejects(configureDevice(first, 'configure', { provider: 'google-drive', clientId: 'typo-client.apps.googleusercontent.com', clientSecret }), { code: 'DRIVE_CLIENT' });
    assert.deepEqual(await readDriveCredentials(first), old);
    const bad = decodePairing(created.pairingCode); bad.key = '00'.repeat(32);
    const code = 'TSDRIVE1.' + Buffer.from(JSON.stringify(bad)).toString('base64url');
    await assert.rejects(driveAction(second, 'drive-join', { pairingCode: code }, { apiFactory: () => cloud.api }), { code: 'DRIVE_CONFIG' });
    assert.deepEqual(await readDriveCredentials(second), old);
});
test('OAuth import verifies refresh access and rolls back a rejected token without losing the repository key', async t => {
    const device = await fixture(t), previous = { clientId, clientSecret, refreshToken: 'OLD_REFRESH', key: 'ab'.repeat(32) };
    await writeDriveCredentials(device, previous);
    const file = path.join(device.state, 'incoming.json');
    await atomicJson(file, { format: 'tavernsyn-google-auth-v1', clientId, clientSecret, refreshToken: 'IMPORTED_REFRESH' });
    await assert.rejects(transferDriveCredentials(device, { import: file }, { fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) }), { code: 'DRIVE_AUTH' });
    assert.deepEqual(await readDriveCredentials(device), previous);
    await transferDriveCredentials(device, { import: file }, { fetchImpl: async () => Response.json(token) });
    const current = await readDriveCredentials(device);
    assert.equal(current.key, previous.key); assert.equal(current.accessToken, token.access_token);
    assert.equal((await readJson(path.join(device.state, 'device.json'))).provider, 'google-drive');
});
