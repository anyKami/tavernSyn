import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDownloadRecovery, permanentTransportFailure, retryableDownloadError } from '../helper/download-reconnect.mjs';
import { Control } from '../helper/transport.mjs';
import { run, SyncError } from '../lib/io.mjs';
import { seal } from '../lib/manifest.mjs';

const disconnected = () => Object.assign(new SyncError('PROCESS_FAILED', 'synthetic interrupted rsync'), { exitCode: 12, signal: null });
function fixture({ scope = null, resumed = {}, handshakeFailures = 0, busy = 0, loseBusyConnection = false } = {}) {
    const job = randomUUID(), dataset = randomUUID(), generation = randomUUID();
    const manifest = seal([]), events = [], logs = [], waits = [];
    const begun = { job, direction: 'pull', generation, phase: 'transfer', base: manifest.digest, manifest,
        ...(scope ? { scope, environment: '{}', publicationDigest: 'a'.repeat(64) } : {}) };
    let reconnects = 0, now = 0;
    const session = { hello: { dataset }, env: { jobBound: true, remote: { dataset }, connection: 0 },
        control: { closed: false }, log: line => logs.push(line), async reconnect() {
            reconnects++; events.push('reconnect');
            if (reconnects <= handshakeFailures) throw new SyncError('SSH_TIMEOUT', 'synthetic reconnect timeout');
            session.env = { ...session.env, connection: reconnects };
            session.control = { closed: false, async request(op, fields) {
                events.push(op);
                assert.equal(op, 'begin');
                assert.deepEqual(fields, { job, dataset, direction: 'pull', jobBound: true, resumeOnly: true, ...(scope ? { scope } : {}) });
                if (loseBusyConnection && reconnects === 1 && waits.includes(2000)) throw new SyncError('SSH', 'connection lost while BUSY');
                if (busy-- > 0) throw new SyncError('BUSY', 'previous transfer is releasing');
                return { ...structuredClone(begun), ...resumed };
            } };
        } };
    const recovery = createDownloadRecovery(session, { remote: { dataset } }, job, begun,
        { scope, now: () => now, wait: async ms => { waits.push(ms); now += ms; } });
    return { session, recovery, begun, events, logs, waits, reconnects: () => reconnects };
}

for (const scope of [null, ['chats']]) {
    test(`${scope ? 'scoped' : 'full'} download resumes the same snapshot and keeps partial files`, async t => {
        const f = fixture({ scope }), root = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernsyn-download-retry-'));
        t.after(async () => {
            assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
            assert.ok(path.basename(root).startsWith('tavernsyn-download-retry-'));
            await fs.rm(root, { recursive: true, force: true });
        });
        const partial = path.join(root, 'partial'), completed = path.join(root, 'completed');
        await fs.writeFile(partial, 'partial bytes'); await fs.writeFile(completed, 'already downloaded');
        let transfers = 0;
        const stats = await f.recovery.run(async () => {
            transfers++;
            assert.equal(await fs.readFile(partial, 'utf8'), 'partial bytes');
            assert.equal(await fs.readFile(completed, 'utf8'), 'already downloaded');
            if (transfers === 1) throw disconnected();
            assert.equal(f.session.env.connection, 1, 'retry uses the refreshed session environment');
            return { sentBytes: 12, receivedBytes: 34 };
        });
        assert.equal(transfers, 2); assert.deepEqual(f.events, ['reconnect', 'begin']);
        const recorded = f.recovery.stats(stats);
        assert.equal(recorded.reconnects, 1); assert.equal(recorded.interruptedTransfers, 1);
        assert.equal(recorded.incompleteNetworkStats, true); assert.equal(recorded.receivedBytes, 34);
        assert.match(recorded.note, /中断传输/); assert.ok(f.logs.some(line => line.includes('1/5')));
    });
}

test('a closed idle control is reconnected before another rsync process is launched', async () => {
    const f = fixture(); f.session.control.closed = true;
    let transfers = 0;
    const result = await f.recovery.run(async () => { transfers++; return { receivedBytes: 8 }; });
    assert.equal(transfers, 1); assert.equal(f.reconnects(), 1);
    assert.equal(f.recovery.stats(result).interruptedTransfers, 0);
});

test('an intentionally closed control never reconnects or relaunches rsync', async () => {
    for (const exited of [true, false]) {
        const f = fixture(); f.session.control.closed = exited; f.session.control.intentional = true;
        await assert.rejects(f.recovery.run(async () => { assert.fail('explicit stop must not transfer'); }), { code: 'SSH', transportRetryable: false });
        assert.equal(f.reconnects(), 0);
    }
});

test('closing the control during a failed transfer cancels automatic recovery', async () => {
    const f = fixture();
    await assert.rejects(f.recovery.run(async () => { f.session.control.intentional = true; throw disconnected(); }), { code: 'PROCESS_FAILED' });
    assert.equal(f.reconnects(), 0);
});

test('normal download and corrective transfer share one five-reconnect budget', async () => {
    const f = fixture(); let first = true;
    await f.recovery.run(async () => { if (first) { first = false; throw disconnected(); } return {}; });
    let corrections = 0;
    await assert.rejects(f.recovery.run(async () => { corrections++; throw disconnected(); }), { code: 'PROCESS_FAILED', exitCode: 12 });
    assert.equal(f.reconnects(), 5); assert.equal(corrections, 5);
});

test('five failed handshakes stop and never restart the transfer against an unverified source', async () => {
    const f = fixture({ handshakeFailures: 99 }); let transfers = 0;
    await assert.rejects(f.recovery.run(async () => { transfers++; throw disconnected(); }), { code: 'SSH_TIMEOUT' });
    assert.equal(f.reconnects(), 5); assert.equal(transfers, 1);
    assert.deepEqual(f.waits, [1000, 2000, 4000, 8000, 10000]);
    assert.ok(f.logs.some(line => line.includes('5/5')));
});

test('the fifth reconnect may succeed after four handshake failures', async () => {
    const f = fixture({ handshakeFailures: 4 }); let first = true;
    const result = await f.recovery.run(async () => { if (first) { first = false; throw disconnected(); } return 'downloaded'; });
    assert.equal(result, 'downloaded'); assert.equal(f.reconnects(), 5);
});

test('download waits at most 150 seconds on one connection while the old rsync holds its lock', async () => {
    const f = fixture({ busy: 99 }); let transfers = 0;
    await assert.rejects(f.recovery.run(async () => { transfers++; throw disconnected(); }), { code: 'BUSY' });
    assert.equal(f.reconnects(), 1); assert.equal(transfers, 1);
    assert.deepEqual(f.waits, [1000, ...Array(75).fill(2000)]);
});

for (const seconds of [60, 120]) {
    test(`download resumes after ${seconds} seconds of BUSY without using more network retries`, async () => {
        const f = fixture({ busy: seconds / 2 }); let first = true;
        assert.equal(await f.recovery.run(async () => { if (first) { first = false; throw disconnected(); } return true; }), true);
        assert.equal(f.reconnects(), 1);
        assert.deepEqual(f.waits, [1000, ...Array(seconds / 2).fill(2000)]);
    });
}

test('network failure while waiting for a download lock retains the elapsed BUSY budget', async () => {
    const f = fixture({ busy: 99, loseBusyConnection: true });
    await assert.rejects(f.recovery.run(async () => { throw disconnected(); }), { code: 'BUSY' });
    assert.equal(f.reconnects(), 2);
    assert.deepEqual(f.waits, [1000, 2000, 2000, ...Array(74).fill(2000)]);
});

test('changed task, direction, generation, base, scope and phase stop before retransmission', async () => {
    for (const resumed of [{ job: randomUUID() }, { direction: 'push' }, { generation: randomUUID() }, { base: 'b'.repeat(64) },
        { scope: ['worlds'] }, { phase: 'paused' }, { phase: 'done' }]) {
        const f = fixture({ resumed }); let transfers = 0;
        await assert.rejects(f.recovery.run(async () => { transfers++; throw disconnected(); }), { code: 'REMOTE_PROTOCOL' });
        assert.equal(f.reconnects(), 1); assert.equal(transfers, 1);
    }
});

test('a valid but different manifest and altered scoped metadata cannot replace the pinned source', async () => {
    const other = seal([{ path: 'profile/chats/a.jsonl', size: 1, mtime: 1, sha256: 'b'.repeat(64) }]);
    for (const [scope, resumed] of [[null, { manifest: other }], [['chats'], { publicationDigest: 'b'.repeat(64) }], [['chats'], { environment: '{"changed":true}' }]]) {
        const f = fixture({ scope, resumed }); let transfers = 0;
        await assert.rejects(f.recovery.run(async () => { transfers++; throw disconnected(); }), { code: 'REMOTE_PROTOCOL' });
        assert.equal(transfers, 1); assert.equal(f.reconnects(), 1);
    }
});

test('malformed manifests are fatal rather than retried', async () => {
    const f = fixture({ resumed: { manifest: { format: 1, files: [], bytes: 0, digest: 'b'.repeat(64) } } });
    await assert.rejects(f.recovery.run(async () => { throw disconnected(); }), { code: 'MANIFEST' });
    assert.equal(f.reconnects(), 1);
});

test('reconnect accepts manifest keys in another order but rejects a changed file mtime', async () => {
    const manifest = seal([{ path: 'profile/chats/a.jsonl', size: 1, mtime: 1, sha256: 'a'.repeat(64) }]);
    for (const changed of [false, true]) {
        const f = fixture();
        f.begun.manifest = manifest;
        const reordered = { digest: manifest.digest, bytes: manifest.bytes, files: [
            { mtime: changed ? 2 : 1, sha256: 'a'.repeat(64), size: 1, path: 'profile/chats/a.jsonl' },
        ], format: 1 };
        f.session.reconnect = async () => { f.session.control.request = async () => ({ ...f.begun, manifest: reordered }); };
        const recovery = createDownloadRecovery(f.session, { remote: { dataset: f.session.hello.dataset } }, f.begun.job, f.begun, { wait: async () => {} });
        let calls = 0;
        const run = recovery.run(async () => {
            if (++calls === 1) throw disconnected();
            return 'transferred';
        });
        if (changed) await assert.rejects(run, { code: 'REMOTE_PROTOCOL' });
        else assert.equal(await run, 'transferred');
        assert.equal(calls, changed ? 1 : 2);
    }
});

test('the initial download receipt must already name the requested task, direction and scope', () => {
    for (const changed of [{ job: randomUUID() }, { direction: 'push' }, { phase: 'paused' }, { scope: ['worlds'] }]) {
        const f = fixture();
        assert.throws(() => createDownloadRecovery(f.session, { remote: { dataset: f.session.hello.dataset } }, f.begun.job,
            { ...f.begun, ...changed }), { code: 'REMOTE_PROTOCOL' });
    }
});

test('a changed dataset or lost job-binding capability stops before resume', async () => {
    for (const changed of ['dataset', 'capability']) {
        const f = fixture(), reconnect = f.session.reconnect;
        f.session.reconnect = async () => {
            await reconnect();
            if (changed === 'dataset') f.session.env.remote.dataset = randomUUID();
            else f.session.env.jobBound = false;
        };
        await assert.rejects(f.recovery.run(async () => { throw disconnected(); }), { code: 'REMOTE_PROTOCOL' });
        assert.deepEqual(f.events, ['reconnect']);
    }
});

test('permission, integrity, cancellation, local I/O and explicit identity failures do not reconnect', async () => {
    const failures = ['PERMISSION', 'INTEGRITY', 'REMOTE_PROTOCOL', 'REMOTE_CHANGED', 'CANCELLED', 'DEPENDENCY', 'REMOTE'].map(code => new SyncError(code, code));
    failures.push(Object.assign(disconnected(), { exitCode: 23 }), Object.assign(disconnected(), { exitCode: 11 }),
        Object.assign(disconnected(), { signal: 'SIGTERM' }), Object.assign(new SyncError('SSH', 'host identity rejected'), { transportRetryable: false }));
    for (const error of failures) {
        const f = fixture();
        await assert.rejects(f.recovery.run(async () => { throw error; }), value => value === error);
        assert.equal(f.reconnects(), 0);
    }
});

test('retained-job refusal after reconnect is final and never creates a replacement job', async () => {
    const f = fixture(), reconnect = f.session.reconnect;
    f.session.reconnect = async () => { await reconnect(); f.session.control.request = async () => { throw new SyncError('REMOTE', 'NO_JOB'); }; };
    await assert.rejects(f.recovery.run(async () => { throw disconnected(); }), { code: 'REMOTE' });
    assert.equal(f.reconnects(), 1);
});

test('run exposes the exit code used to classify actual subprocess failures', async () => {
    await assert.rejects(run(process.execPath, ['-e', 'process.exitCode=12']), { code: 'PROCESS_FAILED', exitCode: 12, signal: null });
    for (const exitCode of [10, 12, 30, 35, 255]) assert.equal(retryableDownloadError(Object.assign(disconnected(), { exitCode })), true);
});

test('SSH authentication and host-key failures are explicitly non-retryable', async () => {
    for (const diagnostic of ['Permission denied (password).', 'Host key verification failed.', 'REMOTE HOST IDENTIFICATION HAS CHANGED!']) {
        assert.equal(permanentTransportFailure(diagnostic), true);
        const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
        const control = new Control(child);
        const rejected = assert.rejects(control.request('hello'), { code: 'SSH', transportRetryable: false });
        child.stderr.write(diagnostic); child.emit('exit', 255, null); child.emit('close', 255, null);
        await rejected;
    }
    assert.equal(permanentTransportFailure('Connection reset by peer'), false);
    assert.equal(permanentTransportFailure('>f+++++++++ profile/chats/Permission denied.jsonl\nrsync error: connection reset'), false);
});
