import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Lifecycle } from '../helper/lifecycle.mjs';
import { SyncError } from '../lib/io.mjs';
import { Manager } from '../helper/manager.mjs';

function fixture({ pauseError = new SyncError('DRAIN', 'synthetic blocked request'), exit = { code: 0, signal: null } } = {}) {
    const lifecycle = new Lifecycle({}, () => {}), commands = [];
    lifecycle.stopped = false;
    lifecycle.exit = Promise.resolve(exit);
    lifecycle.command = async op => {
        commands.push(op);
        if (op === 'pause' && pauseError) throw pauseError;
        return { ok: true, active: 0, uncertain: false };
    };
    return { lifecycle, commands };
}

test('ordinary stops remain strict and do not interrupt uncertain requests', async () => {
    const { lifecycle, commands } = fixture();
    await assert.rejects(lifecycle.stop(), { code: 'DRAIN' });
    assert.deepEqual(commands, ['pause']);
});

test('saved synchronization can interrupt a blocked instance and waits for its native exit and log flush', async () => {
    const { lifecycle, commands } = fixture();
    let exit, flush, interruptNotice = 0, done = false;
    lifecycle.exit = new Promise(resolve => { exit = resolve; });
    lifecycle.outputDrained = new Promise(resolve => { flush = resolve; });
    const stopping = lifecycle.stop({ interruptOnDrain: true, onInterrupt: async error => {
        assert.equal(error.code, 'DRAIN'); interruptNotice++;
    } }).then(() => { done = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commands, ['pause', 'interrupt-shutdown']);
    assert.equal(done, false); assert.equal(interruptNotice, 1);
    exit({ code: 0, signal: null });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
    flush(); await stopping; assert.equal(done, true);
});

test('healthy synchronization uses normal shutdown without interrupting connections', async () => {
    const { lifecycle, commands } = fixture({ pauseError: null });
    await lifecycle.stop({ interruptOnDrain: true, onInterrupt: () => assert.fail('unexpected interruption') });
    assert.deepEqual(commands, ['pause', 'shutdown']);
});

test('IPC and ownership failures never trigger interruption', async () => {
    for (const code of ['IPC_TIMEOUT', 'UNMANAGED', 'EXITED']) {
        const { lifecycle, commands } = fixture({ pauseError: new SyncError(code, 'synthetic control failure') });
        await assert.rejects(lifecycle.stop({ interruptOnDrain: true }), { code });
        assert.deepEqual(commands, ['pause']);
    }
});

test('an interrupted instance must exit successfully before stop is considered complete', async () => {
    for (const exit of [{ code: 1, signal: null }, { code: null, signal: 'SIGTERM' }]) {
        const { lifecycle } = fixture({ exit });
        await assert.rejects(lifecycle.stop({ interruptOnDrain: true }), { code: 'EXIT_FAILED' });
    }
});

test('cleanup timeout stops synchronization without killing the old process', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, commands } = fixture();
    lifecycle.exit = new Promise(() => {});
    const stopping = lifecycle.stop({ interruptOnDrain: true });
    const rejected = assert.rejects(stopping, { code: 'STOP_TIMEOUT' });
    await new Promise(resolve => setImmediate(resolve));
    context.mock.timers.tick(45000);
    await rejected;
    assert.equal(lifecycle.stopped, false);
    assert.deepEqual(commands, ['pause', 'interrupt-shutdown']);
});

test('automatic synchronization uses a fast owned stop without requiring an unchanged earlier save receipt', async () => {
    let stopped = false;
    const phases = [];
    const manager = new Manager({}, {
        verifyReceipt: async () => assert.fail('a later automatic save must not require another confirmation'),
        stop: async options => { assert.equal(options.fast, true); stopped = true; },
    });
    manager.waitFor = async (_name, phase) => { phases.push(phase); }; manager.write = async phase => { phases.push(phase); };
    assert.equal(await manager.saveAndStop(), true);
    assert.equal(stopped, true);
    assert.deepEqual(phases, ['AWAITING_SAVE', 'WAITING_PAGE', 'QUIESCING']);
});

test('an unchanged synchronization can skip stopping after its automatic save handoff', async () => {
    const manager = new Manager({}, {
        verifyReceipt: async () => assert.fail('no repeated save approval'),
        stop: async () => assert.fail('unchanged data should not restart the server'),
    });
    manager.waitFor = async () => {}; manager.write = async () => {};
    assert.equal(await manager.saveAndStop({ skipStop: async () => true }), false);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fastFixture(context) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
    await fs.mkdir(parent, { recursive: true });
    const state = await fs.mkdtemp(path.join(parent, 'fast-stop-'));
    context.after(() => fs.rm(state, { recursive: true, force: true }));
    const lifecycle = new Lifecycle({ state, install: path.join(state, 'install') }, () => {});
    const commands = [], kills = [];
    lifecycle.stopped = false; lifecycle.nonce = randomUUID();
    const child = lifecycle.child = { pid: 124567, connected: true, exitCode: null, signalCode: null,
        kill(signal) { kills.push(signal); return true; } };
    let resolveExit;
    lifecycle.exit = new Promise(resolve => { resolveExit = resolve; });
    lifecycle.command = async op => { commands.push(op); return { ok: true }; };
    const lockFile = path.join(state, 'instance.lock');
    const lock = { pid: child.pid, nonce: lifecycle.nonce, install: lifecycle.device.install };
    await fs.writeFile(lockFile, JSON.stringify(lock));
    function exit(code = 0, signal = null) {
        lifecycle.stopped = true; child.connected = false; child.exitCode = code; child.signalCode = signal;
        resolveExit({ code, signal });
    }
    return { lifecycle, child, commands, kills, lockFile, lock, exit };
}

test('fast stop completes a timely native exit without killing and waits for logs to finish', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, commands, kills, exit } = await fastFixture(context);
    let flush, done = false;
    lifecycle.outputDrained = new Promise(resolve => { flush = resolve; });
    const stopping = lifecycle.stop({ fast: true }).then(() => { done = true; });
    await tick();
    assert.deepEqual(commands, ['fast-shutdown']);
    exit(); await tick();
    assert.equal(done, false); assert.deepEqual(kills, []);
    flush(); await stopping;
    context.mock.timers.tick(5000); await tick();
    assert.deepEqual(kills, []); assert.equal(done, true);
});

test('fast stop kills only its owned child after two seconds and waits for exit before removing its lock', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, commands, kills, lockFile, lock, exit } = await fastFixture(context);
    let done = false;
    const stopping = lifecycle.stop({ fast: true }).then(() => { done = true; });
    await tick();
    context.mock.timers.tick(1999); await tick();
    assert.deepEqual(kills, []); assert.equal(done, false);
    context.mock.timers.tick(1); await tick();
    assert.deepEqual(commands, ['fast-shutdown']); assert.deepEqual(kills, ['SIGKILL']);
    assert.equal(done, false); assert.equal(lifecycle.stopped, false);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), lock);
    exit(null, 'SIGKILL'); await stopping;
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
    assert.equal(done, true);
});

test('an unresponsive control command cannot delay the fast stop deadline', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, kills, exit } = await fastFixture(context);
    lifecycle.command = () => new Promise(() => {});
    const stopping = lifecycle.stop({ fast: true });
    await tick(); context.mock.timers.tick(2000); await tick();
    assert.deepEqual(kills, ['SIGKILL']);
    exit(null, 'SIGKILL'); await stopping;
});

test('fast stop accepts an observed nonzero native exit without an extra confirmation', async context => {
    const { lifecycle, kills, exit } = await fastFixture(context);
    const stopping = lifecycle.stop({ fast: true });
    await tick(); exit(1); await stopping;
    assert.deepEqual(kills, []); assert.equal(lifecycle.stopped, true);
});

test('fast stop never removes an instance lock belonging to a different process or nonce', async context => {
    for (const field of ['pid', 'nonce', 'install']) {
        const { lifecycle, lockFile, lock, exit } = await fastFixture(context);
        const replacement = { ...lock, [field]: field === 'pid' ? lock.pid + 1 : field === 'install' ? path.join(lock.install, 'another') : randomUUID() };
        await fs.writeFile(lockFile, JSON.stringify(replacement));
        const stopping = lifecycle.stop({ fast: true });
        const rejected = assert.rejects(stopping, { code: 'INSTANCE_LOCK' });
        await tick(); exit(null, 'SIGKILL'); await rejected;
        assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), replacement);
    }
});

test('a failed kill never becomes a successful stop or removes a live instance lock', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, child, lockFile, lock } = await fastFixture(context);
    child.kill = () => { throw Object.assign(new Error('synthetic denied kill'), { code: 'EPERM' }); };
    const stopping = lifecycle.stop({ fast: true });
    const rejected = assert.rejects(stopping, { code: 'STOP_FAILED' });
    await tick(); context.mock.timers.tick(2000); await rejected;
    assert.equal(lifecycle.stopped, false);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), lock);
});

test('a sent kill without an exit event times out instead of permitting file replacement', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, child, kills, lockFile, lock } = await fastFixture(context);
    child.kill = signal => { kills.push(signal); return false; };
    let done = false;
    const stopping = lifecycle.stop({ fast: true }).then(() => { done = true; });
    const rejected = assert.rejects(stopping, { code: 'STOP_TIMEOUT' });
    await tick(); context.mock.timers.tick(2000); await tick();
    assert.deepEqual(kills, ['SIGKILL']); assert.equal(done, false);
    context.mock.timers.tick(3000); await rejected;
    assert.equal(lifecycle.stopped, false); assert.equal(done, false);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), lock);
});

test('fast stop refuses an unknown process identity before sending commands', async context => {
    const { lifecycle, commands, kills } = await fastFixture(context);
    lifecycle.child = null;
    await assert.rejects(lifecycle.stop({ fast: true }), { code: 'OWNERSHIP' });
    assert.deepEqual(commands, []); assert.deepEqual(kills, []);
});

test('a late exit after timeout allows a repeated fast stop to clean only the exited child lock', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { lifecycle, commands, kills, lockFile, lock, exit } = await fastFixture(context);
    const stopping = lifecycle.stop({ fast: true });
    const rejected = assert.rejects(stopping, { code: 'STOP_TIMEOUT' });
    await tick(); context.mock.timers.tick(2000); await tick();
    context.mock.timers.tick(3000); await rejected;
    assert.equal(lifecycle.stopped, false);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), lock);
    exit(null, 'SIGKILL'); await lifecycle.stop({ fast: true });
    await assert.rejects(fs.stat(lockFile), { code: 'ENOENT' });
    assert.deepEqual(commands, ['fast-shutdown']); assert.deepEqual(kills, ['SIGKILL']);
});
