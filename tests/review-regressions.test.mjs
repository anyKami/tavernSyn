import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, temporary, MemoryTransport, FakeLifecycle, phase, handoff } from './fixtures.mjs';
import { atomicJson, canonical, digest, exists, readJson, run } from '../lib/io.mjs';
import { copyTree, hashFile, scan } from '../lib/manifest.mjs';
import { snapshot, portableState } from '../lib/snapshot.mjs';
import { prepare, buildPlan, applyPlan, rollback } from '../helper/apply.mjs';
import { Manager } from '../helper/manager.mjs';
import { ATTRIBUTES, validateExecutables } from '../lib/file-attributes.mjs';
import { chatReceipt } from '../lib/chat-receipt.mjs';

for (const step of ['write', 'sync', 'rename']) test(`atomic JSON ${step} failure preserves the old document and removes its own temp`, async () => {
    const root = await temporary('atomic'), file = path.join(root, 'status.json'); await atomicJson(file, { old: true });
    const error = Object.assign(Error('synthetic I/O failure'), { code: step === 'write' ? 'ENOSPC' : 'EPERM' });
    const io = { ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        return args[1] !== 'wx' ? handle : {
            writeFile: (...data) => step === 'write' ? Promise.reject(error) : handle.writeFile(...data),
            sync: () => step === 'sync' ? Promise.reject(error) : handle.sync(), close: () => handle.close(),
        };
    } };
    await assert.rejects(atomicJson(file, { next: true }, { io, ...(step === 'rename' ? { rename: async () => { throw error; } } : {}) }), error);
    assert.deepEqual(await readJson(file), { old: true }); assert.deepEqual(await fs.readdir(root), ['status.json']);
});

test('unmanaged download does not build candidates or run npm, controlled continuation prepares once', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps')); await fs.mkdir(remote.root);
    const plugin = path.join(device.install, 'plugins/demo'); await fs.mkdir(plugin);
    await atomicJson(path.join(plugin, 'package.json'), { name: 'fixture', dependencies: { synthetic: '1.0.0' } });
    const initial = new Manager(device, new FakeLifecycle(), remote);
    await initial.start({ direction: 'push', tab: randomUUID() }); await handoff(initial); await initial.done;
    const counter = path.join(device.root, 'npm-count.txt'); device.restoreDependencies = true;
    device.npmCli = path.join(device.root, 'fake-npm.mjs');
    await fs.writeFile(device.npmCli, `import fs from 'node:fs/promises';await fs.appendFile(${JSON.stringify(counter)},'install\\n');`);
    const worker = new Manager(device, null, remote);
    await worker.start({ direction: 'pull', tab: randomUUID() }); await worker.done;
    const pending = await worker.status(); assert.equal(pending.phase, 'PENDING_APPLY');
    assert.equal(await exists(path.join(pending.jobRoot, 'candidate')), false); assert.equal(await exists(counter), false);
    const controlled = new Manager(device, new FakeLifecycle(), { connect() { throw Error('must reuse downloaded payload'); } });
    await controlled.action('resume-pending', { tab: randomUUID() }); await handoff(controlled); await controlled.done;
    assert.equal((await controlled.status()).phase, 'SUCCEEDED'); assert.equal(await fs.readFile(counter, 'utf8'), 'install\n');
});

test('cross-platform executable attachments are data; plugin runtime binaries still need matching platform', async () => {
    const device = await fixture();
    await fs.mkdir(path.join(device.dataRoot, device.profile, 'files'));
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'files/archive.exe'), 'attachment, never executed');
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    await snapshot(device, payload);
    const metadata = await readJson(path.join(payload, 'environment.json')); metadata.sourcePlatform = 'other';
    await atomicJson(path.join(payload, 'environment.json'), metadata);
    const prepared = await prepare(device, payload, await scan(payload), job);
    assert.equal(await fs.readFile(path.join(prepared.candidate, 'profile/files/archive.exe'), 'utf8'), 'attachment, never executed');
    const nextJob = path.join(device.state, 'jobs', randomUUID()), next = path.join(nextJob, 'payload');
    await copyTree(payload, next); await fs.mkdir(path.join(next, 'extensions/demo'), { recursive: true });
    await fs.writeFile(path.join(next, 'extensions/demo/addon.node'), 'native ABI fixture');
    await assert.rejects(prepare(device, next, await scan(next), nextJob), { code: 'NATIVE_RESOURCE' });
});

test('Git executable modes survive Windows snapshot metadata and are retained across local apply/rollback', async () => {
    const device = await fixture(), plugin = path.join(device.install, 'plugins/demo'); await fs.mkdir(plugin);
    await run('git', ['init', '-b', 'main', plugin]);
    const script = path.join(plugin, 'run.sh'); await fs.writeFile(script, '#!/bin/sh\necho portable\n'); await fs.chmod(script, 0o755);
    await run('git', ['-C', plugin, 'add', 'run.sh']); await run('git', ['-C', plugin, 'update-index', '--chmod=+x', 'run.sh']);
    await run('git', ['-C', plugin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'executable fixture']);
    await run('git', ['-C', plugin, 'remote', 'add', 'origin', 'https://example.invalid/fixture/plugin.git']);
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const frozen = await snapshot(device, payload);
    assert.ok(frozen.metadata.executables.includes('server-plugins/demo/run.sh'));
    assert.equal((await portableState(device)).digest, frozen.metadata.sourceState.digest);
    const prepared = await prepare(device, payload, frozen.manifest, job), plan = await buildPlan(device, prepared, job);
    await applyPlan(device, plan);
    assert.ok((await readJson(path.join(device.state, ATTRIBUTES))).executables.includes('server-plugins/demo/run.sh'));
    assert.ok((await snapshot(device, path.join(device.root, 'resnapshot'))).metadata.executables.includes('server-plugins/demo/run.sh'));
    await rollback(device, plan); assert.equal(await exists(path.join(device.state, ATTRIBUTES)), false);
});

test('POSIX owner execution survives copy and permission-agnostic payload transport', async context => {
    if (process.platform === 'win32') { context.skip('POSIX execution requires a POSIX filesystem; Git metadata is exercised on Windows above'); return; }
    const device = await fixture(), script = path.join(device.dataRoot, device.profile, 'helper.sh');
    await fs.writeFile(script, '#!/bin/sh\nprintf portable\n'); await fs.chmod(script, 0o755);
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    const frozen = await snapshot(device, payload);
    assert.equal((await fs.stat(path.join(payload, 'profile/helper.sh'))).mode & 0o777, 0o700);
    await fs.chmod(path.join(payload, 'profile/helper.sh'), 0o600); // rsync -rt does not preserve mode
    const prepared = await prepare(device, payload, frozen.manifest, job);
    assert.equal((await fs.stat(path.join(prepared.candidate, 'profile/helper.sh'))).mode & 0o777, 0o700);
    assert.equal((await run(path.join(prepared.candidate, 'profile/helper.sh'), [])).stdout, 'portable');
});

test('Windows forwarding retains non-Git execution metadata received from a POSIX device', async context => {
    if (process.platform !== 'win32') { context.skip('Windows metadata relay'); return; }
    const device = await fixture(), name = 'profile/custom-helper.sh';
    await fs.writeFile(path.join(device.dataRoot, device.profile, 'custom-helper.sh'), '#!/bin/sh\necho fixture\n');
    const job = path.join(device.state, 'jobs', randomUUID()), payload = path.join(job, 'payload');
    await snapshot(device, payload);
    const environment = path.join(payload, 'environment.json'), metadata = await readJson(environment);
    metadata.executables = [name]; await atomicJson(environment, metadata);
    const prepared = await prepare(device, payload, await scan(payload), job), plan = await buildPlan(device, prepared, job);
    await applyPlan(device, plan);
    assert.ok((await snapshot(device, path.join(device.root, 'forwarded'))).metadata.executables.includes(name));
    await rollback(device, plan);
});

test('execution metadata cannot assign permissions to missing or protected files', async () => {
    for (const names of [['../escape'], ['environment.json'], ['repositories/1/gitdata/hooks/run'], ['server-plugins/tavernsyn/index.mjs'], ['profile/a', 'profile/a']]) {
        assert.throws(() => validateExecutables(names));
    }
    assert.throws(() => validateExecutables(['profile/missing.sh'], { files: [] }), { code: 'FILE_ATTRIBUTES' });
});

test('streaming chat receipt matches canonical messages and metadata for CRLF, Unicode and empty lines', async () => {
    const root = await temporary('chat'), file = path.join(root, 'chat.jsonl');
    const metadata = { z: '说明', nested: { b: 2, a: 1 } }, messages = [{ mes: '你好\n世界', is_user: true }, { mes: '🙂', nested: [null, { z: 0 }] }];
    await fs.writeFile(file, '\r\n' + [{ chat_metadata: metadata }, ...messages].map(JSON.stringify).join('\r\n\r\n'));
    assert.deepEqual(await chatReceipt(file), { digest: digest({ messages, metadata }), sha256: await hashFile(file) });
    await fs.appendFile(file, '\n{partial'); await assert.rejects(chatReceipt(file), { code: 'SAVE_PENDING' });
});

test('a chat larger than the worker heap is verified without whole-file parsing', { timeout: 60000 }, async () => {
    const root = await temporary('large-chat'), file = path.join(root, 'chat.jsonl');
    const message = { is_user: false, mes: 'x'.repeat(4096) }, line = JSON.stringify(message), total = 16384;
    const hash = createHash('sha256'); hash.update('{"messages":[');
    const handle = await fs.open(file, 'wx');
    try {
        await handle.writeFile('{"chat_metadata":{}}\n');
        const batch = (line + '\n').repeat(128);
        for (let i = 0; i < total / 128; i++) await handle.writeFile(batch);
    } finally { await handle.close(); }
    for (let i = 0; i < total; i++) { if (i) hash.update(','); hash.update(canonical(message)); }
    hash.update('],"metadata":{}}');
    const result = await run(process.execPath, ['--max-old-space-size=32', '--input-type=module', '-'], {
        input: `import {chatReceipt} from ${JSON.stringify(pathToFileURL(path.resolve('lib/chat-receipt.mjs')).href)};console.log(JSON.stringify(await chatReceipt(${JSON.stringify(file)})));`,
    });
    assert.equal(JSON.parse(result.stdout).digest, hash.digest('hex'));
    assert.ok((await fs.stat(file)).size > 64 * 1024 * 1024);
});
