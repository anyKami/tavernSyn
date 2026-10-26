// Substitute only SSH with a process pipe; use the real rsync daemon and client.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.env.TAVERNSYN_FIXTURE_STORE, binary = process.env.TAVERNSYN_FIXTURE_RSYNC;
const job = JSON.parse(await fs.readFile(path.join(root, 'private/active.json'), 'utf8'));
const posix = file => process.platform === 'win32' ? execFileSync(path.join(path.dirname(binary), 'cygpath.exe'), ['-u', file], { windowsHide: true }).toString().trim() : file;
const config = path.join(root, 'private', `fixture-${process.pid}.conf`);
await fs.writeFile(config, ['use chroot = no', 'log file = /dev/null', `lock file = ${posix(path.join(root, 'private/fixture.lock'))}`, '[payload]',
    `path = ${posix(job.payload)}`, 'list = false', `read only = ${job.direction === 'pull'}`, `write only = ${job.direction === 'push'}`,
    'incoming chmod = Du+rwx,Fu+rw', 'refuse options = links copy-links copy-dirlinks keep-dirlinks hard-links devices specials owner group perms chmod inplace append append-verify backup backup-dir relative copy-dest link-dest', ''].join('\n'));
// Keep the daemon's binary pipes inside MSYS/POSIX. The shell consumes only this
// configuration filename before exec, rather than routing rsync bytes via Node.
console.log(posix(config));
