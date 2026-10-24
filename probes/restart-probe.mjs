// Creates a git-archive fixture. Never runs or changes the user's installed server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const directory = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(directory);
const source = path.resolve(process.argv[2] ?? path.join(project, '../tavern/SillyTavern'));
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(revision, '06bde939fb1e9c4c8d8641d810f0a916b5bce127', 'Probe is pinned to the researched release');
const YAML = createRequire(path.join(source, 'package.json'))('yaml');
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const work = fs.mkdtempSync(path.join(project, '.tmp/restart-probe-'));
const fixture = path.join(work, 'SillyTavern');
fs.mkdirSync(fixture);
execFileSync('git', ['-C', source, 'archive', '--format=tar', '--output', path.join(work, 'source.tar'), 'HEAD']);
execFileSync('tar', ['-xf', path.join(work, 'source.tar'), '-C', fixture]);
fs.symlinkSync(path.join(source, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
});
const config = YAML.parse(fs.readFileSync(path.join(fixture, 'default/config.yaml'), 'utf8'));
Object.assign(config, { port, dataRoot: './data', listen: false, enableUserAccounts: true,
    enableServerPlugins: true, enableServerPluginsAutoUpdate: false, whitelistDockerHosts: false });
config.browserLaunch.enabled = false;
config.extensions.autoUpdate = false;
fs.writeFileSync(path.join(fixture, 'config.yaml'), YAML.stringify(config));
fs.mkdirSync(path.join(fixture, 'plugins/sync-probe'), { recursive: true });
fs.copyFileSync(path.join(directory, 'fixture-plugin.mjs'), path.join(fixture, 'plugins/sync-probe/index.mjs'));
fs.mkdirSync(path.join(fixture, 'data'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'data/probe-user.json'), '{"revision":1}');
const checks = [];
let child;
let nonce;
let exitPromise;
let sequence = 0;
let listeners = new Set();
const cookies = new Map();
let csrf;
function waitMessage(predicate, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const listener = message => { if (predicate(message)) { clearTimeout(timer); listeners.delete(listener); resolve(message); } };
        const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('IPC response timeout')); }, timeout);
        listeners.add(listener);
    });
}
async function command(operation, fields = {}, overrideNonce = nonce) {
    const id = ++sequence;
    const result = waitMessage(message => message.reply === id, 10000);
    child.send({ id, nonce: overrideNonce, operation, ...fields });
    return result;
}
async function start() {
    nonce = randomUUID(); listeners = new Set(); cookies.clear();
    const ready = waitMessage(message => message.event === 'ready');
    const output = fs.openSync(path.join(work, `server-${sequence}.log`), 'a');
    child = fork(path.join(directory, 'managed-bootstrap.mjs'), [], {
        cwd: fixture, windowsHide: true, stdio: ['ignore', output, output, 'ipc'],
        env: { ...process.env, NODE_ENV: 'production', SYNC_PROBE_NONCE: nonce },
    });
    fs.closeSync(output);
    child.on('message', message => { for (const listener of [...listeners]) listener(message); });
    exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    await Promise.race([ready, exitPromise.then(exit => { throw new Error(`Fixture exited before ready: ${JSON.stringify(exit)}`); })]);
}
async function request(route, { method = 'GET', body, token = csrf, jar = cookies } = {}) {
    const headers = { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') };
    if (token) headers['x-csrf-token'] = token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(';')[0]; const equal = first.indexOf('='); jar.set(first.slice(0, equal), first.slice(equal + 1));
    }
    return response;
}
async function login() {
    csrf = (await (await request('/csrf-token', { token: null })).json()).token;
    assert.equal((await request('/api/users/login', { method: 'POST', body: { handle: 'default-user', password: '' } })).status, 200);
}
async function stop() {
    await command('ownership', { managed: true });
    const drained = await command('pause', { timeout: 1000 });
    assert.equal(drained.result, 'drained');
    assert.equal((await command('shutdown')).result, 'stopping');
    const exited = await Promise.race([exitPromise, delay(5000).then(() => { throw new Error('Graceful exit timeout; no force kill attempted'); })]);
    assert.equal(exited.code, 0);
    assert.equal(fs.readFileSync(path.join(fixture, 'data/probe-exit.txt'), 'utf8'), 'exit hook completed');
    child = null;
}
try {
    await start();
    assert.equal((await request('/api/plugins/sync-probe/health', { jar: new Map(), token: null })).status, 403);
    checks.push('Actual plugin router rejects unauthenticated request: 403');
    await login();
    assert.equal((await request('/api/plugins/sync-probe/echo', { method: 'POST', body: {}, token: null })).status, 403);
    assert.equal((await request('/api/plugins/sync-probe/echo', { method: 'POST', body: {} })).status, 200);
    checks.push('Actual plugin POST inherits CSRF: missing token 403; valid session/token 200');
    assert.equal((await request('/api/users/create', { method: 'POST', body: { handle: 'probe-reader', name: 'Probe Reader', admin: false } })).status, 200);
    const readerJar = new Map();
    const readerCsrf = (await (await request('/csrf-token', { jar: readerJar, token: null })).json()).token;
    assert.equal((await request('/api/users/login', { method: 'POST', jar: readerJar, token: readerCsrf, body: { handle: 'probe-reader' } })).status, 200);
    assert.equal((await request('/api/plugins/sync-probe/health', { jar: readerJar, token: readerCsrf })).status, 403);
    checks.push('Plugin-specific admin check rejects authenticated non-admin: 403');
    assert.equal((await command('pause', { timeout: 100 }, 'wrong-instance')).result, 'denied');
    checks.push('Wrong IPC instance nonce rejected');
    await command('ownership', { managed: false });
    assert.equal((await request('/api/plugins/sync-probe/request-restart', { method: 'POST', body: {} })).status, 409);
    checks.push('Simulated unmanaged identity refuses restart: 409 (no PID or port killing)');
    await command('ownership', { managed: true });
    let slowStarted = waitMessage(message => message.event === 'slow-started');
    let slow = request('/api/plugins/sync-probe/slow?ms=500'); await slowStarted;
    const pendingDrain = command('pause', { timeout: 1000 }); await delay(40);
    assert.equal((await request('/api/plugins/sync-probe/health')).status, 503);
    assert.equal((await slow).status, 200);
    assert.equal((await pendingDrain).result, 'drained');
    checks.push('Maintenance gate rejects new request 503 and lets existing request finish 200 before drain ACK');
    await command('resume');
    slowStarted = waitMessage(message => message.event === 'slow-started');
    slow = request('/api/plugins/sync-probe/slow?ms=500'); await slowStarted;
    assert.equal((await command('pause', { timeout: 30 })).result, 'drain-timeout');
    assert.equal((await command('shutdown')).result, 'refused');
    assert.equal((await request('/api/plugins/sync-probe/health')).status, 503);
    await slow; await command('resume');
    checks.push('Drain timeout remains in maintenance; shutdown refused; same child stays alive until explicit resume');
    const before = await (await request('/api/plugins/sync-probe/health')).json();
    await stop();
    checks.push('Child invokes ST SIGTERM listener; async server plugin exit hook completes; parent observes exit 0');
    fs.writeFileSync(path.join(fixture, 'data/probe-user.json'), '{"revision":2}');
    await start(); await login();
    const after = await (await request('/api/plugins/sync-probe/health')).json();
    assert.notEqual(after.nonce, before.nonce); assert.equal(after.nonce, nonce);
    assert.equal(JSON.parse(after.data).revision, 2);
    checks.push('Same fixture/config/port restarted; health verifies new boot nonce and applied synthetic revision 2');
    await stop();
    checks.push('All fixture children exited gracefully; no real user data read or modified');
    const result = { status: 'passed', sourceRevision: revision, platform: process.platform, node: process.version,
        port, fixture, checks, untested: ['Browser button flow', 'Android Termux', 'rsync/SSH/VPS', 'Crash rollback', 'Uncooperative third-party plugins'] };
    fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error.stack);
    if (child) {
        try { await command('resume'); await stop(); } catch (cleanupError) {
            console.error(`Fixture cleanup needs attention: PID ${child?.pid}. ${cleanupError.message}`);
        }
    }
    fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify({ status: 'failed', error: error.message, checks, fixture }, null, 2));
    process.exitCode = 1;
}
