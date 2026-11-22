import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { packSnapshotObjects, unpackSnapshotObjects } from '../lib/git-objects.mjs';
import { exists, run } from '../lib/io.mjs';

async function fixture(t, { binary = false } = {}) {
    const parent = fileURLToPath(new URL('../.tmp/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'git-objects-')), source = path.join(root, 'source');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const template = path.join(root, 'empty-template'); await fs.mkdir(template);
    const initialize = directory => run('git', ['init', '--quiet', '--initial-branch=main', `--template=${template}`, directory]);
    await initialize(source);
    const script = '#!/bin/sh\necho portable\n'; await fs.writeFile(path.join(source, 'run.sh'), script);
    if (binary) await fs.writeFile(path.join(source, 'binary.dat'), randomBytes(256 * 1024));
    await run('git', ['-C', source, 'add', '.']);
    await run('git', ['-C', source, 'update-index', '--chmod=+x', 'run.sh']);
    await run('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'portable pack fixture']);
    const commit = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    async function packed(id) {
        const repository = path.join(root, `repository-${id}`); await initialize(repository);
        await packSnapshotObjects(source, repository, commit);
        return { repository, file: path.join(repository, '.git/objects/pack/snapshot.pack'),
            retained: path.join(root, `repository-packs-${id}`), id };
    }
    return { root, source, commit, script, packed };
}

test('tiny valid Git packs retain executable content across repeated fast unpack process exits', async t => {
    const f = await fixture(t);
    for (let i = 0; i < 16; i++) {
        const p = await f.packed(i);
        assert.ok((await fs.stat(p.file)).size < 2048, 'tiny packs let git finish immediately after reading their checksum');
        await unpackSnapshotObjects(p.repository, f.root, p.id);
        assert.equal((await run('git', ['-C', p.repository, 'cat-file', '-t', f.commit])).stdout.trim(), 'commit');
        assert.equal((await run('git', ['-C', p.repository, 'show', `${f.commit}:run.sh`])).stdout, f.script);
        assert.match((await run('git', ['-C', p.repository, 'ls-tree', f.commit])).stdout, /^100755 blob [a-f0-9]+\trun\.sh/m);
        assert.deepEqual(await fs.readdir(path.join(p.repository, '.git/objects/pack')), []);
        assert.equal(await exists(p.retained), false);
    }
});

test('a larger binary pack is fully unpacked and verified by Git', async t => {
    const f = await fixture(t, { binary: true }), p = await f.packed('binary');
    assert.ok((await fs.stat(p.file)).size > 256 * 1024);
    await unpackSnapshotObjects(p.repository, f.root, p.id);
    await run('git', ['-C', p.repository, 'update-ref', 'HEAD', f.commit]);
    await run('git', ['-C', p.repository, 'fsck', '--full', '--strict']);
    const expected = (await run('git', ['-C', f.source, 'rev-parse', `${f.commit}:binary.dat`])).stdout;
    assert.equal((await run('git', ['-C', p.repository, 'rev-parse', `${f.commit}:binary.dat`])).stdout, expected);
});

for (const damage of ['checksum', 'truncated']) test(`${damage} Git pack fails without discarding its retained input`, async t => {
    const f = await fixture(t), p = await f.packed(damage), data = await fs.readFile(p.file);
    if (damage === 'checksum') data[data.length - 1] ^= 1;
    await fs.writeFile(p.file, damage === 'truncated' ? data.subarray(0, data.length - 8) : data);
    await assert.rejects(unpackSnapshotObjects(p.repository, f.root, p.id), { code: 'PLUGIN_GIT' });
    const retained = path.join(p.retained, 'snapshot.pack');
    assert.equal(await exists(retained), true);
    // This also checks that no parent/child file handle is left open on Windows.
    const moved = `${retained}.checked`; await fs.rename(retained, moved); await fs.unlink(moved);
});

test('failure to spawn Git closes the pack descriptor and preserves recovery input', async t => {
    const f = await fixture(t), p = await f.packed('spawn'), savedPath = process.env.PATH;
    const emptyPath = path.join(f.root, 'missing-bin'); await fs.mkdir(emptyPath);
    try {
        process.env.PATH = emptyPath;
        await assert.rejects(unpackSnapshotObjects(p.repository, f.root, p.id), { code: 'PLUGIN_GIT' });
    } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
    }
    const retained = path.join(p.retained, 'snapshot.pack'), moved = `${retained}.checked`;
    await fs.rename(retained, moved); await fs.unlink(moved);
});
