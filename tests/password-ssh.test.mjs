// OpenSSH authentication and hybrid negotiation against a loopback SSH test server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { PROJECT } from '../lib/device.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { configureDevice } from '../lib/connection.mjs';
import { connect, environment } from '../helper/transport.mjs';
import { fixture, temporary } from './fixtures.mjs';

// PEM fixtures avoid intermittent malformed OpenSSH output from ssh2's test key generator.
const hostKey = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
// ssh2's server connection exposes end(), not destroy(). The test deliberately
// destroys its owned TCP socket to reproduce a transport reset rather than EOF.
const disconnect = client => client._sock.destroy();

test('VPS SSH account rules permit password sync only inside Tailscale and preserve other users', async t => {
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
    const sshd = process.platform === 'win32' ? path.join(runtime, 'usr/bin/sshd.exe') : '/usr/sbin/sshd';
    if (!await exists(sshd)) { t.skip('sshd is not installed'); return; }
    const root = await temporary('sshd-config');
    const posix = async file => process.platform === 'win32' ? (await run(path.join(runtime, 'usr/bin/cygpath.exe'), ['-u', file])).stdout.trim() : file;
    const script = await fs.readFile(path.join(PROJECT, 'vps/enable-password.sh'), 'utf8');
    const snippet = script.replaceAll('\r\n', '\n').match(/cat > "\$snippet" <<EOF\n([\s\S]*?)\nEOF/)[1]
        .replaceAll('$sync_user', 'tavernsyn').replaceAll('$store_root', '/srv/tavernsyn-sync');
    const accountFile = path.join(root, 'account.conf'), config = path.join(root, 'sshd_config'), hostKey = path.join(root, 'hostkey');
    await fs.writeFile(hostKey, generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey, { mode: 0o600 });
    await fs.writeFile(accountFile, snippet + '\n');
    await fs.writeFile(config, `Port 22\nHostKey "${await posix(hostKey)}"\nPasswordAuthentication no\nPubkeyAuthentication yes\nSubsystem sftp internal-sftp\nMatch all\nInclude "${await posix(accountFile)}"\n`);
    const effective = async (user, source) => (await run(sshd, ['-T', '-f', await posix(config), '-C',
        `user=${user},host=fixture,addr=${source},laddr=100.64.0.2,lport=22`])).stdout.replace(/^[^ \n]+/gm, keyword => keyword.toLowerCase());
    const inside = await effective('tavernsyn', '100.64.0.1');
    assert.match(inside, /^passwordauthentication yes$/m); assert.match(inside, /^pubkeyauthentication no$/m);
    assert.match(inside, /^disableforwarding yes$/m); assert.doesNotMatch(inside, /^denyusers \*$/m);
    assert.match(inside, /^clientaliveinterval 15$/m); assert.match(inside, /^clientalivecountmax 3$/m);
    assert.match(inside, /^forcecommand .*password-dispatcher.py --root \/srv\/tavernsyn-sync$/m);
    assert.match(await effective('tavernsyn', '203.0.113.1'), /^denyusers \*$/m);
    assert.doesNotMatch(await effective('tavernsyn', 'fd7a:115c:a1e0::1'), /^denyusers \*$/m);
    const admin = await effective('fixture-admin', '203.0.113.1');
    assert.match(admin, /^passwordauthentication no$/m); assert.match(admin, /^pubkeyauthentication yes$/m);
    assert.match(admin, /^forcecommand none$/m); assert.doesNotMatch(admin, /^denyusers \*$/m);
});

test('real SSH password login negotiates hybrid, pins the dataset and rejects old peers and changed hosts', { timeout: 60000 }, async t => {
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
    if (process.platform === 'win32' && !await exists(path.join(runtime, 'usr/bin/ssh.exe'))) {
        t.skip('Set TAVERNSYN_TEST_RUNTIME to an existing MSYS2 runtime to exercise Windows OpenSSH'); return;
    }
    const device = await fixture(); delete device.remote;
    const oldState = device.state; device.state = path.join(device.root, "state 空格 and ' quote"); await fs.rename(oldState, device.state);
    if (process.platform === 'win32') device.tools = { ssh: path.join(runtime, 'usr/bin/ssh.exe'), rsync: path.join(runtime, 'usr/bin/rsync.exe') };
    await atomicJson(path.join(device.state, 'device.json'), { format: 1, deviceId: device.deviceId, install: device.install, profile: device.profile });
    const password = ' synthetic 密码 \'"$`\\ ! ';
    await configureDevice(device, 'configure', { host: '100.100.100.100', user: 'tavernsyn', password });
    let dataset = randomUUID(), legacy = true, server, authAttempts = 0;
    const clients = new Set(), commands = [], messages = [];
    async function startServer(port = 0) {
        server = new ssh2.Server({ hostKeys: [hostKey()] }, client => {
            clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
            client.on('authentication', ctx => {
                if (ctx.method === 'password') authAttempts++;
                if (ctx.method === 'password' && ctx.username === 'tavernsyn' && ctx.password === password) ctx.accept();
                else ctx.reject(['password']);
            });
            client.on('ready', () => client.on('session', accept => {
                accept().on('exec', (accept, reject, info) => {
                    commands.push(info.command);
                    if (info.command !== `tavernsyn-control-v1 ${device.deviceId}`) { reject(); return; }
                    const channel = accept(); channel.on('error', () => {}); channel.setEncoding('utf8');
                    let buffer = '';
                    channel.on('data', chunk => {
                        buffer += chunk;
                        let index;
                        while ((index = buffer.indexOf('\n')) !== -1) {
                            const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
                            messages.push(message);
                            const result = { protocol: 1, capabilities: ['job-bound-rsync'], dataset, current: null };
                            if (!legacy) { result.hybridProtocol = 'hybrid-v1'; result.capabilities.push('hybrid-v1'); }
                            channel.write(JSON.stringify({ id: message.id, ok: true, result }) + '\n');
                        }
                    });
                });
            }));
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        return server.address().port;
    }
    async function stopServer() {
        for (const client of clients) disconnect(client);
        await new Promise(resolve => server.close(resolve));
    }
    t.after(stopServer);
    const port = await startServer();
    const localEnvironment = async current => {
        const env = await environment(current);
        const config = path.join(device.state, 'ssh_config');
        await fs.writeFile(config, (await fs.readFile(config, 'utf8')).replace('HostName 100.100.100.100', 'HostName 127.0.0.1').replace('Port 22', `Port ${port}`));
        return env;
    };
    await assert.rejects(connect(device, localEnvironment), { code: 'UPGRADE_REQUIRED' });
    assert.equal(device.remote.dataset, '');
    assert.deepEqual(messages.map(({ op, requiredProtocol }) => [op, requiredProtocol]), [['hello', 'hybrid-v1']]);
    assert.ok(commands.every(command => command.startsWith('tavernsyn-control-v1 ')));
    legacy = false;
    const session = await connect(device, localEnvironment);
    session.control.close();
    assert.equal(device.remote.dataset, dataset);
    assert.equal((await readJson(path.join(device.state, 'device.json'))).remote.dataset, dataset);
    assert.equal(await exists(device.remote.knownHostsFile), true);
    const exposed = JSON.stringify({ commands, env: session.env.authEnv, ssh: await fs.readFile(path.join(device.state, 'ssh_config'), 'utf8') });
    assert.ok(!exposed.includes(password));
    await assert.rejects(run(process.execPath, [path.join(PROJECT, 'helper/askpass.mjs'), 'Confirm host identity?'], { env: session.env.authEnv }));
    const pinned = dataset; dataset = randomUUID();
    await assert.rejects(connect(device, localEnvironment), { code: 'REMOTE_DATASET' });
    await assert.rejects(session.reconnect(), { code: 'REMOTE_DATASET' });
    assert.equal(device.remote.dataset, pinned); dataset = pinned;
    await atomicJson(device.remote.passwordFile, { password: 'wrong synthetic password' });
    await assert.rejects(connect(device, localEnvironment), { code: 'SSH' });
    await atomicJson(device.remote.passwordFile, { password });
    await stopServer(); await startServer(port);
    const before = authAttempts;
    await assert.rejects(connect(device, localEnvironment), { code: 'SSH' });
    assert.equal(authAttempts, before, 'a changed host must be rejected before the password is sent');
});
