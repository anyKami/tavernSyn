import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROJECT } from '../lib/device.mjs';
import { atomicJson, run } from '../lib/io.mjs';
import { scan, verify, difference } from '../lib/manifest.mjs';
import { RSYNC_ARGS, parseStats } from '../helper/transport.mjs';
import { temporary } from './fixtures.mjs';

const root = await temporary('rsync'), source = path.join(root, '中文 空格 source'), target = path.join(root, 'target');
await fs.mkdir(source); await fs.mkdir(target);
const binary = process.argv[2] ?? (process.platform === 'win32' ? path.join(PROJECT, '.local/msys64/usr/bin/rsync.exe') : 'rsync');
const bin = path.dirname(binary);
const posix = async value => process.platform === 'win32' ? (await run(path.join(bin, 'cygpath.exe'), ['-u', value])).stdout.trim() : value;
const sourcePath = await posix(source) + '/', targetPath = await posix(target) + '/';
const version = (await run(binary, ['--version'])).stdout.split(/\r?\n/)[0], results = [];
async function transfer(args = RSYNC_ARGS) {
    return parseStats((await run(binary, [...args, '--', sourcePath, targetPath], { env: { LC_ALL: 'C' } })).stdout);
}
try {
    const large = randomBytes(2 * 1024 * 1024);
    await fs.writeFile(path.join(source, '大文件.dat'), large); await fs.writeFile(path.join(source, '删除.txt'), 'fixture');
    results.push({ test: 'initial transfer with Chinese/spaced Windows paths', stats: await transfer() });
    await verify(target, await scan(source));
    const unchanged = await transfer(); assert.equal(unchanged.transferredFiles, 0);
    results.push({ test: 'unchanged files transmit no file contents', stats: unchanged });
    const stat = await fs.stat(path.join(source, '大文件.dat'));
    large.fill(88, 1024 * 1024, 1024 * 1024 + 4096); await fs.writeFile(path.join(source, '大文件.dat'), large);
    await fs.utimes(path.join(source, '大文件.dat'), stat.atime, new Date(stat.mtimeMs + 3000));
    const delta = await transfer(); assert.ok(delta.matchedBytes > 1024 * 1024 && delta.literalBytes < large.length / 4);
    results.push({ test: 'large modified file uses block deltas', stats: delta }); await verify(target, await scan(source));
    await fs.unlink(path.join(source, '删除.txt')); await transfer(); await assert.rejects(fs.stat(path.join(target, '删除.txt')));
    results.push({ test: 'deleted source file removed only from isolated stage' });
    const expected = await scan(source), mtime = (await fs.stat(path.join(source, '大文件.dat'))).mtime;
    large.fill(55, 4096, 8192); await fs.writeFile(path.join(target, '大文件.dat'), large); await fs.utimes(path.join(target, '大文件.dat'), mtime, mtime);
    const skipped = await transfer(); assert.equal(skipped.transferredFiles, 0);
    const diff = difference(expected, await scan(target)); assert.deepEqual(diff.changed, ['大文件.dat']);
    const list = path.join(root, 'correction.txt'); await fs.writeFile(list, `${diff.changed.join('\0')}\0`);
    await transfer([...RSYNC_ARGS.filter(a => a !== '--delete-delay'), '--from0', `--files-from=${await posix(list)}`, '--ignore-times']);
    await verify(target, expected); results.push({ test: 'same-size/mtime corruption detected by SHA256 and fixed with targeted rsync' });
    // Exercise the production daemon module options using a process-only remote-shell fixture.
    // This deliberately substitutes a shell for SSH and is not claimed as host-key or Linux flock validation.
    const moduleRoot = path.join(root, 'module'); await fs.mkdir(moduleRoot);
    const config = path.join(root, 'rsyncd.conf'), shell = path.join(root, 'rsh.sh');
    await fs.writeFile(config, ['use chroot = no', 'log file = /dev/null', `lock file = ${await posix(path.join(root, 'rsync.lock'))}`, '[payload]', `path = ${await posix(moduleRoot)}`, 'list = false', 'read only = false', 'write only = true', 'refuse options = links copy-links copy-dirlinks keep-dirlinks hard-links devices specials owner group perms chmod inplace append append-verify backup backup-dir relative copy-dest link-dest', ''].join('\n'));
    const q = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(shell, `#!/bin/sh\nexec ${q(await posix(binary))} --server --daemon --config=${q(await posix(config))} .\n`);
    const rsh = process.platform === 'win32' ? `"${await posix(path.join(bin, 'bash.exe'))}" "${await posix(shell)}"` : `sh "${shell}"`;
    const daemonUpload = parseStats((await run(binary, [...RSYNC_ARGS, `--rsh=${rsh}`, '--', sourcePath, 'fixture::payload/'], { env: { LC_ALL: 'C', RSYNC_PROTECT_ARGS: '0' } })).stdout);
    await verify(moduleRoot, expected); results.push({ test: 'real rsync daemon-over-process upload accepts production option allowlist', stats: daemonUpload });
    const text = await fs.readFile(config, 'utf8'); await fs.writeFile(config, text.replace('read only = false', 'read only = true').replace('write only = true', 'write only = false'));
    await fs.writeFile(path.join(target, 'extra.txt'), 'must be deleted from local stage');
    const daemonDownload = parseStats((await run(binary, [...RSYNC_ARGS, `--rsh=${rsh}`, '--', 'fixture::payload/', targetPath], { env: { LC_ALL: 'C', RSYNC_PROTECT_ARGS: '0' } })).stdout);
    await verify(target, expected); results.push({ test: 'real read-only daemon download mirrors local stage', stats: daemonDownload });
    await assert.rejects(run(binary, [...RSYNC_ARGS, `--rsh=${rsh}`, '--', sourcePath, 'fixture::payload/'], { env: { LC_ALL: 'C' } }));
    await verify(moduleRoot, expected); results.push({ test: 'read-only published module refuses uploads and remains intact' });
    const report = { status: 'passed', date: new Date().toISOString(), platform: process.platform, version, root, results,
        untested: ['SSH host-key authentication', 'Tailscale transfer', 'Real Linux dispatcher/flock', 'Android'] };
    await atomicJson(path.join(PROJECT, 'docs/test-results/rsync-windows.json'), { ...report, root: '<isolated-test-directory>',
        publicationPrivacy: 'Temporary test path anonymized; no real user data or credentials are recorded.' });
    console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error.stack); await atomicJson(path.join(root, 'failure.json'), { error: error.message, results }); process.exitCode = 1; }
