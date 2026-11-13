// Real OpenSSH password authentication and rsync over a loopback SSH test server.
// The JS server supplies protocol fixtures; Linux dispatcher/flock remain separate tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
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
    let inspectMode = 'normal', commitMode = 'normal', nextDataset, rsyncMode = 'normal', session, safeInspect = true;
    const transferLog = [], downloadLogs = [];
    const connections = new Set(), children = new Set(), commands = [];
    const operations = [];
    const beginRequests = [];
    const downloadTarget = job => path.join(device.state, 'jobs', job, 'payload');
    const senderFile = path.join(serverPayload, 'profile/settings.json');
    const serverPartialDirectory = path.join(serverPayload, 'profile/.tavernsyn-partial');
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
                        const interrupt = rsyncMode === 'disconnect'; rsyncMode = 'normal';
                        const child = spawn(toolEnv.rsync, ['--server', '--daemon', `--config=${rsyncConfig}`, '.'],
                            { windowsHide: true, env: { ...process.env, LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
                        children.add(child); child.stdin.on('error', () => {});
                        channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
                        if (interrupt) {
                            let greeting = '', cut = false;
                            child.stdout.on('data', chunk => {
                                greeting = (greeting + chunk.toString()).slice(-1024);
                                if (!cut && greeting.includes('@RSYNCD: OK')) {
                                    cut = true; child.stdout.pause();
                                    setTimeout(() => { disconnect(client); child.kill(); }, 50);
                                }
                            });
                        }
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
                                if (message.op === 'hello') result = { protocol: 1, capabilities: ['paused-jobs', 'job-bound-rsync', ...(safeInspect ? ['inspect-preserves-partials'] : [])], dataset, current };
                                else if (message.op === 'begin') {
                                    beginRequests.push(message);
                                    assert.equal(message.jobBound, true);
                                    if (message.resumeOnly) {
                                        assert.equal(active?.job, message.job); assert.equal(message.dataset, dataset);
                                        assert.equal(message.base, active.base);
                                    } else {
                                        active = { ...message, phase: 'transfer', generation: message.direction === 'push' ? message.job : current.generation };
                                    }
                                    await fs.writeFile(path.join(device.root, 'rsync.conf'), [
                                        'use chroot = no', 'log file = /dev/null', `lock file = ${await toolEnv.posix(path.join(device.root, 'rsync.lock'))}`, 'timeout = 120', 'incoming chmod = Du+rwx,Fu+rw', '[payload]',
                                        `path = ${await toolEnv.posix(serverPayload)}`, 'list = false',
                                        `read only = ${message.direction === 'push' ? 'false' : 'true'}`, '',
                                    ].join('\n'));
                                    result = { job: message.job, direction: active.direction, phase: active.phase, generation: active.generation, base: active.base, ...(message.direction === 'pull' ? { manifest: current.manifest } : {}) };
                                } else if (message.op === 'inspect') {
                                    if (!safeInspect) await fs.rm(serverPartialDirectory, { force: true, recursive: true });
                                    if (inspectMode === 'disconnect') {
                                        inspectMode = 'normal'; if (nextDataset) { dataset = nextDataset; nextDataset = undefined; }
                                        disconnect(client); return;
                                    }
                                    if (inspectMode === 'interrupt-correction') {
                                        inspectMode = 'normal';
                                        const bytes = await fs.readFile(senderFile);
                                        bytes[0] ^= 1;
                                        await fs.writeFile(senderFile, bytes);
                                        rsyncMode = 'disconnect';
                                    }
                                    result = difference(message.manifest, await scan(serverPayload, { ignorePartials: true }));
                                }
                                else if (message.op === 'commit') {
                                    await fs.rm(serverPartialDirectory, { force: true, recursive: true });
                                    await verify(serverPayload, message.manifest);
                                    current = { generation: active.job, digest: message.manifest.digest, manifest: message.manifest };
                                    active.phase = 'done';
                                    if (commitMode === 'disconnect') { commitMode = 'normal'; disconnect(client); return; }
                                    result = { generation: current.generation, digest: current.digest };
                                } else if (message.op === 'finish') {
                                    if (finishMode === 'disconnect') { disconnect(client); return; }
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
        for (const client of connections) disconnect(client);
        if (serverOpen) { serverOpen = false; await new Promise(resolve => server.close(resolve)); }
    };
    t.after(async () => {
        if (process.env.TAVERNSYN_TEST_DEBUG) t.diagnostic(transferLog.slice(-20).join('\n'));
        session?.control.close();
        await stopServer();
    });
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
    try {
    session = await connect(device, localEnvironment);
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
    const pullJob = randomUUID(), target = downloadTarget(pullJob);
    const pulled = await pull(session, device, pullJob, target);
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
    // Initial and SHA-256 corrective rsync both lose their SSH sockets. The
    // already uploaded bytes and the job UUID survive both retries.
    session = await connect(device, localEnvironment);
    const interruptedJob = randomUUID();
    const serverPartial = path.join(serverPayload, 'profile/.tavernsyn-partial/retained');
    await fs.mkdir(path.dirname(serverPartial), { recursive: true });
    await fs.writeFile(serverPartial, 'synthetic partial bytes');
    const retainedPartials = [], uploadBegins = beginRequests.length;
    session.log = line => {
        if (line.includes('上传连接中断')) retainedPartials.push(existsSync(serverPartial));
    };
    rsyncMode = 'disconnect';
    let uploadPlans = 0;
    const recoveredUpload = await push(session, device, interruptedJob, payload, recoveredManifest, undefined, undefined, {
        onPlan: async plan => {
            uploadPlans++;
            assert.deepEqual(plan, { files: 0, bytes: 0 });
            assert.equal(await fs.readFile(serverPartial, 'utf8'), 'synthetic partial bytes');
            inspectMode = 'interrupt-correction';
        },
    });
    assert.equal(uploadPlans, 1);
    assert.deepEqual(retainedPartials, [true, true]);
    assert.deepEqual(beginRequests.slice(uploadBegins).map(({ job, resumeOnly }) => [job, resumeOnly === true]),
        [[interruptedJob, false], [interruptedJob, true], [interruptedJob, true]]);
    assert.equal(recoveredUpload.stats.reconnects, 2);
    assert.equal(recoveredUpload.stats.interruptedTransfers, 2);
    assert.equal(recoveredUpload.stats.incompleteNetworkStats, true);
    await verify(serverPayload, recoveredManifest);
    session.control.close();
    safeInspect = false;
    session = await connect(device, localEnvironment);
    await fs.mkdir(path.dirname(serverPartial), { recursive: true });
    await fs.writeFile(serverPartial, 'synthetic partial bytes on an old receiver');
    let partialAtRsyncStart = false;
    session.log = line => {
        if (line.startsWith('rsync 上传开始')) partialAtRsyncStart = existsSync(serverPartial);
    };
    await push(session, device, randomUUID(), payload, recoveredManifest, undefined, undefined, {
        onPlan: () => assert.fail('older VPS inspect mutates partials and must be skipped before transfer'),
    });
    assert.equal(partialAtRsyncStart, true);
    await verify(serverPayload, recoveredManifest);
    session.control.close();
    safeInspect = true;
    // Interrupt the real rsync SSH channel, then reclaim the same download.
    // Existing partials survive the failure and only disappear after validation.
    session = await connect(device, localEnvironment);
    const resumedJob = randomUUID(), resumedTarget = downloadTarget(resumedJob), partial = path.join(resumedTarget, '.tavernsyn-partial/retained');
    await fs.mkdir(path.dirname(partial), { recursive: true }); await fs.writeFile(partial, 'synthetic partial bytes');
    let partialRetained = false, beginCallbacks = 0;
    session.log = line => { downloadLogs.push(line); if (line.includes('下载连接中断')) partialRetained = existsSync(partial); };
    rsyncMode = 'disconnect';
    const resumedPull = await pull(session, device, resumedJob, resumedTarget, undefined, () => { beginCallbacks++; }, {
        onPlan: async () => assert.equal(await fs.readFile(partial, 'utf8'), 'synthetic partial bytes'),
    });
    await verify(resumedTarget, recoveredManifest);
    assert.equal(beginCallbacks, 1); assert.equal(partialRetained, true); assert.equal(await exists(partial), false);
    assert.equal(resumedPull.stats.reconnects, 1); assert.equal(resumedPull.stats.incompleteNetworkStats, true);
    assert.ok(downloadLogs.some(line => line.includes('SSH 已恢复同一下载任务')));
    assert.equal((await readJson(path.join(path.dirname(resumedTarget), 'download.json'))).job, resumedJob);
    assert.equal(session.control.intentional, true, 'finish closes the replacement control, not the original dead one');
    if (!session.control.closed) await once(session.control.child, 'close');
    assert.equal(session.control.closed, true);
    // Reproduce a closed control SSH while real rsync has delivered all files.
    session = await connect(device, localEnvironment);
    const closedSession = session, closedLog = [];
    session.log = line => { closedLog.push(line); if (line === 'rsync 下载结束') closedSession.control.child.kill(); };
    const closedJob = randomUUID(), closedTarget = downloadTarget(closedJob);
    const closedPull = await pull(session, device, closedJob, closedTarget);
    await verify(closedTarget, recoveredManifest);
    assert.equal(closedPull.manifest.digest, recoveredManifest.digest); assert.equal(session.control.closed, true);
    assert.ok(closedLog.some(line => line.includes('继续准备应用')));
    assert.equal((await readJson(path.join(path.dirname(closedTarget), 'manifest.json'))).digest, recoveredManifest.digest);
    assert.equal((await readJson(path.join(path.dirname(closedTarget), 'download.json'))).generation, current.generation);
    session.control.close();
    // Also cover a lost ACK after the server receives finish, and keep real
    // permission errors and corrupt downloads fatal.
    finishMode = 'disconnect';
    session = await connect(device, localEnvironment);
    const lostJob = randomUUID(), lostTarget = downloadTarget(lostJob);
    await pull(session, device, lostJob, lostTarget); await verify(lostTarget, recoveredManifest); session.control.close();
    assert.equal((await readJson(path.join(path.dirname(lostTarget), 'download-resume.json'))).state, 'verified');
    assert.equal((await readJson(path.join(path.dirname(lostTarget), 'download.json'))).generation, current.generation);
    finishMode = 'reject'; session = await connect(device, localEnvironment);
    const rejectedJob = randomUUID();
    await assert.rejects(pull(session, device, rejectedJob, downloadTarget(rejectedJob)), { code: 'PERMISSION' });
    session.control.close(); finishMode = 'normal';
    await fs.writeFile(path.join(serverPayload, 'profile/settings.json'), '{"corrupt":true}');
    session = await connect(device, localEnvironment);
    const finishes = operations.filter(op => op === 'finish').length;
    const corruptJob = randomUUID();
    await assert.rejects(pull(session, device, corruptJob, downloadTarget(corruptJob)), { code: 'INTEGRITY' });
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
    const pathJob = randomUUID(), pathTarget = downloadTarget(pathJob);
    await pull(session, device, pathJob, pathTarget); await verify(pathTarget, pathManifest);
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
    } catch (error) { error.message += '\n' + (downloadLogs.length ? downloadLogs : transferLog).slice(-25).join('\n'); throw error; }
});
