import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../ui/index.js', import.meta.url), 'utf8');
const flush = source.slice(source.indexOf('async function flush()'), source.indexOf('const root ='));
function fixture({ saveChat = async () => {}, api } = {}) {
    const calls = [];
    const ctx = { extensionSettings: {}, stopGeneration: () => { calls.push('stop'); },
        saveSettingsDebounced: () => { calls.push('settings'); }, saveChat: () => { calls.push('chat'); return saveChat(); } };
    const context = vm.createContext({ window: { __TAVERNSYN__: { pending: 2, lastWrite: Date.now() } },
        context: () => ctx, crypto: { randomUUID: () => 'fixture-nonce' }, AbortController, setTimeout, clearTimeout,
        hash: async () => 'fixture-digest', delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
        api: api ?? (async (route, body) => { calls.push({ route, body }); return { receipt: 'disk-receipt' }; }),
        document: { querySelector() { assert.fail('drafts and open editors must not block automatic sync'); } },
    });
    vm.runInContext(flush, context);
    return { context, calls };
}

test('automatic save stops generation and accepts a disk receipt without a quiet-time delay', async () => {
    const { context, calls } = fixture();
    assert.equal(await context.flush(), 'disk-receipt');
    assert.deepEqual(calls.slice(0, 3), ['stop', 'settings', 'chat']);
    assert.equal(calls.length, 4); assert.equal(calls[3].route, 'flush');
    assert.equal(calls[3].body.nonce, 'fixture-nonce');
    assert.equal(calls[3].body.quick, undefined);
});

test('a failed save automatically falls back to the current disk contents', async () => {
    const { context, calls } = fixture({ saveChat: async () => { throw Error('third-party save failure'); } });
    assert.equal(await context.flush(), 'disk-receipt');
    assert.equal(calls.at(-1).body.quick, true);
    assert.equal(calls.at(-1).body.nonce, 'fixture-nonce');
});

test('a stalled chat save is bounded and cannot start a late strict receipt request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let finish;
    const { context, calls } = fixture({ saveChat: () => new Promise(resolve => { finish = resolve; }) });
    const pending = context.flush();
    await Promise.resolve();
    t.mock.timers.tick(1500);
    assert.equal(await pending, 'disk-receipt');
    assert.equal(calls.at(-1).body.quick, true);
    finish(); await Promise.resolve(); await Promise.resolve();
    assert.equal(calls.filter(call => call.route === 'flush').length, 1);
});

test('a stalled strict receipt request is aborted before the automatic disk fallback', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const requests = []; let strictStarted;
    const started = new Promise(resolve => { strictStarted = resolve; });
    const { context } = fixture({ api: async (route, body, { signal } = {}) => {
        requests.push({ body, signal });
        if (body.quick) return { receipt: 'quick-receipt' };
        strictStarted();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }));
    } });
    const pending = context.flush(); await started;
    t.mock.timers.tick(1500);
    assert.equal(await pending, 'quick-receipt');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].body.quick, true);
    assert.equal(requests.length, 2);
});
