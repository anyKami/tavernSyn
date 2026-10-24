// Actual ST 1.19.0 in a git-archive fixture; transport is an explicitly in-memory VPS adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, digest, readJson, run, exists, removeOwned } from '../lib/io.mjs';
import { install } from '../bin/install.mjs';
import { Manager } from '../helper/manager.mjs';
import { createSyncLog } from '../helper/sync-log.mjs';
import { ST, YAML, MemoryTransport, phase } from './fixtures.mjs';

const parent = path.join(os.tmpdir(), 'tavernsyn-tests'); await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(path.join(parent, 'tavernsyn-e2e-')), fixture = path.join(root, 'SillyTavern'), state = path.join(root, 'state');
await fs.mkdir(fixture);
await run('git', ['-C', ST, 'archive', '--format=tar', '--output', path.join(root, 'source.tar'), '06bde939fb1e9c4c8d8641d810f0a916b5bce127']);
await run('tar', ['-xf', path.join(root, 'source.tar'), '-C', fixture]);
await fs.symlink(path.join(ST, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const port = await new Promise(resolve => { const test = net.createServer(); test.listen(0, '127.0.0.1', () => { const port = test.address().port; test.close(() => resolve(port)); }); });
const config = YAML.parse(await fs.readFile(path.join(fixture, 'default/config.yaml'), 'utf8'));
Object.assign(config, { port, dataRoot: './data', listen: false, enableUserAccounts: true, enableServerPlugins: true, enableServerPluginsAutoUpdate: false, whitelistDockerHosts: false });
config.browserLaunch.enabled = false; config.extensions.autoUpdate = false;
await fs.writeFile(path.join(fixture, 'config.yaml'), YAML.stringify(config));
await fs.mkdir(path.join(fixture, 'data/default-user/worlds'), { recursive: true });
// Default settings come from committed source content, never the real user's profile.
const contentFile = path.join(fixture, 'default/content/settings.json');
const defaults = await exists(contentFile) ? await readJson(contentFile) : { extension_settings: {}, power_user: {}, oai_settings: {}, textgenerationwebui_settings: {} };
Object.assign(defaults, { username: 'TavernSyn fixture' });
defaults.extension_settings ??= {}; defaults.power_user ??= {}; defaults.oai_settings ??= {}; defaults.textgenerationwebui_settings ??= {};
await atomicJson(path.join(fixture, 'data/default-user/settings.json'), defaults);
await atomicJson(path.join(fixture, 'data/default-user/worlds/synthetic.json'), { entries: { 0: { uid: 0, key: ['fixture'], content: 'synthetic world', constant: false, order: 100, position: 0, disable: false } } });
const { repository } = await install({ st: fixture, state });
const { Lifecycle } = await import(pathToFileURL(path.join(repository, 'helper/lifecycle.mjs')).href);
const probe = path.join(fixture, 'plugins/sync-test-probe'); await fs.mkdir(probe);
await fs.writeFile(path.join(probe, 'index.mjs'), `
export const info={id:'sync-test-probe',name:'Fixture',description:'Synthetic tests only'};
export async function init(router){
 console.log('TAVERN_SYN_FIXTURE_STDOUT'); console.error('TAVERN_SYN_FIXTURE_STDERR');
 router.use((req,res,next)=>req.user?.profile?.admin?next():res.sendStatus(403));
 router.get('/slow',async(_req,res)=>{process.send?.({channel:'fixture',event:'started'});await new Promise(r=>setTimeout(r,250));res.json({ok:true});process.send?.({channel:'fixture',event:'finished'});});
 router.post('/ack-known-completed-test',(_req,res)=>{globalThis.tavernsynRuntime.state.uncertain=false;res.json({ok:true});});
 router.post('/hang-exit',(_req,res)=>{globalThis.tavernsynRuntime.state.fixtureHangExit=true;res.json({ok:true});});
}
export async function exit(){if(globalThis.tavernsynRuntime.state.fixtureHangExit)await new Promise(()=>{});}
`);
const fixtureDevice = await readJson(path.join(state, 'device.json'));
// A synthetic native plugin reproduces browser resource loads without copying user plugins/data.
const cocktail = path.join(fixture, 'plugins/cocktail-plus'); await fs.mkdir(cocktail);
await fs.writeFile(path.join(cocktail, 'index.mjs'), `
export const info={id:'cocktail-plus',name:'Synthetic resource fixture',description:'No user data'};
export async function init(router){
 for(const route of ['/early/bridge.js','/sw.js','/module']) router.get(route,(_req,res)=>res.type('application/javascript').send('/* synthetic browser resource */'));
 router.post('/module',(_req,res)=>res.json({unexpected:true}));
}
`);
fixtureDevice.deviceName = 'TavernSyn 隔离测试';
fixtureDevice.remote = { host: '100.100.100.100', user: 'fixture', dataset: randomUUID() };
const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
if (process.platform === 'win32' && await exists(path.join(runtime, 'usr/bin/ssh.exe'))) {
    fixtureDevice.tools = { ssh: path.join(runtime, 'usr/bin/ssh.exe'), rsync: path.join(runtime, 'usr/bin/rsync.exe') };
}
await atomicJson(path.join(state, 'device.json'), fixtureDevice);
const device = await loadDevice(state), remote = new MemoryTransport(path.join(root, 'mock-vps')); await fs.mkdir(remote.root);
let manager;
let liveStdout = '', liveStderr = '';
const liveOutput = { stdout: new Writable({ write(chunk, _encoding, done) { liveStdout += chunk; done(); } }),
    stderr: new Writable({ write(chunk, _encoding, done) { liveStderr += chunk; done(); } }) };
const lifecycle = new Lifecycle(device, (action, payload) => manager.action(action, payload), liveOutput);
const taskLog = createSyncLog(state, liveOutput.stdout);
manager = new Manager(device, lifecycle, remote, taskLog);
const jar = new Map(); let csrf, epoch; const checks = [];
async function request(route, { method = 'GET', body, token = csrf, useEpoch = epoch, cookies = jar } = {}) {
    const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: device.origin };
    if (token) headers['x-csrf-token'] = token;
    if (useEpoch) headers['x-tavernsyn-epoch'] = useEpoch;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const result = await fetch(device.origin + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(10000) });
    for (const cookie of result.headers.getSetCookie()) { const first = cookie.split(';')[0], equal = first.indexOf('='); cookies.set(first.slice(0, equal), first.slice(equal + 1)); }
    return result;
}
// fetch() changes cache behavior when callers supply validators. Use raw HTTP to
// reproduce an existing browser cache revalidating an old Start.bat/launcher page.
async function cachedDocument(route, headers, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(device.origin + route, { method, headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers } }, res => {
            let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
            res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.once('error', reject); req.end();
    });
}
async function verifyCachedDocuments() {
    const modified = (await fs.stat(path.join(fixture, 'public/index.html'))).mtime.toUTCString();
    for (const route of ['/', '/index.html']) {
        for (const headers of [{ 'if-modified-since': modified }, { 'if-none-match': '*' }, { range: 'bytes=0-1023', 'if-range': modified }]) {
            const response = await cachedDocument(route, headers);
            assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store');
            assert.equal(response.headers.etag, undefined); assert.equal(response.headers['last-modified'], undefined);
            assert.ok(response.body.includes(`})(${JSON.stringify(lifecycle.nonce)})`));
        }
        const head = await cachedDocument(route, { 'if-none-match': '*' }, 'HEAD');
        assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['cache-control'], 'no-store');
        assert.equal(head.headers.etag, undefined); assert.equal(head.headers['last-modified'], undefined);
    }
}
async function login() {
    epoch = lifecycle.nonce;
    csrf = (await (await request('/csrf-token', { token: null })).json()).token;
    assert.equal((await request('/api/users/login', { method: 'POST', body: { handle: 'default-user', password: '' } })).status, 200);
}
async function api(action, body) {
    const response = await request('/api/plugins/tavernsyn/' + action, { method: body === undefined ? 'GET' : 'POST', body });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
}
async function receipt() {
    const settings = await readJson(path.join(fixture, 'data/default-user/settings.json')), nonce = randomUUID();
    settings.extension_settings ??= {}; settings.extension_settings.tavernsyn ??= {}; settings.extension_settings.tavernsyn.flushReceipt = nonce;
    const saved = await request('/api/settings/save', { method: 'POST', body: settings }); assert.equal(saved.status, 200); await saved.text();
    const settingsDigest = digest({ extension_settings: settings.extension_settings, power_user: settings.power_user, oai_settings: settings.oai_settings, textgenerationwebui_settings: settings.textgenerationwebui_settings });
    return (await api('flush', { nonce, settingsDigest })).receipt;
}
async function handoff() {
    const job = await phase(manager, 'AWAITING_SAVE', 60000);
    const saved = await receipt(); await api('ready', { id: job.id, tab: job.tab, receipt: saved });
    const waiting = await phase(manager, 'WAITING_PAGE');
    const htmlResponse = await request(`/api/plugins/tavernsyn/wait?${new URLSearchParams({ id: job.id, tab: job.tab, ticket: waiting.ticket })}`);
    const html = await htmlResponse.text(); assert.ok(html.includes('waitingDocument')); assert.ok(!html.includes('src="/script.js"'));
    await api('page', { id: job.id, tab: job.tab, ticket: waiting.ticket });
    await manager.done; assert.equal((await manager.status()).phase, 'SUCCEEDED', JSON.stringify(await manager.status()));
    epoch = lifecycle.nonce; await login();
}
try {
    await lifecycle.start(); await login();
    assert.equal((await request('/api/plugins/tavernsyn/status', { cookies: new Map(), token: null })).status, 403);
    assert.equal((await request('/api/plugins/tavernsyn/check', { method: 'POST', token: null, body: {} })).status, 403);
    checks.push('Native authentication and CSRF reject unauthenticated/missing-token requests');
    const created = await request('/api/users/create', { method: 'POST', body: { handle: 'fixture-reader', name: 'Fixture reader', admin: false } }); assert.equal(created.status, 200); await created.text();
    const reader = new Map(), readerToken = (await (await request('/csrf-token', { cookies: reader })).json()).token;
    const logged = await request('/api/users/login', { method: 'POST', cookies: reader, token: readerToken, body: { handle: 'fixture-reader', password: '' } }); assert.equal(logged.status, 200); await logged.text();
    const denied = await request('/api/plugins/tavernsyn/status', { cookies: reader, token: readerToken }); assert.equal(denied.status, 403); await denied.text();
    checks.push('An authenticated non-admin account cannot access synchronization management');
    for (const [route, body] of [['configuration', undefined], ['configure', {}]]) {
        const response = await request('/api/plugins/tavernsyn/' + route, { method: body === undefined ? 'GET' : 'POST', body, cookies: reader, token: readerToken });
        assert.equal(response.status, 403); await response.text();
    }
    const noCsrf = await request('/api/plugins/tavernsyn/configure', { method: 'POST', token: null, body: {} }); assert.equal(noCsrf.status, 403); await noCsrf.text();
    assert.equal((await api('configuration')).passwordSaved, false);
    const configurationBody = { host: '100.100.100.100', user: 'tavernsyn', dataset: fixtureDevice.remote.dataset, password: 'SYNTHETIC_API_PASSWORD' };
    const configured = await api('configure', configurationBody); assert.equal(configured.configured, true);
    assert.equal(device.remote.host, configurationBody.host); assert.equal((await api('status')).host, configurationBody.host);
    assert.equal((await api('configuration')).passwordSaved, true);
    assert.ok(!JSON.stringify(await api('configuration')).includes(configurationBody.password));
    checks.push('Password configuration enforces admin/CSRF, does not echo the saved password and updates parent/child without restart');
    const response = await request('/'), html = await response.text();
    assert.ok(html.includes('window.__TAVERNSYN__')); assert.ok(html.indexOf('installEpoch') < html.indexOf('<script type="module"'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    checks.push('Real index.html receives an early epoch script without modifying the installed source');
    await verifyCachedDocuments();
    assert.equal((await cachedDocument('/scripts/extensions.js', { 'if-none-match': '*' })).status, 304);
    checks.push('Existing browser cache validators, range requests and HEAD cannot reuse a stale HTML epoch; ordinary static assets keep conditional caching');
    assert.equal((await request('/api/settings/save', { method: 'POST', body: {}, useEpoch: 'old-page' })).status, 409);
    checks.push('Stale-page writes are refused before reaching core settings handlers');
    const resources = ['/api/plugins/cocktail-plus/early/bridge.js', '/api/plugins/cocktail-plus/sw.js',
        ...['/script.js', '/scripts/i18n.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js']
            .map(path => '/api/plugins/cocktail-plus/module?' + new URLSearchParams({ path }))];
    for (const route of resources) {
        const resource = await request(route, { useEpoch: null }); assert.equal(resource.status, 200);
        assert.match(resource.headers.get('content-type'), /javascript/); await resource.text();
    }
    const blockedResource = await request('/api/plugins/cocktail-plus/module?path=%2Fscripts%2Funknown.js', { useEpoch: null });
    assert.equal(blockedResource.status, 409); await blockedResource.text();
    const blockedWrite = await request('/api/plugins/cocktail-plus/module?path=%2Fscript.js', { method: 'POST', body: {}, useEpoch: null });
    assert.equal(blockedWrite.status, 409); await blockedWrite.text();
    checks.push('Browser-loaded Cocktail+ scripts and reviewed modules load without a custom header; other API requests and writes remain epoch-protected');
    const settings = await readJson(path.join(fixture, 'data/default-user/settings.json'));
    const wrong = await request('/api/plugins/tavernsyn/flush', { method: 'POST', body: { nonce: randomUUID(), settingsDigest: '0'.repeat(64) } });
    assert.equal(wrong.status, 409);
    checks.push('Unmatched save nonce/digest cannot obtain a disk receipt');
    const ui = await request('/scripts/extensions/third-party/tavernsyn/ui/index.js'); assert.equal(ui.status, 200); await ui.text();
    const tab = randomUUID(); await api('tabs', { tab });
    const oldEpoch = lifecycle.nonce;
    await receipt(); await api('start', { direction: 'push', tab, preview: false }); await handoff();
    assert.notEqual(lifecycle.nonce, oldEpoch); assert.ok(remote.current);
    await verifyCachedDocuments();
    assert.equal((await api('configuration')).host, configurationBody.host);
    assert.equal((await api('configuration')).passwordSaved, true);
    checks.push('Saved connection settings and password availability survive a real controlled restart');
    checks.push('Protected plugin push: save ACK, waiting document, graceful exit, frozen snapshot, same-port new-nonce restart, publish');
    assert.ok(!remote.last.manifest.files.some(file => /^(server-plugins|extensions)\/tavernsyn\//i.test(file.path)));
    assert.equal((await request('/api/settings/save', { method: 'POST', body: settings, useEpoch: oldEpoch })).status, 409);
    await fs.writeFile(path.join(fixture, 'data/default-user/worlds/local-only.json'), '{"entries":{}}');
    await receipt(); await api('start', { direction: 'pull', tab, preview: false });
    const confirmation = await phase(manager, 'AWAITING_CONFIRMATION', 60000);
    await api('confirm', { id: confirmation.id, token: confirmation.confirmationToken }); await handoff();
    assert.equal(await exists(path.join(fixture, 'data/default-user/worlds/local-only.json')), false);
    assert.equal((await readJson(path.join(state, 'apply.json'))).phase, 'committed');
    assert.ok(await exists(path.join(state, 'recovery')));
    checks.push('Protected plugin pull: verified stage, unpushed-change confirmation, owned stop, journal apply, health check and recovery snapshot');
    const syncText = await fs.readFile(path.join(state, 'sync.log'), 'utf8');
    for (const label of ['上传到 VPS', '从 VPS 下载', '校验文件', '应用更新', '同步完成']) {
        assert.ok(syncText.includes(label), label); assert.ok(liveStdout.includes(label), label);
    }
    assert.ok(!syncText.includes(configurationBody.password));
    checks.push('Push/pull phase, file count, verification, restart and completion logs reach both the live console and sync.log without logging the saved password');
    assert.equal((await api('status')).recovery.available, true);
    await receipt(); await api('start', { direction: 'restore', tab, preview: false }); await handoff();
    assert.equal(await exists(path.join(fixture, 'data/default-user/worlds/local-only.json')), true);
    assert.equal((await api('status')).recovery.available, false); assert.ok((await api('status')).history.restore);
    checks.push('Manual recovery restores pre-pull data through save ACK, owned stop and healthy same-port restart, then consumes the one-step backup');
    assert.equal((await readJson(path.join(repository, '.tavernsyn-install.json'))).state, state);
    assert.ok(await exists(path.join(repository, 'helper/launcher.mjs')));
    assert.ok(liveStdout.split('TAVERN_SYN_FIXTURE_STDOUT').length >= 5);
    assert.ok(liveStderr.split('TAVERN_SYN_FIXTURE_STDERR').length >= 5);
    const savedLog = await fs.readFile(path.join(state, 'server.log'), 'utf8');
    assert.ok(savedLog.includes('TAVERN_SYN_FIXTURE_STDOUT')); assert.ok(savedLog.includes('TAVERN_SYN_FIXTURE_STDERR'));
    checks.push('Full code under plugins/tavernsyn stays local across push, pull and recovery; stdout/stderr stay live through controlled restarts and are also saved to server.log');
    const fixtureEvent = event => new Promise(resolve => { const listener = message => { if (message.channel === 'fixture' && message.event === event) { lifecycle.child.off('message', listener); resolve(); } }; lifecycle.child.on('message', listener); });
    const started = fixtureEvent('started'), finished = fixtureEvent('finished');
    const abandoned = http.get(device.origin + '/api/plugins/sync-test-probe/slow', { headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-tavernsyn-epoch': epoch } }); abandoned.on('error', () => {});
    await started; abandoned.destroy(); await finished;
    await assert.rejects(lifecycle.stop(), { code: 'DRAIN' }); assert.equal(lifecycle.stopped, false);
    await lifecycle.resume();
    const ack = await request('/api/plugins/sync-test-probe/ack-known-completed-test', { method: 'POST', body: {} }); assert.equal(ack.status, 200); await ack.text();
    checks.push('Aborted HTTP handler is marked uncertain and refuses automatic stop; fixture-only acknowledgement follows its proven completion');
    if (process.argv.includes('--browser')) {
        // Synthetic fixture only. Allows a separate browser test to exercise the actual installed UI.
        await atomicJson(path.join(root, 'browser.json'), { origin: device.origin, state, fixture, root });
        console.log(JSON.stringify({ browserFixture: path.join(root, 'browser.json'), origin: device.origin }));
        await new Promise(resolve => {
            const timer = setInterval(async () => { if (await exists(path.join(root, 'stop-browser'))) { clearInterval(timer); resolve(); } }, 1000);
            process.once('SIGINT', () => { clearInterval(timer); resolve(); });
        });
    }
    await lifecycle.stop(); assert.equal(lifecycle.stopped, true);
    const broken = path.join(fixture, 'plugins/broken-test-plugin'); await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, 'index.mjs'), 'throw new Error("synthetic plugin load failure");');
    await assert.rejects(lifecycle.start(), { code: 'PLUGIN_HEALTH' });
    await lifecycle.stop(); await removeOwned(path.join(fixture, 'plugins'), broken);
    await lifecycle.start(); await lifecycle.stop();
    checks.push('Native plugin loading failure rejects startup health; owned child exits before repair and restart');
    await lifecycle.start(); await login();
    const closingStarted = fixtureEvent('started'), closingFinished = fixtureEvent('finished');
    const closingRequest = http.get(device.origin + '/api/plugins/sync-test-probe/slow', { headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-tavernsyn-epoch': epoch } });
    closingRequest.on('error', () => {}); await closingStarted; closingRequest.destroy(); await closingFinished;
    await assert.rejects(lifecycle.stop(), { code: 'DRAIN' });
    const closingAt = Date.now(); await lifecycle.close();
    assert.equal((await lifecycle.exit).code, 0); assert.ok(Date.now() - closingAt < 10000);
    assert.equal(await exists(path.join(state, 'instance.lock')), false);
    await assert.rejects(lifecycle.start(), { code: 'CLOSING' });
    checks.push('Explicit terminal close exits through native cleanup even after an aborted HTTP request; the closing lifecycle cannot restart');
    // Killing only this fixture launcher reproduces abrupt terminal loss and a stale launcher lock.
    let launcher;
    try {
        for (let attempt = 0; attempt < 2; attempt++) {
            launcher = spawn(process.execPath, [path.join(repository, 'helper/launcher.mjs'), '--state', state], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const exited = new Promise(resolve => launcher.once('exit', resolve));
            let output = ''; launcher.stdout.on('data', chunk => { output += chunk; }); launcher.stderr.on('data', chunk => { output += chunk; });
            const deadline = Date.now() + 90000;
            while (!output.includes('TavernSyn 已启动') && launcher.exitCode === null && Date.now() < deadline) await delay(50);
            assert.ok(output.includes('TavernSyn 已启动'), output);
            assert.ok(output.includes('TAVERN_SYN_FIXTURE_STDOUT')); assert.ok(output.includes('TAVERN_SYN_FIXTURE_STDERR'));
            const instance = await readJson(path.join(state, 'instance.lock'));
            await assert.rejects(run(process.execPath, [path.join(repository, 'helper/launcher.mjs'), '--state', state]), { code: 'PROCESS_FAILED' });
            process.kill(instance.pid, 0);
            launcher.kill(); await exited; launcher = null;
            let alive = true; const exitDeadline = Date.now() + 10000;
            while (alive && Date.now() < exitDeadline) {
                try { process.kill(instance.pid, 0); await delay(50); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
            }
            assert.equal(alive, false, 'Fixture server remained alive after its launcher exited');
            await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
        }
    } finally { if (launcher?.exitCode === null) launcher.kill(); }
    await run(process.execPath, [path.join(PROJECT, 'bin/recover.mjs'), '--state', state, '--acknowledge-stopped', 'yes']);
    checks.push('Abrupt launcher loss stops its actual ST child, frees the port and permits a second launch with automatic dead-lock recovery');
    const hanging = new Lifecycle(device, () => {});
    await hanging.start(); epoch = hanging.nonce;
    const hang = await request('/api/plugins/sync-test-probe/hang-exit', { method: 'POST', body: {} }); assert.equal(hang.status, 200); await hang.text();
    const hangAt = Date.now(); await hanging.close();
    assert.equal((await hanging.exit).code, 1); assert.ok(Date.now() - hangAt < 10000);
    assert.equal(await exists(path.join(state, 'instance.lock')), false);
    checks.push('A synthetic hanging plugin cleanup cannot keep the server alive after terminal close; the bounded exit retains recovery data');
    checks.push('All actual fixture children exited; no real user data accessed or changed');
    const result = { status: 'passed', date: new Date().toISOString(), platform: process.platform, node: process.version, root, port, checks,
        transport: 'MemoryTransport simulation; NOT real rsync/SSH/VPS', untested: ['Android Termux', 'Linux SSH dispatcher under real rsync load', 'Browser interaction unless separately recorded', 'Third-party plugin coexistence'] };
    await atomicJson(path.join(root, 'results.json'), result);
    await atomicJson(path.join(PROJECT, 'docs/test-results/implementation-windows.json'), { ...result, root: '<isolated-test-directory>',
        publicationPrivacy: 'Temporary test path anonymized; raw results stay with the isolated fixture.' });
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error.stack);
    await atomicJson(path.join(root, 'failure.json'), { error: error.message, checks, root });
    if (!lifecycle.stopped) { try { await lifecycle.resume(); await lifecycle.stop(); } catch (cleanup) { console.error(`Fixture PID ${lifecycle.child?.pid}: ${cleanup.message}`); } }
    process.exitCode = 1;
} finally { taskLog.close(); }
