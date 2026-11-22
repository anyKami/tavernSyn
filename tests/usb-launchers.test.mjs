import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/io.mjs';
import { windowsUsbLauncher, termuxUsbLauncher } from '../bin/usb-launchers.mjs';

test('Windows USB entry quotes node/state paths and preserves failure status', () => {
    const script = windowsUsbLauncher({ node: 'C:\\Program Files\\nodejs\\node.exe', repository: 'D:\\酒馆 folder\\plugins\\tavernsyn', state: 'D:\\本机 state' });
    assert.match(script, /setlocal DisableDelayedExpansion/);
    assert.match(script, /"C:\\Program Files\\nodejs\\node.exe"/);
    assert.match(script, /--state "D:\\本机 state" --mode client %\*/);
    assert.match(script, /set "tavernsyn_usb_exit=%ERRORLEVEL%"/);
    assert.match(script, /exit \/b %tavernsyn_usb_exit%/);
    for (const bad of ['D:\\%TEMP%', 'D:\\!unsafe', 'D:\\"quoted', 'D:\\line\nbreak']) {
        assert.throws(() => windowsUsbLauncher({ node: 'node', repository: bad, state: 'state' }), { code: 'INSTALL' });
    }
});

test('Termux USB entry preserves shell metacharacters as path data and forwards options', { skip: process.platform === 'win32' }, async t => {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "usb entry ' $ "));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const repository = path.join(root, 'repo'), state = path.join(root, 'device $(no-command)');
    await fs.mkdir(path.join(repository, 'bin'), { recursive: true });
    await fs.writeFile(path.join(repository, 'bin/usb.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
    const entry = path.join(root, 'usb-tavernsyn.sh');
    await fs.writeFile(entry, termuxUsbLauncher({ node: process.execPath, repository, state }));
    const result = await run('sh', [entry, '--port', '17654']);
    assert.deepEqual(JSON.parse(result.stdout), ['--state', state, '--mode', 'serve', '--port', '17654']);
});
