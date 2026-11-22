import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../ui/index.js', import.meta.url), 'utf8');
const begin = source.slice(source.indexOf('async function begin('), source.indexOf('async function usbConnect()'));

for (const scoped of [false, true]) for (const action of ['push', 'pull']) {
    test(`${scoped ? 'selected' : 'complete'} ${action} starts immediately with the clicked direction`, async () => {
        const calls = [], errors = [];
        const context = vm.createContext({ status: { managed: true }, starting: false, setupBusy: false, localError: '', tab: 'fixture-tab',
            render() {}, flush() { assert.fail('save only at the actual handoff'); },
            root: { querySelectorAll: () => [{ value: 'worlds' }] }, showError: error => errors.push(error),
            api: async (route, body) => { calls.push({ route, body }); return { id: 'fixture-job', phase: 'PREFLIGHT' }; },
        });
        vm.runInContext(begin, context);
        await vm.runInContext(`begin('${action}', false, ${scoped})`, context);
        assert.deepEqual(errors, []); assert.equal(calls.length, 1);
        assert.equal(calls[0].route, 'start'); assert.equal(calls[0].body.direction, action);
        assert.deepEqual(calls[0].body.scope ? Array.from(calls[0].body.scope) : null, scoped ? ['worlds'] : null);
    });
}

for (const action of ['push', 'pull', 'restore']) test(`${action} starts once without an earlier save or duplicate request while starting`, async () => {
    const calls = []; let finish;
    const context = vm.createContext({ status: { provider: 'google-drive', managed: true }, starting: false, setupBusy: false, localError: '', tab: 'fixture-tab',
        render() {}, flush() { assert.fail('save only at the actual handoff'); },
        api: (route, body) => { calls.push([route, body.direction]); return new Promise(resolve => { finish = resolve; }); },
        showError: error => { throw error; },
    });
    vm.runInContext(begin, context);
    const pending = vm.runInContext(`begin('${action}')`, context);
    await vm.runInContext(`begin('${action}')`, context);
    assert.deepEqual(calls, [['start', action]]);
    finish({ phase: 'PREFLIGHT' }); await pending;
    assert.deepEqual(calls, [['start', action]]);
});

test('a managed preview never saves or stops generation', async () => {
    const calls = [];
    const context = vm.createContext({ status: { managed: true }, starting: false, setupBusy: false, localError: '', tab: 'fixture-tab',
        render() {}, flush() { assert.fail('preview must not save or stop generation'); },
        api: async (route, body) => { calls.push({ route, body }); return { phase: 'PREVIEW' }; },
        showError: error => { throw error; },
    });
    vm.runInContext(begin, context); await vm.runInContext("begin('pull', true)", context);
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'start'); assert.equal(calls[0].body.preview, true);
});

test('resume upload uses the existing snapshot immediately without another confirmation', async () => {
    const button = {}, calls = [];
    const handler = source.slice(source.indexOf("root.querySelector('.ts-resume-upload').onclick"), source.indexOf("root.querySelector('.ts-resume-download').onclick"));
    const context = vm.createContext({ status: { id: 'old-job' }, starting: false, setupBusy: false, localError: '', tab: 'fixture-tab',
        root: { querySelector: () => button }, render() {}, showError: error => { throw error; },
        api: async (route, body) => { calls.push({ route, body }); return { phase: 'UPLOADING' }; },
    });
    vm.runInContext(handler, context); await button.onclick();
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'resume-upload');
    assert.equal(calls[0].body.id, 'old-job'); assert.equal(context.status.phase, 'UPLOADING');
});

test('continuing downloaded files defers its only save to the actual handoff', async () => {
    const calls = [];
    const code = source.slice(source.indexOf('async function resumePending()'), source.indexOf("root.querySelector('.ts-resume-apply').onclick"));
    const context = vm.createContext({ status: { phase: 'PENDING_APPLY', managed: true }, starting: false, setupBusy: false, resumed: false,
        localError: '', tab: 'fixture-tab', render() {}, flush() { assert.fail('save only at the actual handoff'); },
        api: async (route, body) => { calls.push({ route, body }); return { phase: 'PREFLIGHT' }; },
        showError: error => { throw error; },
    });
    vm.runInContext(code, context); await context.resumePending();
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'resume-pending');
    assert.equal(context.resumed, true);
});

for (const acceptedTab of ['first-tab', undefined]) test(`automatic save handoff uses ${acceptedTab ? 'the accepted owner tab' : 'the current tab for an older helper'}`, async () => {
    const calls = [], redirects = [];
    const status = { configured: true, phase: 'AWAITING_SAVE', id: 'fixture-job', tab: 'old-tab' };
    const context = vm.createContext({ status, tab: 'current-tab', starting: false, configLoaded: true, resumed: false, handlingSave: false,
        BASE: '/api/plugins/tavernsyn/', URLSearchParams, render() {}, setTimeout() {},
        flush: async () => { calls.push({ route: 'flush' }); return 'saved-receipt'; }, location: { assign: url => redirects.push(url) },
        api: async (route, body) => {
            calls.push({ route, body });
            if (route === 'status') return status;
            return { id: status.id, ticket: 'fixture-ticket', tab: acceptedTab };
        },
    });
    vm.runInContext(pollCode(), context);
    await vm.runInContext('poll()', context);
    assert.deepEqual(calls.map(call => call.route), ['status', 'flush', 'ready']);
    assert.equal(calls.at(-1).body.tab, 'current-tab'); assert.equal(calls.at(-1).body.receipt, 'saved-receipt');
    assert.equal(redirects.length, 1);
    assert.equal(new URL(redirects[0], 'http://localhost').searchParams.get('tab'), acceptedTab ?? 'current-tab');
});

function pollCode() { return source.slice(source.indexOf('async function poll()'), source.indexOf('setInterval(() =>')); }

test('a lost ready reply follows the recorded handoff on the next poll without cancelling or saving again', async () => {
    const calls = [], redirects = [];
    let backend = { configured: true, phase: 'AWAITING_SAVE', id: 'fixture-job', tab: 'old-tab', ticket: 'fixture-ticket' };
    const context = vm.createContext({ status: {}, tab: 'current-tab', starting: false, configLoaded: true, resumed: false, handlingSave: false, localError: '',
        BASE: '/api/plugins/tavernsyn/', URLSearchParams, render() {}, setTimeout() {}, text() {},
        flush: async () => { calls.push('flush'); return 'saved-receipt'; }, location: { assign: url => redirects.push(url) },
        api: async route => {
            calls.push(route);
            if (route === 'status') return { ...backend };
            assert.equal(route, 'ready');
            backend = { ...backend, phase: 'WAITING_PAGE', tab: 'accepted-tab' };
            throw TypeError('synthetic lost response');
        },
    });
    vm.runInContext(pollCode(), context);
    await context.poll();
    assert.equal(context.handlingSave, false); assert.equal(redirects.length, 0);
    await context.poll();
    assert.deepEqual(calls, ['status', 'flush', 'ready', 'status']);
    assert.equal(redirects.length, 1);
    const target = new URL(redirects[0], 'http://localhost');
    assert.equal(target.searchParams.get('tab'), 'accepted-tab'); assert.equal(target.searchParams.get('ticket'), 'fixture-ticket');
});

test('a transient automatic save failure retries while an invalid handoff is not repeatedly submitted', async () => {
    for (const code of [undefined, 'INPUT', 'UNMANAGED']) {
        let saves = 0; const calls = [];
        const context = vm.createContext({ status: {}, tab: 'current-tab', starting: false, configLoaded: true, resumed: false, handlingSave: false, localError: '',
            render() {}, setTimeout() {}, text() {},
            flush: async () => { saves++; throw Object.assign(Error('synthetic handoff failure'), { code }); },
            api: async route => { calls.push(route); assert.equal(route, 'status'); return { configured: true, phase: 'AWAITING_SAVE', id: 'fixture-job' }; },
        });
        vm.runInContext(pollCode(), context);
        await context.poll(); await context.poll();
        assert.equal(saves, code ? 1 : 2); assert.deepEqual(calls, ['status', 'status']);
        assert.equal(context.localError, code ? 'synthetic handoff failure' : '');
    }
});

test('a browser tab from before USB stop/start reloads when the managed epoch changes', async () => {
    const poll = source.slice(source.indexOf('async function poll()'), source.indexOf('setInterval(() =>'));
    const calls = []; let reloads = 0;
    const context = vm.createContext({
        status: {}, tab: 'current-tab', starting: false, configLoaded: true, resumed: false,
        handlingSave: false, window: { __TAVERNSYN__: { epoch: 'old-epoch' } },
        location: { reload: () => { reloads++; } }, render() { assert.fail('must reload before rendering stale data'); },
        setTimeout() { assert.fail('must reload before scheduling another stale poll'); },
        api: async route => { calls.push(route); assert.equal(route, 'status'); return { epoch: 'new-epoch', managed: true, phase: 'SUCCEEDED' }; },
    });
    vm.runInContext(poll, context);
    await vm.runInContext('poll()', context);
    assert.deepEqual(calls, ['status']);
    assert.equal(reloads, 1);
});
