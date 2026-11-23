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
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TavernSyn UI browser fixture</title><style>body{margin:24px auto;max-width:640px;background:#20242d;color:#eee;font:16px system-ui;padding:0 12px}button,input,select,textarea{font:inherit}button{background:#3c414c;color:#eee;border:1px solid #9995;border-radius:6px;padding:8px;cursor:pointer}button:disabled{opacity:.45}.text_pole{background:#161a22;color:#eee;border:1px solid #9997;border-radius:5px;padding:8px}a{color:#9cc9ff}.menu_button{display:flex;align-items:center;justify-content:center;width:min-content;margin:5px 0}.extension_container{display:contents}#extensions_settings2{display:flex;flex-direction:column}button[hidden]{display:none}</style><link rel="stylesheet" href="/ui/style.css"><div id="extensions_settings2"></div><script>window.__TAVERNSYN__={epoch:'browser-fixture',pending:0,lastWrite:0};const fixtureContext={getRequestHeaders:()=>({'Content-Type':'application/json'}),extensionSettings:{},powerUserSettings:{},chatCompletionSettings:{},textCompletionSettings:{},stopGeneration(){},saveChat:async()=>{},saveSettingsDebounced(){}};window.SillyTavern={getContext:()=>fixtureContext};</script><script type="module" src="/ui/index.js"></script>`);
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
    const context = await browser.newContext({ viewport: { width: 1000, height: 1000 }, isMobile: true, hasTouch: true });
    let config = { provider: 'vps', host: '100.64.0.1', user: 'tavernsyn', passwordSaved: true, configured: true,
        dataset: 'vps-fixture', runtimeReady: true, drive: { clientConfigured: false, authorized: false, configured: false } };
    let status = { phase: 'IDLE', provider: 'vps', host: config.host, configured: true, deviceName: 'Browser fixture', managed: false, recovery: { available: false } };
    let usbStatus = { stage: 'idle', supported: true }, usbOffline = false;
    let holdUsbSelect = false, failUsbSelect = false, finishUsbSelect = null;
    const pair = 'TSDRIVE1.' + 'secret-pairing-fixture_'.repeat(20);
    await context.route('**/api/plugins/tavernsyn/**', async route => {
        const action = new URL(route.request().url()).pathname.slice('/api/plugins/tavernsyn/'.length);
        const body = route.request().postDataJSON(); calls.push({ action, body });
        let result = { ok: true };
        if (action === 'status') {
            if (usbOffline) { await route.fulfill({ status: 503, json: { error: 'ST_EXITED' } }); return; }
            result = status;
        }
        if (action === 'usb/status') {
            if (usbOffline && route.request().headers()['x-tavernsyn-usb-watch'] !== 'browser-monitor-token') {
                await route.fulfill({ status: 403, json: { error: 'USB_AUTH' } }); return;
            }
            result = usbStatus;
        }
        if (action === 'flush') result = { receipt: 'browser-fixture-receipt' };
        if (action === 'usb/connect') result = usbStatus = { stage: 'connected', supported: true, peer: { deviceName: 'My phone' }, watchToken: 'browser-monitor-token' };
        if (action === 'usb/select') {
            if (holdUsbSelect) await new Promise(resolve => { finishUsbSelect = resolve; });
            if (failUsbSelect) { await route.abort('failed'); return; }
            result = usbStatus = { ...usbStatus, stage: 'selected', selection: { direction: body.direction } };
        }
        if (action === 'start') result = status = { ...status, phase: 'SUCCEEDED', id: 'browser-fixture-job', direction: body.direction };
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

    status.managed = true;
    await page.waitForFunction(() => !document.querySelector('.ts-usb-connect').disabled);
    await page.locator('.ts-pull').click();
    await page.waitForFunction(() => document.querySelector('.ts-phase').textContent === '同步完成');
    const started = calls.filter(call => call.action === 'start');
    assert.equal(started.length, 1); assert.equal(started[0].body.direction, 'pull');
    assert.equal(calls.some(call => call.action === 'flush'), false, 'managed sync defers saving until the real handoff');
    assert.equal(await page.locator('.ts-direction-dialog').count(), 0);
    checks.push('Drive pull starts once with the clicked direction and no additional confirmation');

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

    config = { provider: 'vps', host: '100.64.0.1', user: 'tavernsyn', passwordSaved: true, configured: true,
        dataset: 'vps-fixture', runtimeReady: true, drive: {} };
    status = { phase: 'IDLE', provider: 'vps', host: config.host, configured: true, deviceName: 'My Android phone', managed: true,
        epoch: 'browser-fixture', recovery: { available: false } };
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('.ts-usb-connect').disabled);
    assert.equal(calls.some(call => call.action === 'usb/select'), false, 'connecting must never choose a direction by itself');
    for (const width of [320, 360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        for (const selector of ['.ts-usb>summary', '.ts-settings>summary', '.ts-usb-connect']) {
            const target = await page.locator(selector).boundingBox();
            assert.ok(target.height >= 48, `${width}px ${selector} must remain easy to tap`);
            assert.ok(target.x >= 0 && target.x + target.width <= width, `${width}px ${selector} must fit`);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.locator('.ts-settings>summary').tap();
        assert.equal(await page.locator('.ts-config').isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        for (const button of await page.locator('.ts-settings .menu_button:visible').all()) {
            const target = await button.boundingBox();
            assert.ok(target.height >= 48 && target.x >= 0 && target.x + target.width <= width, `${width}px settings buttons must fit`);
        }
        for (const selector of ['.ts-preview-push', '.ts-preview-pull']) {
            const target = await page.locator(selector).boundingBox();
            assert.ok(target.width >= 90 && target.height <= 64, 'ST min-content button styling must not make Chinese labels vertical');
        }
        await page.locator('.ts-settings>summary').tap();
        await page.locator('.ts-usb>summary').tap();
        assert.equal(await page.locator('.ts-usb-connect').isVisible(), false);
        await page.locator('.ts-usb>summary').tap();
        assert.equal(await page.locator('.ts-usb-connect').isVisible(), true);
        if ([360, 390].includes(width)) await page.screenshot({ path: `${root}/usb-settings-${width}px.png`, fullPage: true });
    }
    checks.push('320/360/390/430px touch layouts: USB/settings cards toggle, targets are at least 48px, no horizontal overflow');

    for (const direction of ['push', 'pull']) {
        usbStatus = { stage: 'idle', supported: true };
        await page.reload();
        await page.setViewportSize({ width: 360, height: 844 });
        await page.waitForFunction(() => !document.querySelector('.ts-usb-connect').disabled);
        await page.locator('.ts-usb-connect').tap();
        await page.locator('.ts-usb-directions').waitFor({ state: 'visible' });
        for (const selector of ['.ts-usb-push', '.ts-usb-pull']) {
            const target = await page.locator(selector).boundingBox();
            assert.ok(target.height >= 48 && target.x >= 0 && target.x + target.width <= 360);
        }
        const before = calls.filter(call => call.action === 'usb/select').length;
        await page.locator(`.ts-usb-${direction}`).tap();
        await page.waitForFunction(() => document.querySelector('.ts-usb-status').textContent.includes('方向已确认'));
        const selections = calls.filter(call => call.action === 'usb/select');
        assert.equal(selections.length, before + 1); assert.equal(selections.at(-1).body.direction, direction);
        assert.equal(await page.locator('dialog[open]').count(), 0);
    }
    checks.push('touch connection and both USB direction buttons send one selection each without another dialog');

    // The direction API reply is deliberately held while the ST endpoint
    // disappears. The button must change synchronously, then the launcher
    // status bridge must feed actual received bytes during the outage.
    usbStatus = { stage: 'idle', supported: true };
    usbOffline = false; holdUsbSelect = true; failUsbSelect = true; finishUsbSelect = null;
    await page.reload();
    await page.setViewportSize({ width: 320, height: 820 });
    await page.waitForFunction(() => !document.querySelector('.ts-usb-connect').disabled);
    await page.locator('.ts-usb-connect').tap();
    await page.locator('.ts-usb-directions').waitFor({ state: 'visible' });
    await page.locator('.ts-usb-push').tap();
    assert.equal(await page.locator('body > .ts-usb-overlay').count(), 0, 'No global USB overlay should be injected');
    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live:not([hidden])')?.textContent.includes('已点击 电脑 → 手机'));
    assert.equal(await page.locator('.ts-usb-directions').isVisible(), false, 'directions disappear immediately after touching');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    checks.push('USB direction tap immediately replaces buttons with visible phone-safe progress even before HTTP acknowledgement');

    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live')?.textContent.includes('正在通知另一端'));
    usbStatus = { stage: 'transferring', supported: true, watchToken: 'browser-monitor-token',
        peer: { deviceName: 'My phone' }, selection: { direction: 'push' },
        job: { phase: 'DOWNLOADING', bytes: 20971520, files: 100,
            transfer: { mode: 'incremental', bytes: 2097152, files: 7, reusedBytes: 18874368, reusedFiles: 93, totalBytes: 20971520, totalFiles: 100 },
            progress: { stage: 'usb', bytes: 1048576, files: 3 } } };
    usbOffline = true;
    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live .ts-usb-progress')?.value === 50);
    assert.match(await page.locator('#tavernsyn-panel .ts-usb-live .ts-usb-live-bytes').textContent(), /1.00 MiB \/ 2.00 MiB.*50.0%/);
    assert.match(await page.locator('.ts-usb-live .ts-usb-live-bytes').textContent(), /1.00 MiB \/ 2.00 MiB/);
    assert.match(await page.locator('.ts-usb-live .ts-usb-live-bytes').textContent(), /增量传输.*本次传输 3 \/ 7 个文件.*本地复用 93 个文件（18.00 MiB）.*完整镜像 100 个文件（20.00 MiB）/);
    assert.equal(await page.locator('#tavernsyn-panel .ts-usb-live').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(typeof finishUsbSelect, 'function');
    finishUsbSelect();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#tavernsyn-panel .ts-usb-live').isVisible(), true, 'lost direction acknowledgement must not dismiss progress');
    checks.push('offline USB incremental progress uses 1 MiB / 2 MiB wire bytes at 50%, with 18 MiB local reuse and the separate 20 MiB mirror size');

    usbStatus = { ...usbStatus, job: { ...usbStatus.job, phase: 'VERIFYING', progress: { stage: 'usb', bytes: 2097152, files: 7 } } };
    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live .ts-usb-progress')?.value === 100
        && document.querySelector('#tavernsyn-panel .ts-usb-live .ts-usb-live-stage')?.textContent.includes('校验文件'));
    assert.equal(await page.locator('#tavernsyn-panel .ts-usb-live').isVisible(), true, '100% bytes does not mean the apply is finished');
    usbOffline = false;
    // The real completion receipt removes the transient progress field.
    usbStatus = { ...usbStatus, stage: 'completed', job: { ...usbStatus.job, phase: 'SUCCEEDED', progress: null } };
    await page.waitForFunction(() => document.querySelector('.ts-usb-status')?.textContent.includes('USB 同步完成'));
    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live .ts-usb-progress')?.value === 100);
    assert.match(await page.locator('#tavernsyn-panel .ts-usb-live .ts-usb-live-bytes').textContent(), /2.00 MiB \/ 2.00 MiB.*100.0%/);
    assert.doesNotMatch(await page.locator('#tavernsyn-panel .ts-usb-live .ts-usb-live-bytes').textContent(), /已传输 20.00 MiB/);
    assert.equal(await page.locator('body > .ts-usb-overlay').count(), 0, 'Completed USB sync must never leave a floating overlay');
    holdUsbSelect = false; failUsbSelect = false;
    checks.push('100% transfer stays visible inside the extension through verification and success; no page-level overlay remains');

    // All file content can be reused, while deletion, verification and apply
    // still need to run. A zero-byte transfer is neither an unknown total nor
    // permission to claim that the synchronization has completed early.
    usbStatus = { ...usbStatus, stage: 'transferring', job: { phase: 'VERIFYING', bytes: 20971520, files: 100,
        transfer: { mode: 'incremental', bytes: 0, files: 0, reusedBytes: 20971520, reusedFiles: 100, totalBytes: 20971520, totalFiles: 100 },
        progress: { stage: 'usb', bytes: 0, files: 0 } } };
    await page.waitForFunction(() => document.querySelector('#tavernsyn-panel .ts-usb-live .ts-usb-live-bytes')?.textContent.includes('无需传输文件内容（0 B）'));
    assert.match(await page.locator('.ts-usb-live-stage').textContent(), /正在校验文件/);
    assert.doesNotMatch(await page.locator('.ts-usb-status').textContent(), /USB 同步完成/);
    assert.match(await page.locator('.ts-usb-live-bytes').textContent(), /本次传输 0 \/ 0 个文件.*本地复用 100 个文件（20.00 MiB）/);
    assert.equal(await page.locator('.ts-usb-progress').getAttribute('value'), '100');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    usbStatus = { ...usbStatus, stage: 'completed', job: { ...usbStatus.job, phase: 'SUCCEEDED', progress: null } };
    await page.waitForFunction(() => document.querySelector('.ts-usb-status')?.textContent.includes('USB 同步完成'));
    assert.match(await page.locator('.ts-usb-live-bytes').textContent(), /无需传输文件内容（0 B）/);
    assert.equal(await page.locator('body > .ts-usb-overlay').count(), 0);
    checks.push('zero-byte USB reuse remains explicit through verification and completion without a false early success or global overlay');

    // An older peer has no transfer plan and continues to show its original
    // full snapshot counter until both endpoints support incremental transfer.
    usbStatus = { ...usbStatus, stage: 'transferring', job: { phase: 'DOWNLOADING', bytes: 2097152, files: 7,
        progress: { stage: 'usb', bytes: 1048576, files: 3 } } };
    await page.waitForFunction(() => document.querySelector('.ts-usb-progress')?.value === 50);
    assert.match(await page.locator('.ts-usb-live-bytes').textContent(), /已传输 1.00 MiB \/ 2.00 MiB.*50.0%/);
    assert.doesNotMatch(await page.locator('.ts-usb-live-bytes').textContent(), /本地复用/);
    checks.push('legacy USB status without a transfer plan retains its full-transfer progress display');
    assert.deepEqual(errors, []);
    await fs.writeFile(`${root}/drive-ui-browser.json`, JSON.stringify({ checks, errors, passed: checks.length, browser: 'headless Chromium with touch emulation, mocked API; no physical Android, USB or Google account', at: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
} catch (error) {
    // All displayed account data and pairing codes in this fixture are synthetic.
    await page?.screenshot({ path: `${root}/drive-ui-failure.png`, fullPage: true }).catch(() => {});
    await fs.writeFile(`${root}/drive-ui-browser.json`, JSON.stringify({ failed: true, checks, errors: [...errors, error.message],
        passed: checks.length, browser: 'headless Chromium, mocked API, no real Google account', at: new Date().toISOString() }, null, 2)).catch(() => {});
    throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
