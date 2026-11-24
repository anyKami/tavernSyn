import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkCompatibility } from '../adapters/release-1.19.mjs';
import { snapshot } from '../lib/snapshot.mjs';
import { ST, fixture, temporary } from './fixtures.mjs';
const guarded = ['src/server-main.js', 'src/server-startup.js', 'src/plugin-loader.js', 'src/users.js', 'src/middleware/userCss.js', 'src/middleware/webpack-serve.js', 'public/scripts/st-context.js'];
async function compatibleFixture(t) {
    const root = await temporary('compatibility');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const file of guarded) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.copyFile(path.join(ST, file), path.join(root, file));
    }
    return root;
}
test('compatibility depends on guarded sources, not package version or its presence', async t => {
    const root = await compatibleFixture(t);
    for (const version of ['1.19.0', '1.19.1', '99.0.0-test']) {
        await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
        await checkCompatibility(root);
    }
    await fs.unlink(path.join(root, 'package.json'));
    await checkCompatibility(root);
});
test('all seven guarded files still reject modifications and absence', async t => {
    const root = await compatibleFixture(t);
    for (const file of guarded) {
        const target = path.join(root, file), original = await fs.readFile(target);
        await fs.appendFile(target, '\n// synthetic fingerprint mismatch\n');
        await assert.rejects(checkCompatibility(root), { code: 'UNSUPPORTED_VERSION', message: `酒馆生命周期源码与已验证版本不同（${file}），已停用自动替换。` });
        await fs.unlink(target);
        await assert.rejects(checkCompatibility(root), { code: 'ENOENT' });
        await fs.writeFile(target, original);
    }
    await checkCompatibility(root);
});
test('CRLF normalization remains supported', async t => {
    const root = await compatibleFixture(t);
    for (const file of guarded) {
        const target = path.join(root, file);
        await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    }
    await checkCompatibility(root);
});
test('snapshot sourceVersion reports actual version or unknown without a version gate', async t => {
    const device = await fixture();
    t.after(() => fs.rm(device.root, { recursive: true, force: true }));
    for (const [name, content, expected] of [
        ['actual', '{"version":"1.19.1"}', '1.19.1'],
        ['future', '{"version":"99.0.0-test"}', '99.0.0-test'],
        ['empty', '{"version":""}', 'unknown'],
        ['invalid', 'invalid-json', 'unknown'],
        ['missing', null, 'unknown'],
    ]) {
        const pkg = path.join(device.install, 'package.json');
        if (content === null) await fs.rm(pkg, { force: true }); else await fs.writeFile(pkg, content);
        const payload = path.join(device.root, name);
        await snapshot(device, payload, { captureGit: false, scope: ['worlds'] });
        assert.equal(JSON.parse(await fs.readFile(path.join(payload, 'environment.json'), 'utf8')).sourceVersion, expected);
    }
});
