import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyScript } from '../helper/epoch.mjs';

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
