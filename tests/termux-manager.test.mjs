import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { integrateTermuxManager, loaderSource, managerSource } from '../bin/integrate-termux-manager.mjs';
import { exists, run } from '../lib/io.mjs';
import { PROJECT } from '../lib/device.mjs';
import { temporary } from './fixtures.mjs';

const original = `#!/usr/bin/env bash\n# ClewdR & SillyTavern 管理工具\nstart_service() { echo "legacy:$1"; }\nshow_menu() {\n case "$1" in\n 3) start_service "ClewdR" "$CLEWDR_DIR" "./clewdr" ;;\n 4) start_service "SillyTavern" "$ST_DIR" "node server.js" ;;\n esac\n}\nmain() { show_menu "$@"; }\nmain "$@"\n`;

test('known menus are integrated idempotently while unrelated commands and unknown formats stay intact', () => {
    const patched = managerSource(original, '/home/a/Silly Tavern');
    assert.ok(patched.includes('4) tavernsyn_start_st ;;'));
    assert.ok(patched.includes('3) start_service "ClewdR" "$CLEWDR_DIR" "./clewdr" ;;'));
    assert.equal(managerSource(patched, '/home/a/Silly Tavern'), patched);
    assert.equal(managerSource('unrelated file', '/home/a/ST'), null);
    const legacy = original.replace('start_service "SillyTavern" "$ST_DIR" "node server.js"', 'start_st');
    assert.ok(managerSource(legacy, '/home/a/ST').includes('4) tavernsyn_start_st ;;'));
    const rc = '# unrelated setting\nexport FIXTURE=preserve\ncurl -O https://raw.githubusercontent.com/rzline/st-cr-ins.sh/main/install.sh &&bash install.sh\n';
    const loader = loaderSource(rc); assert.ok(loader.includes('export FIXTURE=preserve')); assert.ok(loader.includes('if [ -f "$HOME/install.sh" ]'));
    assert.equal(loaderSource(loader), loader);
});

test('the installer-integrated real Bash option 4 calls its controlled entry and preserves later shell logins', async context => {
    const root = await temporary('manager'), install = path.join(root, 'Silly Tavern'), manager = path.join(root, 'install.sh');
    const runtime = process.env.TAVERNSYN_TEST_RUNTIME ?? path.join(PROJECT, '.local/msys64');
    const shell = process.platform === 'win32' ? path.join(runtime, 'usr/bin/bash.exe') : 'bash';
    if (process.platform === 'win32' && !await exists(shell)) { context.skip('Bash test runtime unavailable'); return; }
    await fs.mkdir(install); await fs.writeFile(manager, original);
    await fs.writeFile(path.join(root, '.bashrc'), 'export KEEP_FIXTURE=yes\ncurl -O https://raw.githubusercontent.com/rzline/st-cr-ins.sh/main/install.sh &&bash install.sh\n');
    await fs.writeFile(path.join(install, 'start-tavernsyn.sh'), '#!/usr/bin/env bash\necho CONTROLLED_STARTUP_ENTRY\n');
    const integrated = await integrateTermuxManager({ install, home: root, shell, log() {} });
    assert.equal(integrated.status, 'integrated');
    const env = { PATH: path.dirname(shell) + path.delimiter + process.env.PATH };
    const output = await run(shell, [manager, '4'], { env }); assert.ok(output.stdout.includes('CONTROLLED_STARTUP_ENTRY'));
    assert.ok((await run(shell, [manager, '3'], { env })).stdout.includes('legacy:ClewdR'));
    assert.ok((await fs.readFile(path.join(root, '.bashrc'), 'utf8')).includes('export KEEP_FIXTURE=yes'));
    assert.deepEqual((await integrateTermuxManager({ install, home: root, shell, log() {} })).changed, []);
});
