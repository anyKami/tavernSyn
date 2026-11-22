import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { progressDetail } from '../ui/progress.js';

const source = await fs.readFile(new URL('../ui/index.js', import.meta.url), 'utf8');
const direction = source.slice(source.indexOf('function confirmDirection('), source.indexOf('const target ='));
const begin = source.slice(source.indexOf('async function begin('), source.indexOf("root.querySelector('.ts-push').onclick"));

for (const action of ['push', 'pull']) test(`Drive ${action} confirmation identifies the actual saved provider`, async () => {
    const nodes = new Map(), modal = { close() {}, showModal() {}, querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { textContent: '', focus() {} });
        return nodes.get(selector);
    } };
    const context = vm.createContext({ status: { provider: 'google-drive' }, directionDialog: modal });
    vm.runInContext(direction, context);
    const promise = vm.runInContext(`confirmDirection('${action}')`, context);
    assert.match(modal.querySelector('h3').textContent, /Google 云盘/);
    assert.match(modal.querySelector('.ts-detail').textContent, /Google 云盘/);
    assert.doesNotMatch(modal.querySelector('.ts-detail').textContent, /VPS/);
    modal.querySelector('.ts-decline').onclick();
    assert.equal(await promise, false);
});

test('Drive category request is rejected before confirmation, saving or a start request', async () => {
    const errors = [], calls = [];
    const context = vm.createContext({ status: { provider: 'google-drive' }, starting: false, setupBusy: false, localError: '',
        render: () => calls.push('render'), confirmDirection: () => calls.push('confirm'), flush: () => calls.push('flush'),
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

test('closing the pairing dialog removes the secret from the DOM', () => {
    const nodes = { '.ts-pairing-code': { value: 'private pairing code' }, '.ts-pairing-result': { textContent: 'copied' } };
    let onClose;
    const pairingDialog = { querySelector: name => nodes[name], addEventListener(name, fn) { assert.equal(name, 'close'); onClose = fn; } };
    const code = source.slice(source.indexOf("pairingDialog.addEventListener('close'"), source.indexOf("pairingDialog.querySelector('.ts-pairing-close')"));
    vm.runInContext(code, vm.createContext({ pairingDialog })); onClose();
    assert.equal(nodes['.ts-pairing-code'].value, ''); assert.equal(nodes['.ts-pairing-result'].textContent, '');
});

test('Drive progress describes complete encrypted snapshots without claiming rsync or differential transfer', () => {
    const detail = progressDetail({ provider: 'google-drive', direction: 'push', phase: 'UPLOADING', transferPlan: { files: 1, bytes: 2048 },
        progress: { logicalBytes: 1024 }, stats: { sentBytes: 1024, receivedBytes: 0 } });
    assert.match(detail, /2\.00 KiB/); assert.match(detail, /压缩加密快照/); assert.match(detail, /加密快照已发送/);
    assert.doesNotMatch(detail, /rsync|差异数据|新增、修改文件|不含删除和未变化/);
    assert.match(progressDetail({ transport: 'google-drive', noChanges: true, direction: 'pull' }), /Google 云盘版本/);
});
