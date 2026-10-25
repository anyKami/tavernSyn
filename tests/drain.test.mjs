import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDrainTracker } from '../helper/drain.mjs';

function fixture() {
    const state = { active: 0, uncertain: false };
    const drain = createDrainTracker(state);
    function request(url, method = 'GET', headers = {}) {
        const response = new EventEmitter(); drain.track({ method, url, headers }, response); return response;
    }
    return { state, drain, request };
}

test('reviewed bodyless core and user static cancellations do not block drain', () => {
    const { state, drain, request } = fixture();
    const paths = ['/', '/index.html', '/login.html', '/lib.js', '/style.css', '/manifest.json', '/scripts/i18n.js?cache=1',
        '/css/user.css', '/img/logo.png', '/error/403.html', '/lib/example.js', '/locales/zh-cn.json', '/sounds/ding.mp3',
        '/webfonts/font.woff2', '/backgrounds/bg.jpg', '/characters/synthetic.png', '/User%20Avatars/persona.png',
        '/assets/file.bin', '/user/images/picture.png', '/user/files/document.txt', '/scripts/extensions/third-party/example/index.js',
        '/api/plugins/tavernsyn/status', '/api/plugins/tavernsyn/wait?id=private', '/api/plugins/tavernsyn/configuration'];
    for (const url of paths) for (const method of ['GET', 'HEAD']) request(url, method).emit('close');
    assert.equal(state.active, 0); assert.equal(state.uncertain, false);
    assert.equal(drain.summary().safeAborts, paths.length * 2); assert.equal(drain.failure(), null);
});

test('unknown plugin GET/HEAD, thumbnail generation, proxy and writes stay uncertain', () => {
    for (const [url, method] of [['/api/plugins/example/script.js', 'GET'], ['/api/plugins/example/slow', 'HEAD'],
        ['/api/plugins/cocktail-plus/early/bridge.js', 'GET'], ['/api/plugins/cocktail-plus/module?path=%2Fscript.js', 'GET'],
        ['/thumbnail?file=private&type=avatar', 'GET'], ['/api/extensions/discover', 'GET'], ['/proxy/https://example.invalid', 'GET'],
        ['/api/settings/save', 'POST'], ['/api/chats/save', 'POST'], ['/css/example.css', 'POST'], ['/api/plugins/tavernsyn/start', 'POST'],
        ['/api/plugins/tavernsyn/status', 'POST'], ['/login', 'GET'], ['/csrf-token', 'GET'], ['/version', 'GET'], ['/unknown.js', 'GET']]) {
        const { state, drain, request } = fixture(); request(url, method).emit('close');
        assert.equal(state.active, 0, `${method} ${url}`); assert.equal(state.uncertain, true, `${method} ${url}`);
        assert.equal(drain.summary().uncertainCount, 1); assert.equal(drain.failure().code, 'DRAIN');
    }
});

test('normal response finish and subsequent close settle exactly once', () => {
    const { state, drain, request } = fixture();
    const response = request('/api/settings/save', 'POST');
    assert.equal(state.active, 1); assert.match(drain.failure().message, /POST \/api\/\*/);
    response.emit('finish'); response.emit('close'); response.emit('finish');
    assert.equal(state.active, 0); assert.equal(state.uncertain, false); assert.equal(drain.failure(), null);
});

test('an aborted unsafe handler remains uncertain even if it later emits finish', () => {
    const { state, drain, request } = fixture();
    const response = request('/api/plugins/example/slow'); response.emit('close'); response.emit('finish');
    request('/style.css').emit('finish');
    assert.equal(state.active, 0); assert.equal(state.uncertain, true);
    assert.match(drain.failure().message, /GET \/api\/plugins\/\*/);
});

test('strict raw routing never turns traversal, encoded separators or absolute targets into static exemptions', () => {
    for (const url of ['/proxy/../css/file.css', '/css/../proxy/side-effect', '/css/%2e%2e/proxy/side-effect',
        '/css/%252e%252e/proxy/side-effect', '/css/a%2fb.css', '/css/a%5cb.css', '/css/a\\b.css', '/css/invalid%xx.css',
        '/css/file.css#fragment', '//css/file.css', 'http://localhost/css/file.css', '/api/plugins/example/../../css/file.css']) {
        const { state, request } = fixture(); request(url).emit('close'); assert.equal(state.uncertain, true, url);
    }
});

test('GET/HEAD bodies cannot pass through the global upload middleware under a read exemption', () => {
    for (const url of ['/user/files/synthetic.txt', '/scripts/missing.js', '/api/plugins/tavernsyn/status']) {
        for (const method of ['GET', 'HEAD']) for (const headers of [
            { 'content-type': 'multipart/form-data; boundary=fixture' }, { 'content-length': '1' }, { 'transfer-encoding': 'chunked' },
        ]) {
            const { state, request } = fixture(); request(url, method, headers).emit('close');
            assert.equal(state.uncertain, true, `${method} ${url} ${JSON.stringify(headers)}`);
        }
    }
    const { drain, request } = fixture(); request('/style.css', 'GET', { 'content-length': '0' }).emit('close');
    assert.equal(drain.failure(), null);
});

test('only the reviewed JSON tab heartbeat can exempt a POST cancellation', () => {
    for (const contentType of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
        const { drain, request } = fixture();
        request('/api/plugins/tavernsyn/tabs', 'POST', { 'content-type': contentType }).emit('close');
        assert.equal(drain.failure(), null); assert.equal(drain.summary().safeAborts, 1);
    }
    for (const contentType of [undefined, 'multipart/form-data; boundary=fixture', 'text/plain', 'application/json-extra']) {
        const { state, request } = fixture();
        request('/api/plugins/tavernsyn/tabs', 'POST', { 'content-type': contentType }).emit('close');
        assert.equal(state.uncertain, true);
    }
});

test('diagnostics are bounded and never retain filenames, query values or plugin identifiers', () => {
    let clock = 1000;
    const state = { active: 0, uncertain: false }, drain = createDrainTracker(state, { now: () => clock });
    for (let index = 0; index < 30; index++) {
        const response = new EventEmitter();
        drain.track({ method: 'GET', url: `/api/plugins/private-plugin/secret-character-${index}?token=private-token`, headers: {} }, response);
        response.emit('close');
    }
    for (let index = 0; index < 30; index++) drain.track({ method: 'GET', url: `/user/files/secret-chat-${index}`, headers: {} }, new EventEmitter());
    clock = 4500;
    const summary = drain.summary();
    assert.equal(summary.uncertainCount, 30); assert.equal(summary.active, 30);
    assert.equal(summary.uncertainSamples.length, 6); assert.equal(summary.activeSamples.length, 6);
    assert.equal(summary.uncertainSamples[0].ageMs, 3500);
    const diagnostics = JSON.stringify({ summary, failure: drain.failure() });
    assert.doesNotMatch(diagnostics, /private-plugin|secret-character|secret-chat|private-token|token=/);
    assert.match(diagnostics, /GET \/api\/plugins\/\*/);
});
