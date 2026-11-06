import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../ui/index.js', import.meta.url), 'utf8');
const direction = source.slice(source.indexOf('function confirmDirection('), source.indexOf('const target ='));
const begin = source.slice(source.indexOf('async function begin('), source.indexOf("root.querySelector('.ts-push').onclick"));

for (const scoped of [false, true]) for (const action of ['push', 'pull']) {
    for (const accept of [true, false]) test(`${scoped ? 'selected' : 'complete'} ${action} asks once and ${accept ? 'starts' : 'cancels'}`, async () => {
        const nodes = new Map(), calls = [], errors = [];
        let prompts = 0;
        const modal = { close() {}, showModal() { prompts++; }, querySelector(selector) {
            if (!nodes.has(selector)) nodes.set(selector, { textContent: '', focus() {} });
            return nodes.get(selector);
        } };
        const context = vm.createContext({ status: { managed: false }, starting: false, setupBusy: false, localError: '', tab: 'fixture-tab',
            directionDialog: modal, dialog: { open: false, showModal() {} }, scopeText: names => names.join(','), render() {}, text() {}, flush() {},
            root: { querySelectorAll: () => [{ value: 'worlds' }] }, showError: error => errors.push(error),
            api: async (route, body) => { calls.push({ route, body }); return { id: 'fixture-job', phase: 'PREFLIGHT' }; },
        });
        vm.runInContext(direction + '\n' + begin, context);
        const pending = vm.runInContext(`begin('${action}', false, ${scoped})`, context);
        assert.equal(prompts, 1); assert.equal(calls.length, 0);
        modal.querySelector(accept ? '.ts-accept' : '.ts-decline').onclick();
        await pending;
        assert.deepEqual(errors, []); assert.equal(prompts, 1);
        assert.equal(calls.length, accept ? 1 : 0);
        if (accept) {
            assert.equal(calls[0].route, 'start'); assert.equal(calls[0].body.direction, action);
            assert.deepEqual(calls[0].body.scope ? Array.from(calls[0].body.scope) : null, scoped ? ['worlds'] : null);
        }
    });
}

test('a refreshed page retries the automatic save handoff while an old tab heartbeat expires', async () => {
    const poll = source.slice(source.indexOf('async function poll()'), source.indexOf('setInterval(() =>'));
    const calls = [], redirects = [], messages = [];
    let readyAttempts = 0;
    const status = { configured: true, phase: 'AWAITING_SAVE', id: 'fixture-job', tab: 'old-tab' };
    const context = vm.createContext({ status, tab: 'current-tab', starting: false, configLoaded: true, resumed: false, handlingSave: false,
        BASE: '/api/plugins/tavernsyn/', URLSearchParams, render() {}, setTimeout() {}, text: (...args) => messages.push(args),
        flush: async () => 'saved-receipt', location: { assign: url => redirects.push(url) },
        api: async (route, body) => {
            calls.push({ route, body });
            if (route === 'status') return status;
            if (++readyAttempts === 1) throw Object.assign(Error('another active tab'), { code: 'OTHER_TABS' });
            return { id: status.id, ticket: 'fixture-ticket' };
        },
    });
    vm.runInContext(poll, context);
    await vm.runInContext('poll()', context);
    assert.equal(context.handlingSave, false); assert.equal(redirects.length, 0);
    assert.equal(messages.at(-1)[1], 'another active tab');
    await vm.runInContext('poll()', context);
    assert.deepEqual(calls.map(call => call.route), ['status', 'ready', 'status', 'ready']);
    assert.equal(calls.at(-1).body.tab, 'current-tab'); assert.equal(calls.at(-1).body.receipt, 'saved-receipt');
    assert.equal(redirects.length, 1); assert.match(redirects[0], /tab=current-tab/);
});
