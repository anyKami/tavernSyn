import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserCommand, openBrowser } from '../helper/browser.mjs';
import { createSyncLog, rsyncOutputLog } from '../helper/sync-log.mjs';
import { Manager } from '../helper/manager.mjs';
import { PROJECT } from '../lib/device.mjs';
import { run, exists } from '../lib/io.mjs';
import { fixture, temporary, MemoryTransport, FakeLifecycle, handoff } from './fixtures.mjs';

test('browser opener delegates only a plain local URL to the default browser', async () => {
    const windows = browserCommand('http://127.0.0.1:8000', 'win32');
    assert.equal(windows.file, 'powershell.exe');
    assert.equal(Buffer.from(windows.args.at(-1), 'base64').toString('utf16le'), "Start-Process -FilePath 'http://127.0.0.1:8000/'");
    for (const url of ['https://example.com/', 'http://user:pass@127.0.0.1:8000/', 'http://127.0.0.1:8000/?x=cmd', 'http://127.0.0.1:8000/"']) {
        assert.throws(() => browserCommand(url, 'win32'));
    }
    let command;
    await openBrowser('http://127.0.0.1:8000', async (file, args) => { command = { file, args }; });
    assert.deepEqual(command, browserCommand('http://127.0.0.1:8000'));
});

test('sync log mirrors timestamped task detail into the terminal and persistent file', async () => {
    const root = await temporary('sync-log'); let consoleText = '';
    const log = createSyncLog(root, { write(value) { consoleText += value; } });
    log({ direction: 'push', id: '12345678-0000-0000-0000-000000000000' }, '阶段：上传\n不允许伪造新行');
    log({ direction: 'pull' }, '下载文件 profile/世界书.txt');
    log.close();
    const saved = await fs.readFile(path.join(root, 'sync.log'), 'utf8');
    assert.equal(saved, consoleText); assert.match(saved, /\+08:00.*推送 12345678/);
    assert.match(saved, /阶段：上传 不允许伪造新行/); assert.match(saved, /拉取.*世界书.txt/);
    assert.equal(saved.trim().split('\n').length, 2);
});

test('rsync log preserves file changes and errors while throttling progress-only lines', () => {
    const lines = []; let now = 0;
    const output = rsyncOutputLog(value => lines.push(value), () => now);
    output.write('>f+++++++++ profile/世'); output.write('界书.txt\n 1,000 10% 1MB/s\r');
    output.write(' 2,000 20% 1MB/s\r*deleting profile/old.json\n');
    now = 6000; output.write(' 3,000 30% 1MB/s\rPermission denied'); output.end();
    assert.ok(lines.includes('rsync: >f+++++++++ profile/世界书.txt'));
    assert.ok(lines.includes('rsync: *deleting profile/old.json'));
    assert.equal(lines.filter(value => /\d+%/.test(value)).length, 2);
    assert.ok(lines.includes('rsync: Permission denied'));
});

test('both push and pull emit task phases, manifest counts, checks and successful publication', async () => {
    const device = await fixture(), remote = new MemoryTransport(path.join(device.root, 'vps'));
    await fs.mkdir(remote.root);
    const lines = [], manager = new Manager(device, new FakeLifecycle(), remote, (job, line) => lines.push(`${job.direction}: ${line}`));
    await manager.start({ direction: 'push', tab: randomUUID() }); await handoff(manager); await manager.done;
    await manager.start({ direction: 'pull', tab: randomUUID() }); await handoff(manager); await manager.done;
    const text = lines.join('\n');
    for (const phase of ['push: 阶段：上传到 VPS', 'pull: 阶段：从 VPS 下载', 'pull: 阶段：校验文件', 'pull: 阶段：应用更新']) assert.ok(text.includes(phase), phase);
    assert.match(text, /快照：\d+ 个文件/); assert.match(text, /VPS 代次：/); assert.match(text, /传输统计：/);
    assert.equal((await manager.status()).phase, 'SUCCEEDED');
});

test('desktop shortcuts preserve the working directory and can be regenerated without overwriting other targets', { skip: process.platform !== 'win32' }, async () => {
    const root = await temporary('shortcut'), desktop = path.join(root, '桌面 test');
    const launchers = [];
    for (const name of ['Silly Tavern 一', 'Silly Tavern 二']) {
        const directory = path.join(root, name); await fs.mkdir(directory);
        const launcher = path.join(directory, 'Start-TavernSyn.cmd'); await fs.writeFile(launcher, '@echo off\r\nexit /b 0\r\n'); launchers.push(launcher);
    }
    const create = async launcher => JSON.parse((await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(PROJECT, 'bin/create-desktop-shortcut.ps1'), '-LauncherPath', launcher, '-DesktopPath', desktop])).stdout);
    const first = await create(launchers[0]), again = await create(launchers[0]), second = await create(launchers[1]);
    assert.equal(first.shortcutPath, again.shortcutPath); assert.notEqual(first.shortcutPath, second.shortcutPath);
    assert.ok(await exists(first.shortcutPath));
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const code = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(first.shortcutPath)}); @{target=$s.TargetPath;directory=$s.WorkingDirectory;style=$s.WindowStyle}|ConvertTo-Json -Compress`;
    const link = JSON.parse((await run('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')])).stdout);
    assert.equal(link.target, launchers[0]); assert.equal(link.directory, path.dirname(launchers[0])); assert.equal(link.style, 1);
});
