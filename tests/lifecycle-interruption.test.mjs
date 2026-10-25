import test from 'node:test';
import assert from 'node:assert/strict';
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

test('a failed save receipt never permits request interruption', async () => {
    let stopped = false;
    const manager = new Manager({}, {
        verifyReceipt: async () => { throw new SyncError('SAVE_CHANGED', 'synthetic changed save'); },
        stop: async () => { stopped = true; },
    });
    manager.waitFor = async () => {}; manager.write = async () => {};
    await assert.rejects(manager.saveAndStop(), { code: 'SAVE_CHANGED' });
    assert.equal(stopped, false);
});

test('the save receipt is checked again after interrupted native shutdown', async () => {
    let verifications = 0, interrupted = false;
    const manager = new Manager({}, {
        verifyReceipt: async () => { if (++verifications === 2) throw new SyncError('SAVE_CHANGED', 'synthetic late write'); },
        stop: async options => { interrupted = options.interruptOnDrain; },
    });
    manager.waitFor = async () => {}; manager.write = async () => {};
    await assert.rejects(manager.saveAndStop(), { code: 'SAVE_CHANGED' });
    assert.equal(interrupted, true); assert.equal(verifications, 2);
});
