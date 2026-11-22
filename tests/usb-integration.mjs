// Real ST processes and real loopback streaming. ADB hardware is deliberately
// outside this fixture; USB tunnel selection is covered by usb-adb.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { install } from '../bin/install.mjs';
import { UsbSession } from '../helper/usb-sync.mjs';
import { startUsbServer, syncUsb } from '../helper/usb-service.mjs';
import { portableState } from '../lib/snapshot.mjs';
import { recoveryStatus, rollback } from '../helper/apply.mjs';
import { ST, YAML } from './fixtures.mjs';

const parent = process.env.TMPDIR ?? path.join(path.dirname(PROJECT), '.tavernsyn-usb-tests'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'usb-integration-'));
const archive = path.join(root, 'source.tar');
await run('git', ['-C', ST, 'archive', '--format=tar', '--output', archive, '06bde939fb1e9c4c8d8641d810f0a916b5bce127']);
const checks = [], sessions = [], servers = [];
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
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
    await atomicJson(path.join(directory, 'data/default-user/worlds/usb-fixture.json'), { entries: { 0: { uid: 0, key: ['usb'], content: `world from ${name}`, constant: false, order: 100, position: 0, disable: false } } });
    await atomicJson(path.join(directory, 'data/default-user/secrets.json'), { fake_test_key: 'USB_SYNTHETIC_NOT_A_SECRET' });
    await install({ st: directory, state });
    const configDevice = await readJson(path.join(state, 'device.json'));
    Object.assign(configDevice, { deviceName: name, restoreDependencies: false });
    await atomicJson(path.join(state, 'device.json'), configDevice);
    return loadDevice(state);
}
async function pair(computer, phone, direction) {
    const host = await new UsbSession(computer).open(), peer = await new UsbSession(phone).open();
    sessions.push(host, peer);
    const server = await startUsbServer(peer, { port: 0 }); servers.push(server);
    const result = await syncUsb(host, { origin: `http://127.0.0.1:${server.port}`, token: server.token, direction,
        confirmPeer: async identity => { assert.equal(identity.deviceId, phone.deviceId); } });
    assert.equal(result.result.applied, true); assert.equal(result.result.maintenancePending, false);
    await server.closed; await host.close(); await peer.close();
    return { host, peer, result };
}

try {
    const computer = await makeDevice('computer'), phone = await makeDevice('phone');
    const profile = d => path.join(d.dataRoot, d.profile);
    await fs.writeFile(path.join(profile(phone), 'target-only.txt'), 'must be deleted on mirror');
    await fs.mkdir(path.join(profile(computer), 'images'), { recursive: true });
    await fs.writeFile(path.join(profile(computer), 'images/USB 图片.bin'), Buffer.alloc(1024 * 1024, 0x73));
    const plugin = path.join(computer.install, 'plugins/usb-health-fixture'); await fs.mkdir(plugin);
    await fs.writeFile(path.join(plugin, 'index.mjs'), "export const info={id:'usb-health-fixture',name:'USB fixture',description:'Synthetic'}; export async function init(){};\n");
    const initialPhone = await portableState(phone);
    const push = await pair(computer, phone, 'push');
    assert.equal(await exists(path.join(profile(phone), 'target-only.txt')), false);
    assert.equal((await readJson(path.join(profile(phone), 'settings.json'))).power_user.chat_width, 43);
    assert.equal(await exists(path.join(phone.install, 'plugins/usb-health-fixture/index.mjs')), true);
    assert.equal((await fs.stat(path.join(profile(phone), 'images/USB 图片.bin'))).size, 1024 * 1024);
    assert.equal((await recoveryStatus(phone)).available, true);
    assert.equal(push.peer.lifecycle.stopped, true);
    assert.equal(await exists(path.join(phone.state, 'instance.lock')), false);
    checks.push('computer_to_phone_real_http_full_mirror_and_actual_st_health');
    // Restore is the same durable journal used by the existing UI action.
    await rollback(phone, await readJson(path.join(phone.state, 'apply.json')));
    assert.equal((await portableState(phone)).digest, initialPhone.digest);
    checks.push('usb_backup_restores_original_target');
    // The second operation exercises the reverse streaming path and replaces a
    // consumed recovery journal with one current recovery point.
    await fs.writeFile(path.join(profile(phone), 'phone-new.txt'), 'reverse direction');
    const beforeComputer = await portableState(computer);
    const pull = await pair(computer, phone, 'pull');
    assert.equal(await fs.readFile(path.join(profile(computer), 'phone-new.txt'), 'utf8'), 'reverse direction');
    assert.equal(await exists(path.join(profile(computer), 'images/USB 图片.bin')), false);
    assert.equal((await readJson(path.join(profile(computer), 'settings.json'))).power_user.chat_width, 77);
    assert.equal((await recoveryStatus(computer)).available, true);
    assert.equal(pull.host.lifecycle.stopped, true);
    await rollback(computer, await readJson(path.join(computer.state, 'apply.json')));
    assert.equal((await portableState(computer)).digest, beforeComputer.digest);
    checks.push('phone_to_computer_real_http_full_mirror_and_actual_st_health');
    checks.push('both_directions_preserve_local_fields_and_recover_latest_backup');
    const report = { date: new Date().toISOString(), platform: process.platform, node: process.version,
        sillyTavern: '1.19.0', commit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127', passed: true, checks,
        hardwareUsb: false, note: 'Real loopback HTTP and actual SillyTavern lifecycle; ADB and physical Windows/Android hardware not exercised.' };
    const target = process.env.TAVERNSYN_USB_TEST_REPORT ?? path.join(root, 'results.json');
    await atomicJson(target, report); console.log(JSON.stringify(report, null, 2));
} finally {
    for (const server of servers) await server.close().catch(() => {});
    for (const session of sessions) {
        if (session.lifecycle.child && !session.lifecycle.stopped) await session.lifecycle.close().catch(() => {});
        await session.close().catch(() => {});
    }
}
