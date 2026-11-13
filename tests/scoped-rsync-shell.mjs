// Substitute only SSH with a process pipe; use the real rsync daemon and client.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = process.env.TAVERNSYN_FIXTURE_STORE, binary = process.env.TAVERNSYN_FIXTURE_RSYNC;
const args = process.argv.slice(2).join(' ').split(/\s+/);
const command = args.indexOf('tavernsyn-rsync-v3');
assert.ok(command >= 0, args.join(' '));
const [device, id, module] = args.slice(command + 1);
assert.ok(['wire', 'payload'].includes(module));
const posix = file => process.platform === 'win32' ? execFileSync(path.join(path.dirname(binary), 'cygpath.exe'), ['-u', file], { windowsHide: true }).toString().trim() : file;
const marker = process.env.TAVERNSYN_FIXTURE_CUT;
let cut = false;
if (marker) {
    try { await fs.unlink(marker); cut = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const config = path.join(root, 'private', `fixture-${process.pid}.conf${cut ? '.cut' : ''}`);
execFileSync(process.env.PYTHON ?? 'python', ['-B', fileURLToPath(new URL('./scoped-store-fixture.py', import.meta.url)),
    '--rsync-config', root, device, id, module, config], { windowsHide: true });
if (process.platform === 'win32') {
    const contents = await fs.readFile(config, 'utf8');
    await fs.writeFile(config, contents.replace(/^(path|lock file) = (.+)$/gm, (_, key, value) => `${key} = ${posix(value)}`));
}
// Keep the daemon's binary pipes inside MSYS/POSIX. The shell consumes only this
// configuration filename before exec, rather than routing rsync bytes via Node.
console.log(posix(config));
