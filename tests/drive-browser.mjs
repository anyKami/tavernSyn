import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.env.TAVERNSYN_PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = process.env.TAVERNSYN_BROWSER_OUTPUT || await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-drive-browser-'));
await fs.mkdir(root, { recursive: true });
const checks = [], errors = [], calls = [];
const server = http.createServer(async (req, res) => {
    if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Drive UI browser fixture</title><style>body{margin:24px auto;max-width:640px;background:#20242d;color:#eee;font:16px system-ui;padding:0 12px}button,input,select,textarea{font:inherit}button{background:#3c414c;color:#eee;border:1px solid #9995;border-radius:6px;padding:8px;cursor:pointer}button:disabled{opacity:.45}.text_pole{background:#161a22;color:#eee;border:1px solid #9997;border-radius:5px;padding:8px}a{color:#9cc9ff}button[hidden]{display:none}</style><link rel="stylesheet" href="/ui/style.css"><div id="extensions_settings2"></div><script>window.SillyTavern={getContext:()=>({getRequestHeaders:()=>({'Content-Type':'application/json'})})};</script><script type="module" src="/ui/index.js"></script>`);
        return;
    }
    if (/^\/ui\/(index\.js|progress\.js|style\.css)$/.test(req.url)) {
        res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
        res.end(await fs.readFile(path.join(repo, req.url.slice(1)))); return;
    }
    res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, page;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.TAVERNSYN_CHROMIUM ? { executablePath: process.env.TAVERNSYN_CHROMIUM } : {}) });
    const context = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
    let config = { provider: 'vps', host: '100.64.0.1', user: 'tavernsyn', passwordSaved: true, configured: true,
        dataset: 'vps-fixture', runtimeReady: true, drive: { clientConfigured: false, authorized: false, configured: false } };
    let status = { phase: 'IDLE', provider: 'vps', host: config.host, configured: true, deviceName: 'Browser fixture', managed: false, recovery: { available: false } };
    const pair = 'TSDRIVE1.' + 'secret-pairing-fixture_'.repeat(20);
    await context.route('**/api/plugins/tavernsyn/**', async route => {
        const action = new URL(route.request().url()).pathname.split('/').at(-1);
        const body = route.request().postDataJSON(); calls.push({ action, body });
        let result = { ok: true };
        if (action === 'status') result = status;
        if (action === 'configuration') result = config;
        if (action === 'configure') {
            config = { ...config, provider: body.provider, configured: false, drive: { clientConfigured: true, clientId: body.clientId, authorized: false, configured: false } };
            status = { ...status, provider: 'google-drive', configured: false }; result = config;
        }
        if (action === 'drive-authorize') { config.drive.authPending = true; result = { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture' }; }
        if (action === 'drive-create') {
            config.drive = { ...config.drive, configured: true, rootId: 'root-fixture', folderId: 'folder-fixture', dataset: 'drive-fixture' };
            config.configured = true; status.configured = true; result = { pairingCode: pair };
        }
        if (action === 'drive-pairing') result = { pairingCode: pair };
        if (action === 'check') result = { dataset: 'drive-fixture', current: null };
        if (action === 'drive-join') { if (body.pairingCode === 'bad-code') { await route.fulfill({ status: 400, json: { error: 'DRIVE_PAIRING', message: '仓库配对信息格式无效。' } }); return; } }
        if (action === 'drive-disconnect') { config.drive.authorized = false; config.drive.configured = false; config.configured = false; status.configured = false; }
        await route.fulfill({ json: result });
    });
    await context.route('https://accounts.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Mock Google authorization</h1>' }));
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('.ts-settings summary').click();
    await page.locator('select[name="provider"]').selectOption('google-drive');
    assert.equal(await page.locator('input[name="host"]').isDisabled(), true);
    await page.locator('input[name="clientId"]').fill('desktop-fixture.apps.googleusercontent.com');
    await page.locator('input[name="clientSecret"]').fill('private-client-secret');
    await page.locator('.ts-save-config').click();
    await page.waitForFunction(() => document.querySelector('.ts-config-result').textContent.includes('配置已保存并立即生效'));
    assert.equal(await page.locator('input[name="clientSecret"]').inputValue(), '');
    assert.match(await page.locator('.ts-push').textContent(), /Google 云盘/);
    assert.equal(await page.locator('.ts-scope').isVisible(), false);
    checks.push('provider switch saves only Google fields, masks secret, hides scoped actions and updates buttons');

    // Simulate a popup-blocking browser; the fallback link must remain usable.
    await page.evaluate(() => { window.open = () => null; });
    await page.locator('.ts-drive-authorize').click();
    await page.locator('.ts-drive-auth-link a').waitFor({ state: 'visible' });
    assert.match(await page.locator('.ts-drive-auth-link a').getAttribute('href'), /^https:\/\/accounts.google.com\//);
    config.drive.authorized = true; config.drive.authPending = false;
    await page.locator('.ts-drive-refresh').click();
    await page.waitForFunction(() => !document.querySelector('.ts-drive-create').disabled);
    assert.equal(await page.locator('.ts-drive-auth-link').isVisible(), false);
    checks.push('blocked popup exposes safe Google link and authorization refresh enables repository creation');

    await page.locator('.ts-drive-create').click();
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.ts-pairing-code').inputValue(), pair);
    await page.locator('.ts-pairing-close').click();
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ts-pairing-code').inputValue(), '');
    await page.locator('.ts-drive-pairing').click();
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.ts-pairing-code').inputValue(), pair);
    await page.keyboard.press('Escape');
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ts-pairing-code').inputValue(), '');
    checks.push('create and reveal pairing code works, close button and Escape both clear its DOM value');

    await page.locator('.ts-drive-join-code').fill('bad-code');
    await page.locator('.ts-drive-join').click();
    await page.waitForFunction(() => document.querySelector('.ts-config-result').textContent.includes('仓库配对信息格式无效'));
    assert.equal(await page.locator('.ts-drive-refresh').isDisabled(), false);
    await page.locator('.ts-drive-join-code').fill('');
    await page.locator('.ts-check').click();
    await page.waitForFunction(() => document.querySelector('.ts-check-result').textContent.includes('仓库还没有同步副本'));
    checks.push('join errors preserve usable controls and empty repository checks instruct initial push');

    await page.locator('.ts-pull').click();
    await page.locator('.ts-direction-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('.ts-direction-dialog .ts-detail').textContent(), /Google 云盘/);
    await page.locator('.ts-decline').click();
    assert.equal(calls.some(call => call.action === 'start'), false);
    checks.push('Drive pull confirmation uses correct target and cancel never starts a task');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${root}/drive-ui-mobile.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('.ts-drive-pairing').click();
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: `${root}/drive-ui-pairing-mobile.png` });
    const box = await page.locator('.ts-pairing-dialog').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390);
    checks.push('390px viewport has no horizontal overflow; pairing dialog stays within viewport');
    await page.locator('.ts-pairing-close').click();
    await page.locator('.ts-pairing-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.ts-pairing-code').inputValue(), '');
    await page.locator('.ts-drive-disconnect').click();
    await page.waitForFunction(() => document.querySelector('.ts-config-result').textContent.includes('已移除本机 Google 授权'));
    assert.equal(await page.locator('.ts-drive-create').isDisabled(), true);
    checks.push('disconnect updates authorization state without a cloud delete action');
    assert.deepEqual(errors, []);
    await fs.writeFile(`${root}/drive-ui-browser.json`, JSON.stringify({ checks, errors, passed: checks.length, browser: 'headless Chromium, mocked API, no real Google account', at: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
} catch (error) {
    // All displayed account data and pairing codes in this fixture are synthetic.
    await page?.screenshot({ path: `${root}/drive-ui-failure.png`, fullPage: true }).catch(() => {});
    await fs.writeFile(`${root}/drive-ui-browser.json`, JSON.stringify({ failed: true, checks, errors: [...errors, error.message],
        passed: checks.length, browser: 'headless Chromium, mocked API, no real Google account', at: new Date().toISOString() }, null, 2)).catch(() => {});
    throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
