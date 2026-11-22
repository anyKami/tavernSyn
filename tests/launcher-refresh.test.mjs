import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsLauncher } from '../bin/startup.mjs';
import { windowsUsbLauncher } from '../bin/usb-launchers.mjs';
import { refreshWindowsLaunchers } from '../bin/refresh-launchers.mjs';

async function fixture(t) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const install = await fs.mkdtemp(path.join(parent, 'launcher-迁移 '));
    t.after(() => fs.rm(install, { recursive: true, force: true }));
    return { install, node: process.execPath, repository: path.join(install, 'plugins/tavernsyn'), state: path.join(install, '本机 pause state') };
}
function scripts(options, legacy = false) {
    const start = windowsLauncher(options), usb = windowsUsbLauncher(options);
    return {
        'Start-TavernSyn.cmd': legacy ? start.replaceAll('if not "%tavernsyn_exit%"=="0" echo TavernSyn 未完成，退出码：%tavernsyn_exit% 1>&2', 'if not "%tavernsyn_exit%"=="0" pause') : start,
        'USB-TavernSyn.cmd': legacy ? usb.replace('if not "%tavernsyn_usb_exit%"=="0" echo USB 同步未完成，退出码：%tavernsyn_usb_exit% 1>&2', 'pause') : usb,
    };
}
const migrateText = source => source
    .replaceAll('if not "%tavernsyn_exit%"=="0" pause', 'if not "%tavernsyn_exit%"=="0" rem  ')
    .replace(/(^|\n)pause(?=\r?\n)/g, '$1rem  ');

test('generated legacy entries migrate only pause bytes, preserve Unicode paths and can resume a partial migration', async t => {
    const f = await fixture(t), legacy = scripts(f, true), logs = [];
    legacy['Start-TavernSyn.cmd'] = '\uFEFF' + legacy['Start-TavernSyn.cmd'].replace('if not "%tavernsyn_exit%"=="0" pause', 'if not "%tavernsyn_exit%"=="0" rem  ');
    legacy['USB-TavernSyn.cmd'] = legacy['USB-TavernSyn.cmd'].replaceAll('\r\n', '\n');
    for (const [name, source] of Object.entries(legacy)) await fs.writeFile(path.join(f.install, name), source);
    const result = await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log: message => logs.push(message) });
    assert.deepEqual(result.updated, Object.keys(legacy)); assert.deepEqual(result.skipped, []);
    for (const [name, source] of Object.entries(legacy)) {
        const actual = await fs.readFile(path.join(f.install, name));
        assert.equal(actual.length, Buffer.byteLength(source));
        assert.equal(actual.toString('utf8'), migrateText(source));
    }
    assert.equal(logs.length, 2);
    assert.deepEqual(await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log() {} }), { updated: [], skipped: [] });
});

test('custom, linked and non-file launchers remain untouched without blocking startup', async t => {
    const f = await fixture(t), legacy = scripts(f, true), start = path.join(f.install, 'Start-TavernSyn.cmd'), usb = path.join(f.install, 'USB-TavernSyn.cmd');
    const custom = legacy['Start-TavernSyn.cmd'] + 'rem my custom launcher\r\n';
    await fs.writeFile(start, custom); await fs.mkdir(usb);
    const logs = [], first = await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log: message => logs.push(message) });
    assert.deepEqual(first.updated, []); assert.deepEqual(first.skipped, [path.basename(start), path.basename(usb)]);
    assert.equal(await fs.readFile(start, 'utf8'), custom); assert.equal((await fs.stat(usb)).isDirectory(), true);
    assert.ok(logs.some(line => line.includes('自定义'))); assert.ok(logs.some(line => line.includes('继续启动')));
    await fs.unlink(start);
    const outside = path.join(f.install, 'shared.cmd'); await fs.writeFile(outside, legacy['Start-TavernSyn.cmd']);
    await fs.link(outside, start);
    assert.deepEqual((await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log() { throw Error('unavailable log'); } })).updated, []);
    assert.equal(await fs.readFile(outside, 'utf8'), legacy['Start-TavernSyn.cmd']);
    const link = path.join(f.install, 'linked-install');
    await fs.symlink(f.install, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual((await refreshWindowsLaunchers({ install: link, platform: 'win32', log() {} })).updated, []);
    assert.equal(await fs.readFile(outside, 'utf8'), legacy['Start-TavernSyn.cmd']);
});

test('current entries, missing files and non-Windows devices require no migration', async t => {
    const f = await fixture(t);
    assert.deepEqual(await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log() {} }), { updated: [], skipped: [] });
    for (const [name, source] of Object.entries(scripts(f))) await fs.writeFile(path.join(f.install, name), source);
    assert.deepEqual(await refreshWindowsLaunchers({ install: f.install, platform: 'win32', log() {} }), { updated: [], skipped: [] });
    const legacy = scripts(f, true)['Start-TavernSyn.cmd']; await fs.writeFile(path.join(f.install, 'Start-TavernSyn.cmd'), legacy);
    assert.deepEqual(await refreshWindowsLaunchers({ install: f.install, platform: 'android', log() {} }), { updated: [], skipped: [] });
    assert.equal(await fs.readFile(path.join(f.install, 'Start-TavernSyn.cmd'), 'utf8'), legacy);
});

test('real Windows entries preserve failure codes without waiting, including migration while cmd is executing', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const f = await fixture(t); await fs.mkdir(path.join(f.repository, 'bin'), { recursive: true });
    await fs.writeFile(path.join(f.install, 'TavernSyn-Startup.mjs'),
        `import { refreshWindowsLaunchers } from ${JSON.stringify(new URL('../bin/refresh-launchers.mjs', import.meta.url).href)};\nawait refreshWindowsLaunchers({ install: ${JSON.stringify(f.install)}, log() {} });\nprocess.exitCode = 37;\n`);
    await fs.writeFile(path.join(f.repository, 'bin/usb.mjs'), 'process.exitCode = 41;\n');
    await fs.writeFile(path.join(f.repository, 'bin/create-desktop-shortcut.ps1'), 'exit 19\r\n');
    async function runBatch(name, argument = '') {
        const child = spawn('cmd.exe', ['/d', '/s', '/c', `""${path.join(f.install, name)}"${argument ? ' ' + argument : ''}"`], {
            windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdout.resume(); child.stderr.resume();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(Error('batch waited for keyboard input')); }, 10000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); resolve(code); });
        });
    }
    for (const legacy of [true, false]) {
        for (const [name, source] of Object.entries(scripts(f, legacy))) await fs.writeFile(path.join(f.install, name), source);
        assert.equal(await runBatch('Start-TavernSyn.cmd'), 37);
        assert.equal(await runBatch('Start-TavernSyn.cmd', '--desktop-shortcut'), 19);
        assert.equal(await runBatch('USB-TavernSyn.cmd'), 41);
    }
});
