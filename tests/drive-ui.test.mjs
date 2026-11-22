import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { progressDetail } from '../ui/progress.js';

const source = await fs.readFile(new URL('../ui/index.js', import.meta.url), 'utf8');
const begin = source.slice(source.indexOf('async function begin('), source.indexOf('async function usbConnect()'));

for (const action of ['push', 'pull']) test(`Drive ${action} starts directly and retains the saved provider`, async () => {
    const calls = [];
    const context = vm.createContext({ status: { provider: 'google-drive', managed: true }, starting: false, setupBusy: false, localError: '',
        tab: 'fixture-tab', render() {}, showError: error => { throw error; },
        flush() { assert.fail('save only at the actual handoff'); },
        api: async (route, body) => { calls.push({ route, body }); return { phase: 'PREFLIGHT' }; },
    });
    vm.runInContext(begin, context);
    await vm.runInContext(`begin('${action}')`, context);
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'start'); assert.equal(calls[0].body.direction, action);
    assert.equal(context.status.provider, 'google-drive');
});

test('Drive category request is rejected before saving or a start request', async () => {
    const errors = [], calls = [];
    const context = vm.createContext({ status: { provider: 'google-drive' }, starting: false, setupBusy: false, localError: '',
        render: () => calls.push('render'), flush: () => calls.push('flush'),
        api: () => calls.push('api'), showError: error => errors.push(error),
    });
    vm.runInContext(begin, context);
    await vm.runInContext("begin('push', false, true)", context);
    assert.equal(errors.length, 1); assert.match(errors[0].message, /完整同步/);
    assert.deepEqual(calls, []);
});

for (const provider of ['vps', 'google-drive']) test(`${provider} configuration submits only that provider's credential fields`, () => {
    const fields = { provider, host: '100.64.0.1', user: 'tavernsyn', password: 'VPS secret', clientId: 'desktop.apps.googleusercontent.com',
        clientSecret: 'client secret', pairingCode: 'private encryption key' };
    const form = { reportValidity: () => true }, saved = [];
    const code = source.slice(source.indexOf('form.onsubmit ='), source.indexOf("field('provider').addEventListener"));
    vm.runInContext(code, vm.createContext({ form, field: name => ({ value: fields[name] }), setupAction: body => saved.push(body) }));
    form.onsubmit({ preventDefault() {} });
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]), provider === 'google-drive' ? ['provider', 'clientId', 'clientSecret'] : ['provider', 'host', 'user', 'password']);
    assert.equal(saved[0].provider, provider);
    assert.equal(Object.hasOwn(saved[0], 'pairingCode'), false);
});

test('configuration refresh clears credential entry fields and uses backend authorization state', () => {
    const fields = new Map(), texts = new Map();
    const field = name => {
        if (!fields.has(name)) fields.set(name, { value: 'old private input', placeholder: '' });
        return fields.get(name);
    };
    const code = source.slice(source.indexOf('function showConfiguration('), source.indexOf('function updateProviderFields('));
    const context = vm.createContext({ field, text: (name, value) => texts.set(name, value), updatePasswordField() {}, updateProviderFields() {},
        status: {}, passwordSaved: false, savedTarget: '', driveConfig: {}, authorizationPending: false, configLoaded: false,
    });
    vm.runInContext(code, context);
    context.showConfiguration({ provider: 'google-drive', configured: false, drive: { clientConfigured: true, clientId: 'desktop.apps.googleusercontent.com', authorized: false } });
    assert.equal(field('password').value, ''); assert.equal(field('clientSecret').value, '');
    assert.equal(field('clientId').value, 'desktop.apps.googleusercontent.com');
    assert.equal(context.status.provider, 'google-drive'); assert.equal(context.status.configured, false);
    assert.match(texts.get('.ts-drive-state'), /尚未授权/);
    assert.ok([...texts.values()].every(text => !text.includes('old private input')));
});

for (const action of ['button', 'escape', 'native-close']) test(`pairing ${action} clears its secret without waiting for a queued close event`, () => {
    const nodes = { '.ts-pairing-code': { value: 'private pairing code' }, '.ts-pairing-result': { textContent: 'copied' }, '.ts-pairing-close': {} };
    const listeners = new Map(); let closed = false, prevented = false;
    const pairingDialog = { open: true, querySelector: name => nodes[name], addEventListener: (name, fn) => listeners.set(name, fn), close() {
        assert.equal(nodes['.ts-pairing-code'].value, '', 'the secret must already be cleared when close() is called');
        assert.equal(nodes['.ts-pairing-result'].textContent, ''); closed = true; this.open = false;
    } };
    const code = source.slice(source.indexOf('function clearPairingDialog('), source.indexOf("pairingDialog.querySelector('.ts-pairing-copy').onclick"));
    vm.runInContext(code, vm.createContext({ pairingDialog }));
    if (action === 'button') nodes['.ts-pairing-close'].onclick();
    else if (action === 'escape') listeners.get('cancel')({ preventDefault() { prevented = true; } });
    else { pairingDialog.open = false; listeners.get('close')(); }
    assert.equal(nodes['.ts-pairing-code'].value, ''); assert.equal(nodes['.ts-pairing-result'].textContent, '');
    if (action !== 'native-close') assert.equal(closed, true);
    if (action === 'escape') assert.equal(prevented, true);
    // A late close event from the previous opening must not erase a newly revealed code.
    pairingDialog.open = true; nodes['.ts-pairing-code'].value = 'new pairing code'; listeners.get('close')();
    assert.equal(nodes['.ts-pairing-code'].value, 'new pairing code');
});

test('Drive progress describes complete encrypted snapshots without claiming rsync or differential transfer', () => {
    const detail = progressDetail({ provider: 'google-drive', direction: 'push', phase: 'UPLOADING', transferPlan: { files: 1, bytes: 2048 },
        progress: { logicalBytes: 1024 }, stats: { sentBytes: 1024, receivedBytes: 0 } });
    assert.match(detail, /2\.00 KiB/); assert.match(detail, /压缩加密快照/); assert.match(detail, /加密快照已发送/);
    assert.doesNotMatch(detail, /rsync|差异数据|新增、修改文件|不含删除和未变化/);
    assert.match(progressDetail({ transport: 'google-drive', noChanges: true, direction: 'pull' }), /Google 云盘版本/);
});

function renderedReconcile(status, api = async () => { assert.fail('unexpected API request'); }) {
    const nodes = new Map(), messages = new Map();
    const node = selector => {
        if (!nodes.has(selector)) nodes.set(selector, { hidden: false, disabled: false, textContent: '', querySelectorAll: () => [] });
        return nodes.get(selector);
    };
    const root = { querySelector: node, querySelectorAll: selector => selector === 'button' ? [...nodes.values()] : [] };
    const dialog = { open: false, querySelector: selector => node(`dialog ${selector}`), close() { this.open = false; }, showModal() { this.open = true; } };
    const context = vm.createContext({ status, root, dialog, api, usbState: { supported: true, stage: 'idle' }, usbBusy: false,
        usbIntent: null, usbWatchToken: '', usbOverlay: { hidden: true }, usbLabel: () => '', usbAccepted: () => false,
        form: { querySelector: node },
        labels: { SUCCEEDED: '同步完成', FAILED: '同步未完成', PREVIEW: '预览完成' }, localError: '', starting: false,
        setupBusy: false, configLoaded: true, driveConfig: {}, updateProviderFields() {}, progressDetail: () => '',
        text: (selector, value) => messages.set(selector, value), scopeText: value => value.join('、'),
    });
    const render = source.slice(source.indexOf('function render()'), source.indexOf('function showError('));
    const handler = source.slice(source.indexOf("root.querySelector('.ts-reconcile').onclick"), source.indexOf("root.querySelector('.ts-resume-upload').onclick"));
    vm.runInContext(render + '\n' + handler, context); context.render();
    return { context, button: node('.ts-reconcile'), messages };
}

for (const kind of ['published', 'applied', 'checked']) test(`confirmed Drive ${kind} with cloud cleanup warnings can reconcile without changing sync success`, async () => {
    const generation = 'completed-generation', digest = 'completed-digest', calls = [];
    const status = { id: 'completed-job', provider: 'google-drive', phase: 'SUCCEEDED', managed: true,
        direction: kind === 'published' ? 'push' : 'pull', commit: { kind }, remote: { generation, digest },
        maintenancePending: false, maintenance: { pending: [], remote: ['旧快照清理未完成'] } };
    const { context, button, messages } = renderedReconcile(status, async (route, body) => {
        calls.push({ route, body });
        return { phase: 'SUCCEEDED', maintenancePending: false, maintenance: { pending: [], remote: [] }, remote: { generation, digest } };
    });
    assert.equal(button.hidden, false); assert.equal(button.disabled, false);
    assert.equal(messages.get('.ts-phase'), '同步完成');
    await button.onclick();
    assert.equal(calls.length, 1); assert.equal(calls[0].route, 'reconcile'); assert.equal(calls[0].body.id, status.id);
    assert.equal(button.hidden, true); assert.equal(context.status.phase, 'SUCCEEDED');
    assert.equal(context.status.remote.generation, generation); assert.equal(context.status.remote.digest, digest);
    assert.equal(messages.get('.ts-phase'), '同步完成');
});

test('cloud cleanup visibility is limited to confirmed Google outcomes and preserves existing local/VPS controls', () => {
    const base = { provider: 'google-drive', phase: 'SUCCEEDED', managed: true, commit: { kind: 'published' },
        maintenancePending: false, maintenance: { pending: [], remote: ['cleanup pending'] } };
    for (const status of [
        { ...base, provider: 'vps' }, { ...base, commit: { kind: 'restored' } }, { ...base, commit: undefined },
        { ...base, phase: 'PREVIEW' }, { ...base, maintenance: { pending: [], remote: [] } },
    ]) assert.equal(renderedReconcile(status).button.hidden, true);
    assert.equal(renderedReconcile({ ...base, provider: undefined, transport: 'google-drive' }).button.hidden, false);
    assert.equal(renderedReconcile({ ...base, provider: 'vps', maintenancePending: true }).button.hidden, false);
    assert.equal(renderedReconcile({ provider: 'vps', phase: 'FAILED', direction: 'push', snapshotReady: true, managed: true }).button.hidden, false);
    const unmanaged = renderedReconcile({ ...base, managed: false }).button;
    assert.equal(unmanaged.hidden, false); assert.equal(unmanaged.disabled, true);
});
