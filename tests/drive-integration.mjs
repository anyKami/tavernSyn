// Actual pinned SillyTavern processes and production Drive transport. Google
// HTTP responses are supplied by MemoryDrive; no real account/OAuth is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, digest, exists, readJson, run } from '../lib/io.mjs';
import { install } from '../bin/install.mjs';
import { Manager } from '../helper/manager.mjs';
import * as driveTransport from '../helper/drive-transport.mjs';
import { createRepository, DriveRepository } from '../lib/drive-repository.mjs';
import { writeDriveCredentials } from '../lib/drive-auth.mjs';
import { driveFingerprint } from '../lib/drive-connection.mjs';
import { portableState } from '../lib/snapshot.mjs';
import { hashFile } from '../lib/manifest.mjs';
import { recoveryStatus } from '../helper/apply.mjs';
import { ST, YAML, phase } from './fixtures.mjs';
import { MemoryDrive } from './drive-fixtures.mjs';

const commit = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const parent = process.env.TMPDIR ?? path.join(path.dirname(PROJECT), '.tavernsyn-drive-tests');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'drive-integration-')), archive = path.join(root, 'source.tar');
await run('git', ['-C', ST, 'archive', '--format=tar', '--output', archive, commit]);
const drive = new MemoryDrive(), key = randomBytes(32), descriptor = await createRepository(drive.api, { key });
const clientId = '123456789012-fixture.apps.googleusercontent.com';
const devices = [], checks = [], usedPorts = new Set();
async function freePort() {
    for (;;) {
        const port = await new Promise((resolve, reject) => {
            const server = net.createServer(); server.once('error', reject);
            server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
        });
        if (!usedPorts.has(port)) { usedPorts.add(port); return port; }
    }
}
const world = text => ({ entries: { 0: { uid: 0, key: ['drive'], content: text, constant: false, order: 100, position: 0, disable: false } } });
const profile = entry => path.join(entry.device.dataRoot, entry.device.profile);
async function makeDevice(name) {
    const directory = path.join(root, name, 'SillyTavern'), state = path.join(root, name, 'state');
    await fs.mkdir(directory, { recursive: true }); await run('tar', ['-xf', archive, '-C', directory]);
    await fs.symlink(path.join(ST, 'node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const config = YAML.parse(await fs.readFile(path.join(directory, 'default/config.yaml'), 'utf8'));
    Object.assign(config, { port: await freePort(), dataRoot: './data', listen: false, enableUserAccounts: true,
        enableServerPlugins: true, enableServerPluginsAutoUpdate: false, whitelistDockerHosts: false });
    config.browserLaunch.enabled = false; config.extensions.autoUpdate = false;
    await fs.writeFile(path.join(directory, 'config.yaml'), YAML.stringify(config));
    const settings = await readJson(path.join(directory, 'default/content/settings.json'));
    settings.username = name; settings.extension_settings ??= {}; settings.power_user ??= {};
    settings.power_user.chat_width = name === 'computer' ? 77 : 43;
    await atomicJson(path.join(directory, 'data/default-user/settings.json'), settings);
    await atomicJson(path.join(directory, 'data/default-user/worlds/drive-fixture.json'), world(`world from ${name}`));
    await atomicJson(path.join(directory, 'data/default-user/secrets.json'), { fake_test_key: `DRIVE_SYNTHETIC_${name}` });
    const installed = await install({ st: directory, state });
    const saved = await readJson(path.join(state, 'device.json'));
    Object.assign(saved, { deviceName: name, restoreDependencies: false, provider: 'google-drive',
        drive: { ...descriptor, clientId, keyFingerprint: driveFingerprint(key) } });
    await atomicJson(path.join(state, 'device.json'), saved);
    const device = await loadDevice(state);
    await writeDriveCredentials(device, { clientId, clientSecret: 'SYNTHETIC_CLIENT_SECRET', refreshToken: 'SYNTHETIC_REFRESH_TOKEN', key: key.toString('hex') });
    const { Lifecycle } = await import(pathToFileURL(path.join(installed.repository, 'helper/lifecycle.mjs')).href);
    const entry = { device, jar: new Map(), logs: [], starts: 0 };
    const lifecycle = new Lifecycle(device, (action, payload) => entry.manager.action(action, payload));
    const start = lifecycle.start.bind(lifecycle);
    lifecycle.start = async () => { const result = await start(); entry.starts++; return result; };
    const adapter = { ...driveTransport, connect: (current, _unused, log) => driveTransport.connect(current, () => drive.api, log) };
    entry.lifecycle = lifecycle; entry.manager = new Manager(device, lifecycle, adapter, (_job, text) => entry.logs.push(text));
    devices.push(entry); return entry;
}
async function request(entry, route, { method = 'GET', body, token = entry.csrf } = {}) {
    const headers = { Cookie: [...entry.jar].map(([name, value]) => `${name}=${value}`).join('; '), Origin: entry.device.origin,
        'x-tavernsyn-epoch': entry.lifecycle.nonce };
    if (token) headers['x-csrf-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(entry.device.origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(';')[0], index = first.indexOf('='); entry.jar.set(first.slice(0, index), first.slice(index + 1));
    }
    return response;
}
async function login(entry) {
    const token = await request(entry, '/csrf-token', { token: null }); assert.equal(token.status, 200);
    entry.csrf = (await token.json()).token;
    const response = await request(entry, '/api/users/login', { method: 'POST', body: { handle: 'default-user', password: '' } });
    assert.equal(response.status, 200); await response.text();
}
async function api(entry, action, body) {
    const response = await request(entry, `/api/plugins/tavernsyn/${action}`, { method: body === undefined ? 'GET' : 'POST', body });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function flush(entry) {
    const settings = await readJson(path.join(profile(entry), 'settings.json')), nonce = randomUUID();
    settings.extension_settings ??= {}; settings.extension_settings.tavernsyn ??= {};
    settings.extension_settings.tavernsyn.flushReceipt = nonce;
    const saved = await request(entry, '/api/settings/save', { method: 'POST', body: settings });
    assert.equal(saved.status, 200); await saved.text();
    const settingsDigest = digest({ extension_settings: settings.extension_settings, power_user: settings.power_user,
        oai_settings: settings.oai_settings, textgenerationwebui_settings: settings.textgenerationwebui_settings });
    return (await api(entry, 'flush', { nonce, settingsDigest })).receipt;
}
async function synchronize(entry, direction) {
    const { manager, lifecycle } = entry, nonce = lifecycle.nonce;
    const started = await api(entry, 'start', { direction, tab: randomUUID() });
    const waiting = await phase(manager, 'AWAITING_SAVE', 60000);
    assert.equal(waiting.id, started.id);
    const receipt = await flush(entry);
    await api(entry, 'ready', { id: waiting.id, tab: waiting.tab, receipt });
    const page = await phase(manager, 'WAITING_PAGE');
    await api(entry, 'page', { id: page.id, tab: page.tab, ticket: page.ticket });
    await manager.done;
    const status = await manager.status();
    assert.equal(status.phase, 'SUCCEEDED', JSON.stringify({ status, logs: entry.logs.slice(-20) }));
    assert.equal(status.maintenancePending, false); assert.notEqual(lifecycle.nonce, nonce); assert.equal(lifecycle.stopped, false);
    await login(entry);
    const response = await request(entry, '/'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-tavernsyn-epoch'), lifecycle.nonce); await response.text();
    return status;
}
const payloads = () => [...drive.files.values()].filter(file => file.metadata.appProperties?.kind === 'payload');

try {
    const computer = await makeDevice('computer'), phone = await makeDevice('phone');
    const picture = path.join(profile(computer), 'images/Google 云盘图片.bin');
    await fs.mkdir(path.dirname(picture), { recursive: true }); await fs.writeFile(picture, randomBytes(768 * 1024));
    const plugin = path.join(computer.device.install, 'plugins/drive-health-fixture'); await fs.mkdir(plugin);
    await fs.writeFile(path.join(plugin, 'index.mjs'), "export const info={id:'drive-health-fixture',name:'Drive fixture',description:'Synthetic'}; export async function init(){};\n");
    await computer.lifecycle.start(); await phone.lifecycle.start();
    await login(computer); await login(phone);
    const targetOnly = path.join(profile(phone), 'target-only.txt'); await fs.writeFile(targetOnly, 'keep in latest local backup');
    const initialPhone = await portableState(phone.device), phonePort = phone.device.stConfig.port, computerPort = computer.device.stConfig.port;
    drive.put({ id: 'foreign_file_123456', mimeType: 'application/octet-stream', parents: [descriptor.folderId] }, Buffer.from('unrelated cloud content'));

    const published = await synchronize(computer, 'push');
    assert.equal(payloads().length, 1); assert.equal(payloads()[0].metadata.appProperties.repositoryId, descriptor.dataset);
    assert.ok(drive.requests.some(request => request.method === 'PUT' && String(request.headers?.['content-range']).startsWith('bytes 262144-')),
        'the encrypted fixture exercises resumable upload chunks');
    checks.push('production_google_transport_compressed_encrypted_chunked_publication_over_fake_http');

    const received = await synchronize(phone, 'pull');
    assert.equal(received.remote.generation, published.id);
    assert.equal(await exists(targetOnly), false);
    assert.equal((await readJson(path.join(profile(phone), 'settings.json'))).power_user.chat_width, 43);
    // ST migrates legacy string secrets into named active-key entries at startup.
    const incomingSecret = (await readJson(path.join(profile(phone), 'secrets.json'))).fake_test_key;
    assert.deepEqual(incomingSecret, (await readJson(path.join(profile(computer), 'secrets.json'))).fake_test_key);
    assert.equal(incomingSecret[0].value, 'DRIVE_SYNTHETIC_computer');
    assert.equal(await hashFile(path.join(profile(phone), 'images/Google 云盘图片.bin')), await hashFile(picture));
    assert.equal(await exists(path.join(phone.device.install, 'plugins/drive-health-fixture/index.mjs')), true);
    assert.equal(phone.device.stConfig.port, phonePort);
    assert.equal((await recoveryStatus(phone.device)).available, true);
    checks.push('computer_to_phone_complete_mirror_deletions_secrets_local_fields_and_real_st_plugin_health');

    await synchronize(phone, 'restore');
    assert.equal((await portableState(phone.device)).digest, initialPhone.digest);
    assert.equal(await exists(targetOnly), true);
    assert.equal((await recoveryStatus(phone.device)).available, false);
    assert.equal((await new DriveRepository(drive.api, { ...descriptor, key }).head()).generation, published.id);
    checks.push('latest_phone_backup_restored_through_manager_with_real_shutdown_restart_and_health');

    await fs.writeFile(path.join(profile(phone), 'phone-new.txt'), 'phone to computer through cloud');
    await atomicJson(path.join(profile(phone), 'worlds/drive-fixture.json'), world('phone revised world'));
    const beforeComputer = await portableState(computer.device);
    const phonePublished = await synchronize(phone, 'push');
    assert.equal(payloads().length, 1); assert.equal(drive.files.has('foreign_file_123456'), true);
    assert.equal([...drive.files.values()].filter(file => file.metadata.appProperties?.kind === 'commit').length, 2);
    checks.push('second_publication_deletes_only_old_owned_payload_and_preserves_commit_metadata_and_foreign_file');

    const returned = await synchronize(computer, 'pull');
    assert.equal(returned.remote.generation, phonePublished.id);
    assert.equal(await fs.readFile(path.join(profile(computer), 'phone-new.txt'), 'utf8'), 'phone to computer through cloud');
    assert.equal(await exists(picture), false);
    assert.equal(await exists(path.join(computer.device.install, 'plugins/drive-health-fixture')), false);
    assert.equal((await readJson(path.join(profile(computer), 'settings.json'))).power_user.chat_width, 77);
    assert.equal(computer.device.stConfig.port, computerPort);
    assert.equal((await recoveryStatus(computer.device)).available, true);
    checks.push('phone_to_computer_complete_mirror_with_real_st_save_handoff_stop_start_and_health');

    await synchronize(computer, 'restore');
    assert.equal((await portableState(computer.device)).digest, beforeComputer.digest);
    assert.equal((await recoveryStatus(computer.device)).available, false);
    assert.equal(payloads().length, 1);
    assert.equal((await new DriveRepository(drive.api, { ...descriptor, key }).head()).generation, phonePublished.id);
    checks.push('latest_computer_backup_restored_without_changing_cloud_publication');

    for (const entry of devices) {
        assert.equal(entry.starts, 4);
        await entry.lifecycle.close();
        assert.equal(await exists(path.join(entry.device.state, 'instance.lock')), false);
    }
    checks.push('eight_actual_pinned_st_startups_and_final_graceful_shutdown_leave_no_instance_lock');
    const report = { date: new Date().toISOString(), platform: process.platform, node: process.version,
        sillyTavern: '1.19.0', commit, passed: true, checks, actualSillyTavern: true,
        driveService: 'in-memory HTTP contract fake', realGoogleAccount: false, realGoogleOAuth: false,
        physicalWindowsAndroidDevices: false, actualServerStartups: devices.reduce((sum, entry) => sum + entry.starts, 0),
        note: 'Production Drive API/repository/encryption/transport and real SillyTavern HTTP save/flush/controlled lifecycle; no live Google account or hardware test.' };
    await atomicJson(process.env.TAVERNSYN_DRIVE_TEST_REPORT ?? path.join(root, 'results.json'), report);
    console.log(JSON.stringify(report, null, 2));
} catch (error) {
    console.error(`Drive integration fixture retained: ${root}`);
    for (const entry of devices) console.error(`${entry.device.deviceName}: ${entry.logs.slice(-15).join('\n')}`);
    throw error;
} finally {
    for (const entry of devices) if (!entry.lifecycle.stopped) await entry.lifecycle.close().catch(() => {});
}
