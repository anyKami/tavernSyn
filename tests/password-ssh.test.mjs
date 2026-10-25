// Real OpenSSH password authentication and rsync over a loopback SSH test server.
// The JS server supplies protocol fixtures; Linux dispatcher/flock remain separate tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
import { PROJECT } from '../lib/device.mjs';
import { atomicJson, exists, readJson, run } from '../lib/io.mjs';
import { configureDevice } from '../lib/connection.mjs';
import { scan, difference, verify } from '../lib/manifest.mjs';
import { connect, environment, push, pull, rsyncShell } from '../helper/transport.mjs';
import { fixture, temporary } from './fixtures.mjs';

// PEM fixtures avoid intermittent malformed OpenSSH output from ssh2's test key generator.
const hostKey = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

test('VPS SSH account rules permit password sync only inside Tailscale and preserve other users', async t => {
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
    const sshd = process.platform === 'win32' ? path.join(runtime, 'usr/bin/sshd.exe') : '/usr/sbin/sshd';
    if (!await exists(sshd)) { t.skip('sshd is not installed'); return; }
    const root = await temporary('sshd-config');
    const posix = async file => process.platform === 'win32' ? (await run(path.join(runtime, 'usr/bin/cygpath.exe'), ['-u', file])).stdout.trim() : file;
    const script = await fs.readFile(path.join(PROJECT, 'vps/enable-password.sh'), 'utf8');
    const snippet = script.match(/cat > "\$snippet" <<EOF\n([\s\S]*?)\nEOF/)[1]
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

test('real SSH password login, automatic dataset, rsync push/pull and changed-host rejection', { timeout: 120000 }, async t => {
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
    const serverPayload = path.join(device.root, 'server-payload'); await fs.mkdir(serverPayload);
    let dataset = randomUUID(), current = null, active = null, rsyncConfig, toolEnv, server, serverOpen = false, authAttempts = 0, finishMode = 'normal';
    let inspectMode = 'normal', commitMode = 'normal', nextDataset;
    const connections = new Set(), children = new Set(), commands = [];
    const operations = [];
    async function startServer(port = 0) {
        server = new ssh2.Server({ hostKeys: [hostKey()] }, client => {
            connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
            client.on('authentication', ctx => {
                if (ctx.method === 'password') authAttempts++;
                if (ctx.method === 'password' && ctx.username === 'tavernsyn' && ctx.password === password) ctx.accept();
                else ctx.reject(['password']);
            });
            client.on('ready', () => client.on('session', accept => {
                const session = accept();
                session.on('exec', (accept, reject, info) => {
                    commands.push(info.command);
                    if (info.command === `tavernsyn-rsync-v2 ${device.deviceId} ${active?.job} --server --daemon .`) {
                        const channel = accept(); channel.on('error', () => {});
                        const child = spawn(toolEnv.rsync, ['--server', '--daemon', `--config=${rsyncConfig}`, '.'],
                            { windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
                        children.add(child); child.stdin.on('error', () => {});
                        channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
                        child.on('close', code => { children.delete(child); channel.exit(code ?? 1); channel.end(); });
                        child.on('error', () => { channel.exit(1); channel.end(); });
                        return;
                    }
                    if (info.command !== `tavernsyn-control-v1 ${device.deviceId}`) { reject(); return; }
                    const channel = accept(); channel.on('error', () => {}); channel.setEncoding('utf8');
                    let buffer = '', queue = Promise.resolve();
                    channel.on('data', text => {
                        buffer += text;
                        let index;
                        while ((index = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                            queue = queue.then(async () => {
                                const message = JSON.parse(line); operations.push(message.op); let result;
                                if (message.op === 'hello') result = { protocol: 1, capabilities: ['paused-jobs', 'job-bound-rsync'], dataset, current };
                                else if (message.op === 'begin') {
                                    assert.equal(message.jobBound, true);
                                    if (message.resumeOnly) {
                                        assert.equal(active?.job, message.job); assert.equal(message.dataset, dataset);
                                        assert.equal(message.base, active.base);
                                    } else {
                                        active = { ...message, phase: 'transfer', generation: message.direction === 'push' ? message.job : current.generation };
                                    }
                                    await fs.writeFile(path.join(device.root, 'rsync.conf'), [
                                        'use chroot = no', 'log file = /dev/null', 'timeout = 120', 'incoming chmod = Du+rwx,Fu+rw', '[payload]',
                                        `path = ${await toolEnv.posix(serverPayload)}`, 'list = false',
                                        `read only = ${message.direction === 'push' ? 'false' : 'true'}`, '',
                                    ].join('\n'));
                                    result = { job: message.job, phase: active.phase, generation: active.generation, base: active.base, ...(message.direction === 'pull' ? { manifest: current.manifest } : {}) };
                                } else if (message.op === 'inspect') {
                                    if (inspectMode === 'disconnect') {
                                        inspectMode = 'normal'; if (nextDataset) { dataset = nextDataset; nextDataset = undefined; }
                                        client.destroy(); return;
                                    }
                                    result = difference(message.manifest, await scan(serverPayload));
                                }
                                else if (message.op === 'commit') {
                                    await verify(serverPayload, message.manifest);
                                    current = { generation: active.job, digest: message.manifest.digest, manifest: message.manifest };
                                    active.phase = 'done';
                                    if (commitMode === 'disconnect') { commitMode = 'normal'; client.destroy(); return; }
                                    result = { generation: current.generation, digest: current.digest };
                                } else if (message.op === 'finish') {
                                    if (finishMode === 'disconnect') { client.destroy(); return; }
                                    if (finishMode === 'reject') {
                                        channel.write(`${JSON.stringify({ id: message.id, ok: false, code: 'PERMISSION', error: 'synthetic permission failure' })}\n`); return;
                                    }
                                    result = { phase: 'done' };
                                }
                                else throw Error('Unexpected test protocol operation');
                                channel.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
                            }).catch(() => { channel.exit(1); channel.end(); });
                        }
                    });
                });
            }));
        });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        serverOpen = true;
        return server.address().port;
    }
    const stopServer = async () => {
        for (const child of children) child.kill();
        for (const client of connections) client.destroy();
        if (serverOpen) { serverOpen = false; await new Promise(resolve => server.close(resolve)); }
    };
    t.after(stopServer);
    const port = await startServer();
    let pathSsh = false;
    const localEnvironment = async currentDevice => {
        const env = await environment(currentDevice);
        const file = path.join(device.state, 'ssh_config');
        await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('HostName 100.100.100.100', 'HostName 127.0.0.1').replace('Port 22', `Port ${port}`));
        if (pathSsh) {
            env.rsh = await rsyncShell('ssh', file, env.posix, 'android');
            if (process.platform === 'win32') env.authEnv.PATH = path.dirname(device.tools.ssh) + path.delimiter + process.env.PATH;
        }
        toolEnv = env; rsyncConfig = await env.posix(path.join(device.root, 'rsync.conf'));
        return env;
    };
    let session = await connect(device, localEnvironment);
    const transferLog = [];
    session.log = message => transferLog.push(message);
    assert.equal(device.remote.dataset, dataset); assert.equal((await readJson(path.join(device.state, 'device.json'))).remote.dataset, dataset);
    assert.equal(await exists(device.remote.knownHostsFile), true);
    const argsAndEnv = JSON.stringify({ commands, env: session.env.authEnv, ssh: await fs.readFile(path.join(device.state, 'ssh_config'), 'utf8') });
    assert.ok(!argsAndEnv.includes(password));
    await assert.rejects(run(process.execPath, [path.join(PROJECT, 'helper/askpass.mjs'), 'Confirm host identity?'], { env: session.env.authEnv }));
    const payload = path.join(device.root, 'source'); await fs.mkdir(path.join(payload, 'profile'), { recursive: true });
    await atomicJson(path.join(payload, 'profile/settings.json'), { value: 'synthetic SSH push/pull' });
    await fs.writeFile(path.join(payload, 'profile/世界书.txt'), 'Unicode content over password SSH\n'.repeat(500));
    const manifest = await scan(payload);
    const pushed = await push(session, device, randomUUID(), payload, manifest);
    assert.equal(pushed.digest, manifest.digest); session.control.close();
    session = await connect(device, localEnvironment);
    session.log = message => transferLog.push(message);
    const target = path.join(device.root, 'download');
    const pulled = await pull(session, device, randomUUID(), target);
    assert.equal(pulled.manifest.digest, manifest.digest); await verify(target, manifest); session.control.close();
    assert.ok(commands.some(command => command.startsWith('tavernsyn-rsync-v2 ')));
    assert.ok(transferLog.some(line => line.includes('rsync 上传开始')));
    assert.ok(transferLog.some(line => line.includes('rsync 下载开始')));
    assert.ok(transferLog.some(line => line.includes('世界书.txt')));
    assert.ok(transferLog.some(line => line.includes('校验通过')));
    assert.ok(!transferLog.join('\n').includes(password));
    assert.ok(authAttempts >= 4);
    // Reproduce loss after a successful real rsync and a lost commit ACK. Both
    // must authenticate again, reclaim this job and avoid another rsync round.
    for (const mode of ['inspect', 'commit']) {
        await fs.writeFile(path.join(payload, `reconnect-${mode}.txt`), `synthetic ${mode} disconnect`);
        const expected = await scan(payload), progress = [], recoveryLog = [];
        session = await connect(device, localEnvironment, line => recoveryLog.push(line));
        if (mode === 'inspect') inspectMode = 'disconnect'; else commitMode = 'disconnect';
        const transfersBefore = commands.filter(command => command.startsWith('tavernsyn-rsync-v2 ')).length;
        const resumed = await push(session, device, randomUUID(), payload, expected, value => progress.push(value));
        assert.equal(resumed.digest, expected.digest); await verify(serverPayload, expected);
        assert.equal(commands.filter(command => command.startsWith('tavernsyn-rsync-v2 ')).length - transfersBefore, 1);
        assert.ok(progress.some(value => value.stage === 'transferred' && value.stats.sentBytes > 0));
        assert.ok(recoveryLog.some(line => line.includes('SSH 已恢复同一上传任务')));
        assert.ok(recoveryLog.some(line => line.includes('SSH 控制进程退出')));
        session.control.close();
    }
    // Later pull cases use the publication that now includes both fixture files.
    const recoveredManifest = await scan(payload);
    // Reproduce a closed control SSH while real rsync has delivered all files.
    session = await connect(device, localEnvironment);
    const closedSession = session, closedLog = [];
    session.log = line => { closedLog.push(line); if (line === 'rsync 下载结束') closedSession.control.child.kill(); };
    const closedTarget = path.join(device.root, 'closed-control/download');
    const closedPull = await pull(session, device, randomUUID(), closedTarget);
    await verify(closedTarget, recoveredManifest);
    assert.equal(closedPull.manifest.digest, recoveredManifest.digest); assert.equal(session.control.closed, true);
    assert.ok(closedLog.some(line => line.includes('继续准备应用')));
    assert.equal((await readJson(path.join(device.root, 'closed-control/manifest.json'))).digest, recoveredManifest.digest);
    assert.equal((await readJson(path.join(device.root, 'closed-control/download.json'))).generation, current.generation);
    session.control.close();
    // Also cover a lost ACK after the server receives finish, and keep real
    // permission errors and corrupt downloads fatal.
    finishMode = 'disconnect';
    session = await connect(device, localEnvironment);
    const lostTarget = path.join(device.root, 'lost-ack/download');
    await pull(session, device, randomUUID(), lostTarget); await verify(lostTarget, recoveredManifest); session.control.close();
    finishMode = 'reject'; session = await connect(device, localEnvironment);
    await assert.rejects(pull(session, device, randomUUID(), path.join(device.root, 'rejected/download')), { code: 'PERMISSION' });
    session.control.close(); finishMode = 'normal';
    await fs.writeFile(path.join(serverPayload, 'profile/settings.json'), '{"corrupt":true}');
    session = await connect(device, localEnvironment);
    const finishes = operations.filter(op => op === 'finish').length;
    await assert.rejects(pull(session, device, randomUUID(), path.join(device.root, 'corrupt/download')), { code: 'INTEGRITY' });
    assert.equal(operations.filter(op => op === 'finish').length, finishes, 'corrupt content must not reach finish');
    session.control.close();
    await fs.copyFile(path.join(payload, 'profile/settings.json'), path.join(serverPayload, 'profile/settings.json'));
    // Exercise Termux/POSIX's bare PATH command with real rsync, even on Windows/MSYS2.
    // There deliberately is no ssh executable in the process working directory.
    assert.equal(await exists(path.resolve('ssh')), false);
    pathSsh = true;
    session = await connect(device, localEnvironment);
    await fs.writeFile(path.join(payload, 'profile/PATH-only.txt'), 'resolved outside the SillyTavern working directory');
    const pathManifest = await scan(payload);
    assert.equal((await push(session, device, randomUUID(), payload, pathManifest)).digest, pathManifest.digest);
    session.control.close();
    session = await connect(device, localEnvironment);
    const pathTarget = path.join(device.root, 'PATH-download');
    await pull(session, device, randomUUID(), pathTarget); await verify(pathTarget, pathManifest);
    session.control.close(); pathSsh = false;
    // Authentication to another dataset during recovery must not publish bytes.
    session = await connect(device, localEnvironment);
    const originalDataset = dataset, commitsBefore = operations.filter(op => op === 'commit').length;
    inspectMode = 'disconnect'; nextDataset = randomUUID();
    await assert.rejects(push(session, device, randomUUID(), payload, pathManifest), { code: 'REMOTE_DATASET' });
    assert.equal(operations.filter(op => op === 'commit').length, commitsBefore);
    session.control.close(); dataset = originalDataset;
    const pinned = device.remote.dataset; dataset = randomUUID();
    await assert.rejects(connect(device, localEnvironment), { code: 'REMOTE_DATASET' });
    assert.equal(device.remote.dataset, pinned); dataset = pinned;
    await atomicJson(device.remote.passwordFile, { password: 'wrong synthetic password' });
    await assert.rejects(connect(device, localEnvironment), { code: 'SSH' });
    await atomicJson(device.remote.passwordFile, { password });
    await stopServer(); await startServer(port);
    const before = authAttempts;
    await assert.rejects(connect(device, localEnvironment), { code: 'SSH' });
    assert.equal(authAttempts, before, 'a changed host must be rejected before the password is sent');
});
