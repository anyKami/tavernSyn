// Real ST processes and real loopback streaming. ADB hardware is deliberately
// outside this fixture; USB tunnel selection is covered by usb-adb.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { install } from '../bin/install.mjs';
import { UsbSession } from '../helper/usb-sync.mjs';
import { UsbController } from '../helper/usb-controller.mjs';
import { Lifecycle } from '../helper/lifecycle.mjs';
import { Manager } from '../helper/manager.mjs';
import { hashFile } from '../lib/manifest.mjs';
import { startUsbServer, syncUsb } from '../helper/usb-service.mjs';
import { portableState } from '../lib/snapshot.mjs';
import { recoveryStatus, rollback } from '../helper/apply.mjs';
import { ST, YAML } from './fixtures.mjs';

const parent = process.env.TMPDIR ?? path.join(path.dirname(PROJECT), '.tavernsyn-usb-tests'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'usb-integration-'));
const archive = path.join(root, 'source.tar');
await run('git', ['-C', ST, 'archive', '--format=tar', '--output', archive, '06bde939fb1e9c4c8d8641d810f0a916b5bce127']);
const checks = [], sessions = [], servers = [], cliChildren = [];
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
    const observedBytes = new Map();
    for (const endpoint of [host, peer]) {
        const progress = endpoint.manager.progress;
        endpoint.manager.progress = value => {
            if (Number.isSafeInteger(value.bytes)) observedBytes.set(endpoint, value.bytes);
            return progress.call(endpoint.manager, value);
        };
    }
    const server = await startUsbServer(peer, { port: 0 }); servers.push(server);
    const result = await syncUsb(host, { origin: `http://127.0.0.1:${server.port}`, token: server.token, direction,
        confirmPeer: async identity => { assert.equal(identity.deviceId, phone.deviceId); } });
    assert.equal(result.result.applied, true); assert.equal(result.result.maintenancePending, false);
    // Both sides must expose real file-content progress, not a synthetic timer.
    for (const session of [host, peer]) {
        const job = session.manager.job;
        assert.ok(job.bytes > 0 && Number.isSafeInteger(observedBytes.get(session)),
            'send and receive must each report real file content bytes before completion');
        assert.equal(observedBytes.get(session), job.bytes, 'transfer byte counter must match the manifest');
    }
    await server.closed; await host.close(); await peer.close();
    return { host, peer, result };
}

function launchCli(args, readyText) {
    const child = spawn(process.execPath, [path.join(PROJECT, 'bin/usb.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`USB CLI timed out:\n${output}`)); }, 120000);
        const collect = chunk => { output += chunk; if (readyText && output.includes(readyText)) readyResolve(); };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', collect); child.stderr.on('data', collect);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
    done.catch(() => {});
    const entry = { child, done, ready: Promise.race([ready, done.then(result => { throw new Error(`USB CLI exited before ready (${result.code}):\n${result.output}`); })]) };
    entry.ready.catch(() => {}); cliChildren.push(entry); return entry;
}

async function cliPair(computer, phone, direction, selectedBy) {
    const port = await freePort(), adb = path.join(root, `adb-fixture-${direction}`), serial = 'USB_CLI_FIXTURE';
    // The real CLI and real HTTP service run in separate processes. Only ADB's
    // USB forwarding commands are simulated; no attached hardware is assumed.
    await fs.writeFile(adb, `#!${process.execPath}\nconst a=process.argv.slice(2);let s='';\n`
        + `if(a.includes('get-serialno'))s=${JSON.stringify(serial)};else if(a.includes('get-state'))s='device';else if(a.includes('get-devpath'))s='usb:fixture';\n`
        + `else if(a.includes('forward')&&a.includes('--list'))s=${JSON.stringify(`${serial} tcp:${port} tcp:${port}`)};\n`
        + `else if(a.includes('forward')&&a.includes('--remove'))s='';else if(a.includes('forward')&&a.includes('tcp:0'))s=${JSON.stringify(String(port))};else process.exit(2);\nprocess.stdout.write(s+'\\n');\n`, { mode: 0o700 });
    const phoneCli = launchCli(['--state', phone.state, '--mode', 'serve', '--port', String(port),
        ...(selectedBy === 'phone' ? ['--direction', direction] : [])], '手机 USB 入口已就绪');
    await phoneCli.ready;
    const computerCli = launchCli(['--state', computer.state, '--mode', 'client', '--port', String(port), '--adb', adb,
        ...(selectedBy === 'computer' ? ['--direction', direction] : [])]);
    const results = await Promise.all([computerCli.done, phoneCli.done]);
    for (const result of results) {
        assert.equal(result.code, 0, result.output);
        assert.match(result.output, new RegExp(`已由${selectedBy === 'phone' ? '手机' : '电脑'}选择：${direction === 'push' ? '电脑 → 手机' : '手机 → 电脑'}`));
        assert.doesNotMatch(result.output, /本次配对码|请输入.*配对|输入 YES|--token|--confirm/);
    }
    for (const device of [computer, phone]) for (const lock of ['launcher.lock', 'operation.lock', 'instance.lock']) assert.equal(await exists(path.join(device.state, lock)), false);
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
    if (process.platform !== 'win32') {
        await fs.writeFile(path.join(profile(computer), 'cli-computer.txt'), 'chosen on computer');
        await cliPair(computer, phone, 'push', 'computer');
        assert.equal(await fs.readFile(path.join(profile(phone), 'cli-computer.txt'), 'utf8'), 'chosen on computer');
        checks.push('real_cli_computer_choice_auto_connects_and_applies_without_token_or_confirmation');
        await fs.writeFile(path.join(profile(phone), 'cli-phone.txt'), 'chosen on phone');
        await fs.unlink(path.join(profile(phone), 'cli-computer.txt'));
        await cliPair(computer, phone, 'pull', 'phone');
        assert.equal(await fs.readFile(path.join(profile(computer), 'cli-phone.txt'), 'utf8'), 'chosen on phone');
        assert.equal(await exists(path.join(profile(computer), 'cli-computer.txt')), false);
        checks.push('real_cli_phone_choice_controls_waiting_computer_with_same_direction_meaning');
    }

    // The browser-driven flow must be tested while both actual ST processes
    // are running. Only physical ADB is simulated by a localhost tunnel.
    async function managedPair(direction, chooser) {
        const port = await freePort(), instances = [];
        async function createManaged(device, mode) {
            let manager;
            const lifecycle = new Lifecycle(device, (action, payload) => manager.action(action, payload));
            manager = new Manager(device, lifecycle);
            const leaseFile = path.join(device.state, 'launcher.lock');
            await atomicJson(leaseFile, { pid: process.pid, nonce: randomUUID() });
            const usb = new UsbController(device, lifecycle, manager, { mode, port, log: () => {},
                adapter: mode === 'client' ? { connectUsb: async () => ({ origin: 'http://127.0.0.1:' + port + '/', close: async () => {} }) } : {},
            });
            manager.usb = usb;
            // The fixture has no browser. Return a genuine on-disk hash receipt.
            lifecycle.receipt = async nonce => {
                const file = path.join(device.dataRoot, device.profile, 'settings.json');
                return { nonce, created: Date.now(), files: [{ path: file, sha256: await hashFile(file) }] };
            };
            const instance = { device, lifecycle, manager, usb, leaseFile };
            instances.push(instance);
            await lifecycle.start();
            return instance;
        }
        const until = async (predicate, label) => {
            const deadline = Date.now() + 90000;
            while (Date.now() < deadline) {
                if (predicate()) return;
                if (instances.some(x => x.usb.stage === 'failed')) throw new Error(label + ': ' +
                    instances.map(x => x.device.deviceName + ':' + x.usb.stage + ':' + (x.usb.error?.message || '')).join('; '));
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Timed out: ' + label + ' / ' + instances.map(x => x.usb.stage).join(','));
        };
        try {
            const phoneApp = await createManaged(phone, 'serve');
            const computerApp = await createManaged(computer, 'client');
            const uuid = () => randomUUID();
            await phoneApp.usb.connect({ receipt: uuid(), tab: uuid() });
            await computerApp.usb.connect({ receipt: uuid(), tab: uuid() });
            await until(() => instances.every(x => x.usb.stage === 'connected'), 'both connected with live ST');
            assert.equal(instances.every(x => !x.lifecycle.stopped), true);
            await (chooser === 'phone' ? phoneApp.usb : computerApp.usb).select(direction);
            await until(() => instances.every(x => x.usb.stage === 'completed' && !x.manager.busy), 'both completed and restarted');
            assert.equal(instances.every(x => !x.lifecycle.stopped), true);
            for (const instance of instances) {
                const response = await fetch(instance.device.origin, { redirect: 'manual' });
                assert.ok([200, 302].includes(response.status));
                assert.equal(response.headers.get('x-tavernsyn-epoch'), instance.lifecycle.nonce);
                await response.arrayBuffer();
            }
        } finally {
            for (const instance of instances.reverse()) {
                await instance.usb.cancelForExit().catch(() => {});
                await instance.lifecycle.close().catch(() => {});
                await fs.unlink(instance.leaseFile).catch(() => {});
            }
        }
    }
    if (process.platform !== 'win32') {
        await fs.writeFile(path.join(profile(computer), 'plugin-ui-computer.txt'), 'computer controls USB UI');
        await managedPair('push', 'computer');
        assert.equal(await fs.readFile(path.join(profile(phone), 'plugin-ui-computer.txt'), 'utf8'), 'computer controls USB UI');
        checks.push('plugin_ui_pc_selects_direction_with_both_real_st_servers_running_then_restarts_both');
        await fs.writeFile(path.join(profile(phone), 'plugin-ui-phone.txt'), 'phone controls USB UI');
        await managedPair('pull', 'phone');
        assert.equal(await fs.readFile(path.join(profile(computer), 'plugin-ui-phone.txt'), 'utf8'), 'phone controls USB UI');
        checks.push('plugin_ui_phone_selects_direction_with_both_real_st_servers_running_then_restarts_both');
    }

    const report = { date: new Date().toISOString(), platform: process.platform, node: process.version,
        sillyTavern: '1.19.0', commit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127', passed: true, checks,
        hardwareUsb: false, note: 'Real loopback HTTP, CLI processes and actual SillyTavern lifecycle; CLI ADB forwarding is simulated. Physical Windows/Android hardware not exercised.' };
    const target = process.env.TAVERNSYN_USB_TEST_REPORT ?? path.join(root, 'results.json');
    await atomicJson(target, report); console.log(JSON.stringify(report, null, 2));
} finally {
    for (const entry of cliChildren) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
        await entry.done.catch(() => {});
    }
    for (const server of servers) await server.close().catch(() => {});
    for (const session of sessions) {
        if (session.lifecycle.child && !session.lifecycle.stopped) await session.lifecycle.close().catch(() => {});
        await session.close().catch(() => {});
    }
}
