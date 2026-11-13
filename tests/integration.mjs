// Actual ST 1.19.0 in a git-archive fixture; transport is an explicitly in-memory VPS adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { PROJECT, loadDevice } from '../lib/device.mjs';
import { atomicJson, digest, readJson, run, exists, removeOwned } from '../lib/io.mjs';
import { install } from '../bin/install.mjs';
import { recoverDownload } from '../bin/recover-download.mjs';
import { recoverStopped } from '../bin/recover.mjs';
import { Manager } from '../helper/manager.mjs';
import { connectionId } from '../lib/completion.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { verify } from '../lib/manifest.mjs';
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
 for(const route of ['/module.js','/child.js','/worker.js']) router.get(route,(req,res)=>Object.hasOwn(req.query,'__tavernsyn_epoch')?res.sendStatus(400):res.type('application/javascript').send('/* synthetic native resource */'));
 router.post('/pending',(_req,res)=>{res.type('text/plain');res.write('waiting');});
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
async function request(route, { method = 'GET', body, token = csrf, useEpoch = epoch, cookies = jar, extraHeaders = {} } = {}) {
    const headers = { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), Origin: device.origin, ...extraHeaders };
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
async function unmanagedRecovery() {
    const helper = path.join(repository, 'helper/transport.mjs');
    await fs.rename(helper, path.join(repository, 'helper/transport-original.mjs'));
    // Use the installed worker and CLI with a local control double. Every byte
    // of the done-stage payload is still checked by production pull().
    await fs.writeFile(helper, `
        import fs from 'node:fs/promises';
        import path from 'node:path';
        export * from './transport-original.mjs';
        export async function connect(device) {
            return {
                hello: { current: { digest: 'b'.repeat(64) }, dataset: device.remote.dataset, capabilities: ['scoped-sync-v1', 'job-bound-rsync'] },
                env: { jobBound: true, get rsync() { throw Error('Verified done jobs must not transfer'); } },
                control: { close() {}, async request(op, fields) {
                    await fs.appendFile(path.join(device.state, 'fixture-control.jsonl'), JSON.stringify({ op, ...fields }) + '\\n');
                    if (op === 'abort') return {};
                    if (fields.direction === 'push' && op === 'begin') {
                        const receipt = JSON.parse(await fs.readFile(path.join(device.state, 'jobs', fields.job, 'publication-fixture.json')));
                        if (JSON.stringify(fields.scope ?? null) !== JSON.stringify(receipt.scope)) throw Error('Incorrect upload scope');
                        return { job: fields.job, direction: 'push', generation: fields.job, phase: 'finalizing', base: fields.base, scope: receipt.scope };
                    }
                    if (op === 'commit') return JSON.parse(await fs.readFile(path.join(device.state, 'jobs', fields.job, 'publication-fixture.json')));
                    if (op !== 'begin' || !fields.resumeOnly) throw Error('Only retained tasks are accepted');
                    const record = JSON.parse(await fs.readFile(path.join(device.state, 'jobs', fields.job, 'download-resume.json')));
                    if (JSON.stringify(fields.scope) !== JSON.stringify(record.scope)) throw Error('Incorrect scope');
                    return { ...record, phase: 'done' };
                } },
            };
        }
    `);
    const statusFile = path.join(state, 'status.json'), trace = path.join(state, 'fixture-control.jsonl');
    const scope = ['worlds'];
    const seed = async () => {
        const job = randomUUID(), generation = randomUUID(), connection = connectionId(device);
        const jobRoot = path.join(state, 'jobs', job), payload = path.join(jobRoot, 'payload');
        const { manifest } = await snapshot(device, payload, { scope });
        const environment = await fs.readFile(path.join(payload, 'environment.json'), 'utf8');
        const binding = { format: 1, job, generation, connection, direction: 'pull', dataset: device.remote.dataset,
            scope, base: 'a'.repeat(64), publicationDigest: 'a'.repeat(64), environment, manifest, state: 'verified' };
        const status = { id: job, phase: 'FAILED', failurePhase: 'DOWNLOADING', direction: 'pull', scope, connection,
            preview: false, remoteJob: job, error: { code: 'SSH' } };
        await atomicJson(statusFile, status);
        await atomicJson(path.join(jobRoot, 'download-resume.json'), binding);
        return { status, binding, jobRoot };
    };
    const fixtureJob = await seed();
    const child = spawn(process.execPath, ['server.js'], {
        cwd: fixture, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, TAVERNSYN_STATE: state, NODE_ENV: 'production' },
    });
    const closed = once(child, 'close');
    const until = async callback => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const value = await callback().catch(() => undefined);
            if (value) return value;
            assert.equal(child.exitCode, null, 'unmanaged fixture exited');
            await delay(100);
        }
        assert.fail('unmanaged fixture did not reach the expected state');
    };
    try {
        epoch = undefined;
        jar.clear();
        const response = await until(async () => {
            const probe = await request('/csrf-token', { token: null });
            return probe.ok && probe;
        });
        csrf = (await response.json()).token;
        assert.equal((await request('/api/users/login', { method: 'POST', body: { handle: 'default-user', password: '' } })).status, 200);
        const failed = await api('status');
        assert.equal(failed.managed, false);
        assert.equal(failed.canResumeDownload, true);
        epoch = failed.epoch;
        assert.equal((await api('resume-download', { id: fixtureJob.status.id, tab: randomUUID() })).id, fixtureJob.status.id);
        const pending = await until(async () => {
            const current = await api('status');
            return current.phase === 'PENDING_APPLY' && !await exists(path.join(state, 'operation.lock')) && current;
        });
        assert.equal(pending.id, fixtureJob.status.id);
        assert.equal(pending.remote.generation, fixtureJob.binding.generation);
        assert.equal(await exists(path.join(fixtureJob.jobRoot, 'candidate')), false);
        assert.equal(await exists(path.join(state, 'operation.lock')), false);
    } finally {
        if (child.exitCode === null) child.kill();
        await closed;
        await recoverStopped(device);
    }
    checks.push('Native unmanaged ST resumes the authenticated original download in a real worker and stages it for controlled application');
    const cli = (job, action, onOutput) => run(process.execPath,
        [path.join(repository, 'bin/remote-job.mjs'), '--state', state, '--job', job, '--action', action], { onOutput });
    const cliResume = await seed();
    await cli(cliResume.status.id, 'resume');
    const pending = await readJson(statusFile);
    assert.equal(pending.phase, 'PENDING_APPLY');
    assert.deepEqual(pending.scope, scope);
    assert.equal(pending.remote.digest, cliResume.binding.publicationDigest);
    assert.equal(pending.remote.snapshotDigest, cliResume.binding.manifest.digest);
    const cliAbort = await seed();
    await cli(cliAbort.status.id, 'abort');
    assert.equal((await readJson(statusFile)).remoteJob, null);
    const unbound = await seed();
    await fs.unlink(path.join(unbound.jobRoot, 'download-resume.json'));
    let diagnostic = '';
    await assert.rejects(cli(unbound.status.id, 'resume', output => { diagnostic += output; }), { code: 'PROCESS_FAILED', exitCode: 1 });
    assert.match(diagnostic, /重新拉取/);
    const requests = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(requests.map(({ op, job, resumeOnly, scope }) => ({ op, job, resumeOnly, scope })), [
        ...[fixtureJob, cliResume, cliAbort].map(item => ({ op: 'begin', job: item.status.id, resumeOnly: true, scope })),
        { op: 'abort', job: cliAbort.status.id, resumeOnly: undefined, scope: undefined },
    ]);
    checks.push('Scoped CLI resume and abort claim the original task and reject old incomplete downloads before sending a begin request');
    const baseline = path.join(state, 'baseline.json'), cache = path.join(state, 'cache/payload');
    const baselineBytes = await fs.readFile(baseline);
    await fs.mkdir(cache, { recursive: true });
    const previousCache = path.join(cache, 'fixture-cache-marker');
    await fs.writeFile(previousCache, 'previous full cache');
    for (const uploadScope of [scope, null]) {
        const id = randomUUID(), jobRoot = path.join(state, 'jobs', id), payload = path.join(jobRoot, 'payload');
        const { manifest } = await snapshot(device, payload, { scope: uploadScope });
        await atomicJson(path.join(jobRoot, 'manifest.json'), manifest);
        const receipt = { generation: id, scope: uploadScope, digest: uploadScope ? 'd'.repeat(64) : manifest.digest,
            ...(uploadScope ? { snapshotDigest: manifest.digest, maintenance: ['category-staging'] } : {}) };
        await atomicJson(path.join(jobRoot, 'publication-fixture.json'), receipt);
        await atomicJson(statusFile, { id, direction: 'push', phase: 'FAILED', connection: connectionId(device),
            remoteBase: { digest: 'b'.repeat(64) }, ...(uploadScope ? { scope: uploadScope } : {}) });
        await cli(id, 'resume');
        const published = await readJson(statusFile);
        const outcome = await readJson(path.join(jobRoot, 'outcome.json'));
        assert.equal(published.phase, 'SUCCEEDED');
        assert.equal(published.maintenancePending, false, JSON.stringify(published));
        assert.equal(published.remote.digest, receipt.digest);
        assert.equal(outcome.cache, !uploadScope);
        if (uploadScope) {
            assert.equal(published.remote.snapshotDigest, manifest.digest);
            assert.deepEqual(published.remote.maintenance, ['category-staging']);
            assert.deepEqual(published.maintenance, { pending: [], remote: ['category-staging'] });
            assert.deepEqual(await fs.readFile(baseline), baselineBytes);
            assert.equal(await fs.readFile(previousCache, 'utf8'), 'previous full cache');
        } else {
            assert.equal(await exists(previousCache), false);
            await verify(cache, manifest);
            assert.equal((await readJson(baseline)).remote.digest, manifest.digest);
        }
    }
    checks.push('CLI scoped upload finishes without local maintenance and preserves the full cache and baseline, while a full upload replaces both');
}
try {
    await lifecycle.start(); await login();
    assert.equal((await request('/api/plugins/tavernsyn/status', { cookies: new Map(), token: null })).status, 403);
    const browserHelper = path.join(repository, 'helper/browser.mjs'), originalBrowser = await fs.readFile(browserHelper);
    const browserMarker = path.join(root, 'reused-browser.txt');
    try {
        await fs.writeFile(browserHelper, `import fs from 'node:fs/promises';export async function openBrowser(origin){await fs.writeFile(${JSON.stringify(browserMarker)},origin);}`);
        const reused = await run(process.execPath, ['--input-type=module', '-'], { input:
            `import {reuseRunning} from ${JSON.stringify(pathToFileURL(path.join(PROJECT, 'bin/startup.mjs')).href)};if(!await reuseRunning(${JSON.stringify(fixture)},${JSON.stringify(state)}))process.exit(1);` });
        assert.ok(reused.stdout.includes('受控酒馆已在运行')); assert.equal(await fs.readFile(browserMarker, 'utf8'), device.origin);
    } finally { await fs.writeFile(browserHelper, originalBrowser); }
    checks.push('A second real startup probe reuses the authenticated ST instance through an unauthenticated HEAD epoch header and opens the existing origin');
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
    const resourceUrl = '/api/plugins/sync-test-probe/module.js?__tavernsyn_epoch=' + lifecycle.nonce;
    const nativeHeaders = { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' };
    const native = await request(resourceUrl, { useEpoch: null, extraHeaders: nativeHeaders }); assert.equal(native.status, 200); await native.text();
    const worker = await request('/api/plugins/sync-test-probe/worker.js?__tavernsyn_epoch=' + lifecycle.nonce,
        { useEpoch: null, extraHeaders: { ...nativeHeaders, 'sec-fetch-dest': 'worker' } });
    assert.equal(worker.status, 200); await worker.text();
    const child = await request('/api/plugins/sync-test-probe/child.js', { useEpoch: null, extraHeaders: { ...nativeHeaders, referer: device.origin + resourceUrl } });
    assert.equal(child.status, 307);
    assert.equal((await request(child.headers.get('location'), { useEpoch: null, extraHeaders: nativeHeaders })).status, 200);
    const staleResource = await request('/api/plugins/sync-test-probe/module.js?__tavernsyn_epoch=old', { useEpoch: null, extraHeaders: nativeHeaders });
    assert.equal(staleResource.status, 409); await staleResource.text();
    const anonymousResource = await request(resourceUrl, { useEpoch: null, cookies: new Map(), token: null, extraHeaders: nativeHeaders });
    assert.equal(anonymousResource.status, 403); await anonymousResource.text();
    checks.push('A third-party native script, Worker and nested module URL work without fetch headers; stale epochs and unauthenticated access remain refused');
    const settings = await readJson(path.join(fixture, 'data/default-user/settings.json'));
    const wrong = await request('/api/plugins/tavernsyn/flush', { method: 'POST', body: { nonce: randomUUID(), settingsDigest: '0'.repeat(64) } });
    assert.equal(wrong.status, 409);
    checks.push('Unmatched save nonce/digest cannot obtain a disk receipt');
    const ui = await request('/scripts/extensions/third-party/tavernsyn/ui/index.js'); assert.equal(ui.status, 200); await ui.text();
    // A tab navigation can cancel an in-flight sendFile. Reproduce the real socket
    // close before a large static response finishes, then use the normal push path.
    const staticFile = path.join(fixture, 'public/img/tavernsyn-abort-fixture.bin');
    await fs.writeFile(staticFile, Buffer.alloc(32 * 1024 * 1024, 7));
    await new Promise((resolve, reject) => {
        const req = http.get(device.origin + '/img/tavernsyn-abort-fixture.bin?private-query-must-not-appear', {
            headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        }, res => {
            assert.equal(res.statusCode, 200);
            res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
            res.once('error', () => {});
        });
        req.once('error', reject);
    });
    let drain;
    for (let i = 0; i < 50; i++) {
        drain = (await api('status')).drain;
        if (drain.safeAborts) break;
        await delay(20);
    }
    assert.ok(drain.safeAborts >= 1); assert.equal(drain.uncertain, false);
    await fs.unlink(staticFile);
    const tab = randomUUID(); await api('tabs', { tab });
    const oldEpoch = lifecycle.nonce;
    await receipt(); await api('start', { direction: 'push', tab, preview: false }); await handoff();
    assert.notEqual(lifecycle.nonce, oldEpoch); assert.ok(remote.current);
    await verifyCachedDocuments();
    assert.equal((await api('configuration')).host, configurationBody.host);
    assert.equal((await api('configuration')).passwordSaved, true);
    checks.push('Saved connection settings and password availability survive a real controlled restart');
    checks.push('Protected plugin push: save ACK, waiting document, graceful exit, frozen snapshot, same-port new-nonce restart, publish');
    checks.push('A canceled real static sendFile does not poison drain; the following normal push safely stops, publishes and restarts');
    assert.ok(!remote.last.manifest.files.some(file => /^(server-plugins|extensions)\/tavernsyn\//i.test(file.path)));
    assert.equal((await request('/api/settings/save', { method: 'POST', body: settings, useEpoch: oldEpoch })).status, 409);
    const unchangedEpoch = lifecycle.nonce, unchangedGeneration = remote.current.generation;
    await api('start', { direction: 'push', tab, preview: false }); await handoff();
    assert.equal((await api('status')).noChanges, true); assert.equal(lifecycle.nonce, unchangedEpoch);
    await api('start', { direction: 'pull', tab, preview: false }); await manager.done;
    assert.equal((await api('status')).noChanges, true);
    assert.equal(lifecycle.nonce, unchangedEpoch); assert.equal(remote.current.generation, unchangedGeneration);
    checks.push('Unchanged push uses real save/page handoff without restarting ST; unchanged pull skips download and preparation and retains the same publication');
    const maintenanceFile = path.join(fixture, 'data/default-user/worlds/maintenance-fixture.json');
    await fs.writeFile(maintenanceFile, '{"entries":{}}');
    const cachePayload = manager.cache.bind(manager);
    const sendCommitted = remote.push.bind(remote), historyFile = path.join(state, 'history.json'), historyBefore = path.join(root, 'history-before-fixture.json');
    remote.push = async (...args) => {
        const result = await sendCommitted(...args);
        await fs.rename(historyFile, historyBefore); await fs.mkdir(historyFile); return result;
    };
    manager.cache = async () => { throw Object.assign(Error('Synthetic post-publish cache ENOSPC'), { code: 'ENOSPC' }); };
    try { await api('start', { direction: 'push', tab, preview: false }); await handoff(); }
    finally { manager.cache = cachePayload; remote.push = sendCommitted; }
    const committed = await api('status'), committedEpoch = lifecycle.nonce;
    assert.equal(committed.commit.kind, 'published'); assert.equal(committed.maintenancePending, true);
    assert.equal(committed.historyUnavailable, true);
    await fs.rmdir(historyFile); await fs.rename(historyBefore, historyFile);
    const finalized = await api('reconcile', { id: committed.id });
    assert.equal(finalized.phase, 'SUCCEEDED'); assert.equal(finalized.maintenancePending, false);
    assert.equal(lifecycle.nonce, committedEpoch); assert.equal(remote.current.generation, committed.id);
    await fs.unlink(maintenanceFile);
    checks.push('A real saved push remains successful after cache ENOSPC and unreadable history; its status API stays accessible and authenticated reconciliation repairs records without another restart or publication');
    await fs.writeFile(path.join(fixture, 'data/default-user/worlds/local-only.json'), '{"entries":{}}');
    const normalPull = remote.pull.bind(remote), prePullEpoch = lifecycle.nonce;
    const unavailableResume = await request('/api/plugins/tavernsyn/resume-download', {
        method: 'POST', body: { id: randomUUID(), tab },
    });
    assert.equal(unavailableResume.status, 409);
    assert.equal((await unavailableResume.json()).error, 'DOWNLOAD_BINDING');
    const injectedResume = await request('/api/plugins/tavernsyn/start', {
        method: 'POST', body: { direction: 'pull', tab, resume: { id: randomUUID() } },
    });
    assert.equal(injectedResume.status, 400);
    assert.equal((await injectedResume.json()).error, 'INPUT');
    checks.push('Authenticated ST routes download resume to the Manager and rejects internal state in a start request');
    remote.pull = async (...args) => {
        await normalPull(...args);
        throw Object.assign(new Error('synthetic legacy control disconnect after verified download'), { code: 'SSH' });
    };
    await receipt(); await api('start', { direction: 'pull', tab, preview: false });
    await manager.done;
    assert.equal((await manager.status()).phase, 'FAILED');
    assert.equal(lifecycle.nonce, prePullEpoch, 'legacy finish failure must leave the live ST unchanged');
    await recoverDownload(device);
    const normalConnect = remote.connect;
    remote.connect = () => { throw Error('recovery must reuse local download'); };
    await api('resume-pending', { tab });
    const saving = await phase(manager, 'AWAITING_SAVE', 60000);
    await api('tabs', { tab });
    const conflictingTab = await request('/api/plugins/tavernsyn/ready', { method: 'POST',
        body: { id: saving.id, receipt: await receipt(), tab: randomUUID() } });
    assert.equal(conflictingTab.status, 409); assert.equal((await conflictingTab.json()).error, 'OTHER_TABS');
    assert.equal((await manager.status()).phase, 'AWAITING_SAVE');
    await handoff();
    remote.connect = normalConnect; remote.pull = normalPull;
    assert.notEqual(lifecycle.nonce, prePullEpoch);
    checks.push('Legacy SSH failure after complete download: offline SHA-256 recovery, original-generation automatic continuation, real ST same-port restart and successful application without reconnecting');
    checks.push('Automatic save binds the handoff to its current page and refuses another still-active TavernSyn tab');
    assert.equal(await exists(path.join(fixture, 'data/default-user/worlds/local-only.json')), false);
    assert.equal((await readJson(path.join(state, 'last-apply.json'))).phase, 'committed');
    assert.equal(await exists(path.join(state, 'recovery')), false);
    assert.equal(await exists(path.join(state, 'jobs', manager.job.id, 'candidate')), false);
    assert.ok(await exists(path.join(state, 'jobs', manager.job.id, 'outcome.json')));
    checks.push('Protected plugin pull: verified stage, automatic overwrite, owned stop, journal apply, healthy restart and automatic recovery cleanup after durable completion');
    const syncText = await fs.readFile(path.join(state, 'sync.log'), 'utf8');
    for (const label of ['上传到 VPS', '从 VPS 下载', '校验文件', '应用更新', '同步完成']) {
        assert.ok(syncText.includes(label), label); assert.ok(liveStdout.includes(label), label);
    }
    assert.ok(!syncText.includes(configurationBody.password));
    checks.push('Push/pull phase, file count, verification, restart and completion logs reach both the live console and sync.log without logging the saved password');
    assert.equal((await api('status')).recovery.available, false);
    assert.equal(await exists(path.join(fixture, 'data/default-user/worlds/local-only.json')), false);
    checks.push('Healthy completed pulls retain the current data and small receipt without an obsolete manual recovery option');
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
    await assert.rejects(lifecycle.stop(), error => error.code === 'DRAIN' && error.message.includes('GET /api/plugins/*'));
    assert.equal(lifecycle.stopped, false);
    await lifecycle.resume();
    const uncertainDrain = (await api('status')).drain;
    assert.equal(uncertainDrain.uncertain, true);
    assert.ok(!JSON.stringify(uncertainDrain).includes('sync-test-probe/slow'));
    checks.push('An uncertain handler still rejects a strict stop without clearing its diagnostics');
    // Reproduce both an active POST and a historical aborted request. Only the
    // normal save + page handoff may opt into interrupting this old instance.
    // Model a device without a baseline; the initial user consent covers overwrite.
    await fs.unlink(path.join(state, 'baseline.json'));
    let pendingRequest;
    const pendingResponse = new Promise((resolve, reject) => {
        pendingRequest = http.request(device.origin + '/api/plugins/sync-test-probe/pending', { method: 'POST', headers: {
            Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), 'x-tavernsyn-epoch': epoch,
            'x-csrf-token': csrf, 'content-type': 'application/json', 'content-length': '2',
        } }, res => { res.once('data', () => resolve(res)); res.on('error', () => {}); });
        pendingRequest.on('error', reject); pendingRequest.end('{}');
    });
    await pendingResponse;
    const disconnected = new Promise(resolve => pendingRequest.once('close', resolve));
    const oldChild = lifecycle.child, oldExit = lifecycle.exit;
    try {
        await api('start', { direction: 'push', tab, preview: false });
        await handoff();
        await Promise.race([disconnected, delay(5000).then(() => { throw new Error('Blocked POST was not disconnected'); })]);
        assert.equal((await oldExit).code, 0); assert.notEqual(lifecycle.child.pid, oldChild.pid);
        assert.equal((await api('status')).drain.uncertain, false);
        assert.ok((await fs.readFile(path.join(state, 'sync.log'), 'utf8')).includes('正在中断旧实例连接并正常关闭酒馆'));
    } finally { pendingRequest.destroy(); }
    checks.push('A real hanging POST plus uncertain request is disconnected after saved handoff, native exit is confirmed, and the same push publishes and restarts successfully');
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
    await unmanagedRecovery();
    checks.push('All actual fixture children exited; no real user data accessed or changed');
    const result = { status: 'passed', date: new Date().toISOString(), platform: process.platform, node: process.version, root, port, checks,
        transport: 'MemoryTransport simulation; NOT real rsync/SSH/VPS', untested: ['Android Termux', 'Linux SSH dispatcher under real rsync load', 'Browser interaction unless separately recorded', 'Third-party plugin coexistence'] };
    await atomicJson(path.join(root, 'results.json'), result);
    await atomicJson(process.env.TAVERNSYN_TEST_REPORT ?? path.join(PROJECT, 'docs/test-results/implementation-windows.json'), { ...result, root: '<isolated-test-directory>',
        publicationPrivacy: 'Temporary test path anonymized; raw results stay with the isolated fixture.' });
    console.log(JSON.stringify(result, null, 2));
} catch (error) {
    console.error(error.stack);
    await atomicJson(path.join(root, 'failure.json'), { error: error.message, checks, root });
    if (!lifecycle.stopped) { try { await lifecycle.resume(); await lifecycle.stop(); } catch (cleanup) { console.error(`Fixture PID ${lifecycle.child?.pid}: ${cleanup.message}`); } }
    process.exitCode = 1;
} finally { taskLog.close(); }
