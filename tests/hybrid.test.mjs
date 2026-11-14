import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlan, createBundle, verifyBundle, applyBundle } from '../lib/hybrid.mjs';
import { digest, run } from '../lib/io.mjs';
import { scan, verify } from '../lib/manifest.mjs';
import { temporary } from './fixtures.mjs';

function binding() {
    return { job: randomUUID(), dataset: randomUUID(), generation: randomUUID(), base: null, scope: null };
}

test('Node and Python use identical bundle bytes, frozen bindings, hashes and mtimes', async () => {
    const work = await temporary('hybrid-codec'), source = path.join(work, 'source');
    await fs.mkdir(path.join(source, 'profile'), { recursive: true });
    for (const [name, bytes] of [['文件[一]', Buffer.from('fixture\n')], ['empty', Buffer.alloc(0)]]) {
        const file = path.join(source, 'profile', name);
        await fs.writeFile(file, bytes); await fs.utimes(file, 1700000000, 1700000000);
    }
    const manifest = await scan(source), names = manifest.files.map(file => file.path);
    const identity = binding(), plan = createPlan(identity, manifest, names);
    const nodeBundle = path.join(work, 'node.bundle'), pyBundle = path.join(work, 'python.bundle');
    const pyStage = path.join(work, 'python-stage'), nodeStage = path.join(work, 'node-stage');
    const descriptor = await createBundle(source, nodeBundle, plan, manifest, 0);
    const request = path.join(work, 'request.json');
    await fs.writeFile(request, JSON.stringify({ identity, manifest, names, source, nodeBundle, pyBundle, pyStage, descriptor }));
    const code = [
        'import json, sys', 'sys.path.insert(0, "vps")', 'import hybrid',
        'r = json.load(open(sys.argv[1], encoding="utf-8"))',
        'p = hybrid.create_plan(r["identity"], r["manifest"], r["names"])',
        'd = hybrid.create_bundle(r["source"], r["pyBundle"], p, r["manifest"], 0)',
        'hybrid.apply_bundle(r["nodeBundle"], r["pyStage"], p, r["manifest"], 0, r["descriptor"]["sha256"])',
        'print(json.dumps({"plan": p, "descriptor": d}, ensure_ascii=True))',
    ].join('\n');
    const { stdout } = await run(process.env.PYTHON ?? 'python', ['-B', '-c', code, request]);
    assert.deepEqual(JSON.parse(stdout), { plan, descriptor });
    assert.deepEqual(await fs.readFile(pyBundle), await fs.readFile(nodeBundle));
    await applyBundle(pyBundle, nodeStage, plan, manifest, 0, descriptor.sha256);
    for (const stage of [pyStage, nodeStage]) {
        await verify(stage, manifest);
        assert.deepEqual(await scan(stage), manifest);
    }
    await assert.rejects(verifyBundle(pyBundle, createPlan(binding(), manifest, names), manifest, 0, descriptor.sha256), { code: 'HYBRID' });
    await assert.rejects(verifyBundle(pyBundle, plan, manifest, 0, 'a'.repeat(64)), { code: 'HYBRID' });
    await fs.writeFile(nodeBundle, Buffer.alloc(descriptor.size));
    assert.deepEqual(await createBundle(source, nodeBundle, plan, manifest, 0), descriptor);
    await verifyBundle(nodeBundle, plan, manifest, 0, descriptor.sha256);
    const huge = await fs.open(nodeBundle, 'r+');
    try { await huge.truncate(18 * 1024 * 1024); } finally { await huge.close(); }
    await assert.rejects(verifyBundle(nodeBundle, plan, manifest, 0, descriptor.sha256), { code: 'HYBRID' });
});

function manifestOf(files) {
    const records = files.map(({ path, size }) => ({ path, size, sha256: 'a'.repeat(64) }));
    return { format: 1, bytes: records.reduce((sum, file) => sum + file.size, 0),
        digest: digest(records), files: records.map(file => ({ ...file, mtime: 1700000000 })) };
}

test('Node and Python follow exact size and count limits and Node rejects unsafe or repeated paths', async () => {
    const smallLimit = 3 * 1024 * 1024;
    const files = [
        ...Array.from({ length: 5 }, (_, i) => ({ path: `profile/a${i}`, size: smallLimit })),
        { path: 'profile/a5', size: 1024 * 1024 },
        { path: 'profile/a6', size: 1 },
        ...Array.from({ length: 2001 }, (_, i) => ({ path: `profile/b${String(i).padStart(4, '0')}`, size: 0 })),
        { path: 'profile/large', size: smallLimit + 1 },
        { path: 'profile/unchanged', size: 1 },
    ];
    const manifest = manifestOf(files), changed = files.slice(0, -1).map(file => file.path);
    const identity = binding(), plan = createPlan(identity, manifest, changed);
    assert.deepEqual(plan.groups.map(group => group.length), [6, 2000, 2]);
    assert.deepEqual(plan.groups[0].map(file => file.path), files.slice(0, 6).map(file => file.path));
    assert.deepEqual(plan.large, ['profile/large']);
    assert.ok(!plan.groups.flat().some(file => file.path === 'profile/unchanged'));
    assert.throws(() => createPlan(binding(), manifest, [...changed, changed[0]]));
    for (const unsafe of ['../escape', 'profile/../escape', 'profile/.tavernsyn-partial/x', '/absolute', 'profile/CON.txt']) {
        assert.throws(() => createPlan(binding(), manifestOf([{ path: unsafe, size: 0 }]), [unsafe]), unsafe);
    }
    const code = [
        'import json, sys', 'sys.path.insert(0, "vps")', 'import hybrid',
        'print(json.dumps(hybrid.create_plan(*json.load(sys.stdin))))',
    ].join('\n');
    const { stdout } = await run(process.env.PYTHON ?? 'python', ['-B', '-c', code], {
        input: JSON.stringify([identity, manifest, changed]),
    });
    assert.deepEqual(JSON.parse(stdout), plan);
});
