import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserEpoch, epochResource, isReadOnlyScript, RESOURCE_EPOCH } from '../helper/epoch.mjs';

const url = path => new URL(path, 'http://127.0.0.1:8000');
test('browser-loaded Cocktail+ scripts and its five entry modules remain readable', () => {
    const paths = ['/api/plugins/cocktail-plus/early/bridge.js', '/api/plugins/cocktail-plus/sw.js',
        ...['/script.js', '/scripts/i18n.js', '/scripts/system-messages.js', '/scripts/extensions.js', '/scripts/welcome-screen.js']
            .map(path => '/api/plugins/cocktail-plus/module?' + new URLSearchParams({ path }))];
    for (const path of paths) for (const method of ['GET', 'HEAD']) assert.equal(isReadOnlyScript(method, url(path)), true);
});
test('script compatibility cannot exempt writes, unreviewed modules or other plugin APIs', () => {
    for (const path of ['/api/plugins/cocktail-plus/early/bridge.js', '/api/plugins/cocktail-plus/sw.js', '/api/plugins/cocktail-plus/module?path=%2Fscript.js']) {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isReadOnlyScript(method, url(path)), false);
    }
    for (const path of ['/api/settings/save', '/api/plugins/cocktail-plus/status', '/api/plugins/cocktail-plus/early/install',
        '/api/plugins/cocktail-plus/module', '/api/plugins/cocktail-plus/module?path=%2Fscripts%2Fother.js',
        '/api/plugins/cocktail-plus/module?path=%2Fscript.js&path=%2Fscripts%2Fother.js',
        '/api/plugins/cocktail-plus/module?path=%2F..%2Fscript.js', '/api/plugins/another/module?path=%2Fscript.js']) {
        assert.equal(isReadOnlyScript('GET', url(path)), false);
    }
});

test('native plugin resources require the current epoch and browser script/worker context', () => {
    const epoch = 'synthetic-current', origin = 'http://127.0.0.1:8000';
    for (const destination of ['script', 'worker', 'sharedworker', 'serviceworker']) {
        const headers = { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': destination };
        const target = url(`/api/plugins/demo/module.js?${RESOURCE_EPOCH}=${epoch}`);
        assert.equal(epochResource('GET', target, headers, epoch, origin).allowed, true);
        assert.equal(epochResource('POST', target, headers, epoch, origin).allowed, false);
        assert.equal(epochResource('GET', target, headers, 'next-epoch', origin).allowed, false);
        assert.equal(epochResource('GET', target, { ...headers, 'sec-fetch-site': 'cross-site' }, epoch, origin).allowed, false);
        assert.equal(epochResource('GET', target, { ...headers, 'sec-fetch-dest': 'empty' }, epoch, origin).allowed, false);
        assert.equal(epochResource('GET', target, { ...headers, 'x-tavernsyn-epoch': 'stale' }, epoch, origin).allowed, false);
        assert.equal(epochResource('GET', url(`/api/settings/save?${RESOURCE_EPOCH}=${epoch}`), headers, epoch, origin).allowed, false);
        const child = epochResource('GET', url('/api/plugins/demo/child.js'), { ...headers, referer: target.href }, epoch, origin);
        assert.equal(child.allowed, true); assert.equal(new URL(child.redirect, origin).searchParams.get(RESOURCE_EPOCH), epoch);
        assert.equal(epochResource('GET', url('/api/plugins/demo/child.js'), { ...headers, referer: target.href.replace('127.0.0.1', 'localhost') }, epoch, origin).allowed, true);
        assert.equal(epochResource('GET', url('/api/plugins/demo/child.js'), { ...headers, referer: origin + '/' }, epoch, origin).allowed, false);
    }
});

test('browser script properties, attributes, DOM insertion and worker entry points bind resource URLs', async () => {
    class Node { appendChild(value) { return value; } insertBefore(value) { return value; } replaceChild(value) { return value; } }
    class Element extends Node {
        attributes = new Map();
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name); }
        hasAttribute(name) { return this.attributes.has(name); }
        querySelectorAll() { return []; }
    }
    class Script extends Element { get src() { return this.getAttribute('src'); } set src(value) { this.attributes.set('src', String(value)); } }
    class Worker { constructor(url, options) { this.url = String(url); this.options = options; } }
    class XHR { open() {} send() {} }
    const registered = [], navigator = { serviceWorker: { register(url, options) { registered.push({ url, options }); return Promise.resolve(); } } };
    const window = { fetch() {}, Worker, SharedWorker: Worker }, location = new URL('http://127.0.0.1:8000/');
    vm.runInNewContext(browserEpoch('current-epoch'), { window, location, URL, Request, Headers, XMLHttpRequest: XHR,
        HTMLScriptElement: Script, Element, Node, navigator, addEventListener() {} });
    const script = new Script(); script.src = '/api/plugins/demo/module.js';
    assert.equal(new URL(script.src).searchParams.get(RESOURCE_EPOCH), 'current-epoch');
    script.setAttribute('src', '/api/plugins/demo/second.js?keep=value');
    assert.equal(new URL(script.src).searchParams.get('keep'), 'value');
    const raw = new Script(); raw.attributes.set('src', '/api/plugins/demo/raw.js'); new Node().appendChild(raw);
    assert.equal(new URL(raw.src).searchParams.get(RESOURCE_EPOCH), 'current-epoch');
    for (const Constructor of [window.Worker, window.SharedWorker]) {
        const worker = new Constructor('/api/plugins/demo/worker', { type: 'module' });
        assert.equal(new URL(worker.url).searchParams.get(RESOURCE_EPOCH), 'current-epoch'); assert.equal(worker.options.type, 'module');
    }
    await navigator.serviceWorker.register('/api/plugins/demo/sw.js', { scope: '/' });
    assert.equal(new URL(registered[0].url).searchParams.get(RESOURCE_EPOCH), 'current-epoch');
    script.src = 'https://example.invalid/foreign.js'; assert.equal(script.src, 'https://example.invalid/foreign.js');
});
