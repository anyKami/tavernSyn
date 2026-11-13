import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Control, createUploadRecovery, finalizeUpload } from '../helper/transport.mjs';
import { createPlan } from '../lib/hybrid.mjs';
import { temporary } from './fixtures.mjs';
import { digest, SyncError } from '../lib/io.mjs';
import { progressDetail } from '../ui/progress.js';

const manifest = { format: 1, files: [], bytes: 0, digest: digest([]) };
const stats = { sentBytes: 31006460, receivedBytes: 183831, literalBytes: 37960996, matchedBytes: 87200857, transferredFiles: 215 };
function fixture({ failAt = 'hybrid-plan', resumePhase = 'transfer', resumed = {}, alwaysFail = false, busy = 0, loseBusyConnection = false } = {}) {
    const job = randomUUID(), dataset = randomUUID(), events = [], logs = [], waits = [];
    const base = 'a'.repeat(64);
    const plan = createPlan({ job, dataset, generation: job, base, scope: null }, manifest, []);
    const response = op => op === 'hybrid-plan' ? { plan } : { digest: manifest.digest, generation: job };
    let failed = false, reconnects = 0, now = 0;
    const session = { hello: { dataset, current: { digest: base } }, env: { jobBound: true }, log: line => logs.push(line),
        control: { async request(op) {
            events.push(op);
            if (alwaysFail || (!failed && op === failAt)) { failed = true; throw new SyncError('SSH', 'synthetic disconnected control'); }
            return response(op);
        } },
        async reconnect() {
            reconnects++; events.push('reconnect');
            session.control = { async request(op, fields) {
                events.push(op);
                if (op === 'begin') {
                    assert.deepEqual(fields, { job, dataset, direction: 'push', base, jobBound: true, resumeOnly: true });
                    if (loseBusyConnection && reconnects === 1 && waits.includes(2000)) throw new SyncError('SSH', 'connection lost while BUSY');
                    if (busy-- > 0) throw new SyncError('BUSY', 'old session is still draining');
                    return { job, direction: 'push', generation: job, base, phase: resumePhase, ...resumed };
                }
                if (alwaysFail) throw new SyncError('SSH', 'still disconnected');
                return response(op);
            } };
        },
    };
    const device = { remote: { dataset } };
    const recovery = createUploadRecovery(session, device, job, { base, phase: 'transfer' }, {
        now: () => now, wait: async ms => { waits.push(ms); now += ms; },
    });
    return { session, job, device, events, logs, waits, recovery, reconnects: () => reconnects };
}

const finalize = async f => finalizeUpload(f.session, f.device, f.job, (await temporary('hybrid-upload-reconnect')) + '/payload', manifest, stats, undefined, undefined, { recovery: f.recovery });
const disconnected = () => Object.assign(new SyncError('PROCESS_FAILED', 'synthetic interrupted rsync'), { exitCode: 12, signal: null });

test('a dead upload control reconnects only to the retained task and keeps the original transfer statistics', async () => {
    const f = fixture();
    const result = await finalize(f);
    assert.equal(result.digest, manifest.digest);
    assert.deepEqual(result.stats, { ...stats, reconnects: 1, interruptedTransfers: 0 });
    assert.deepEqual(f.events, ['hybrid-plan', 'reconnect', 'begin', 'hybrid-plan', 'hybrid-descriptors', 'hybrid-apply', 'commit']);
    assert.equal(f.reconnects(), 1);
});

test('lost commit acknowledgement recovers a completed publication without another inspect or transfer', async () => {
    const f = fixture({ failAt: 'commit', resumePhase: 'done' });
    assert.equal((await finalize(f)).digest, manifest.digest);
    assert.deepEqual(f.events, ['hybrid-plan', 'hybrid-descriptors', 'hybrid-apply', 'commit', 'reconnect', 'begin', 'commit']);
});

test('finalizing publication recovery retries commit and a brief old-session lock is bounded', async () => {
    const f = fixture({ failAt: 'commit', resumePhase: 'finalizing', busy: 1 });
    assert.equal((await finalize(f)).digest, manifest.digest);
    assert.deepEqual(f.events, ['hybrid-plan', 'hybrid-descriptors', 'hybrid-apply', 'commit', 'reconnect', 'begin', 'begin', 'commit']);
});

test('a different task, generation, base or phase cannot be claimed after reconnect', async () => {
    for (const resumed of [{ job: randomUUID() }, { direction: 'pull' }, { generation: randomUUID() }, { base: 'b'.repeat(64) }, { phase: 'paused' }]) {
        const f = fixture({ resumed });
        await assert.rejects(finalize(f), { code: 'REMOTE_PROTOCOL' });
        assert.ok(!f.events.includes('commit'));
    }
});

test('permission and integrity errors never trigger automatic reconnect or publishing', async () => {
    for (const code of ['PERMISSION', 'REMOTE_CHANGED', 'INTEGRITY', 'REMOTE_PROTOCOL']) {
        const f = fixture(); f.session.control.request = async () => { throw new SyncError(code, 'synthetic refusal'); };
        await assert.rejects(finalize(f), { code });
        assert.equal(f.reconnects(), 0);
    }
});

test('control reconnection stops after five attempts and never declares success while still disconnected', async () => {
    const f = fixture({ alwaysFail: true });
    await assert.rejects(finalize(f), { code: 'SSH' });
    assert.equal(f.reconnects(), 5); assert.ok(!f.events.includes('commit'));
    assert.match(f.logs.at(-1), /5\/5|已恢复同一上传任务/);
});

test('failed reconnects share the five-attempt budget and the fifth attempt can still succeed', async () => {
    const f = fixture(), reconnect = f.session.reconnect;
    let attempts = 0;
    f.session.reconnect = async () => {
        if (++attempts < 5) throw new SyncError('SSH_TIMEOUT', 'synthetic failed reconnect');
        await reconnect();
    };
    assert.equal((await finalize(f)).digest, manifest.digest);
    assert.equal(attempts, 5); assert.ok(f.logs.some(line => line.includes('5/5')));
});

test('five failed reconnect handshakes stop without publication', async () => {
    const f = fixture(); let attempts = 0;
    f.session.reconnect = async () => { attempts++; throw new SyncError('SSH', 'still offline'); };
    await assert.rejects(finalize(f), { code: 'SSH' });
    assert.equal(attempts, 5); assert.ok(!f.events.includes('commit'));
});

test('a disconnect while reclaiming the retained job also consumes the same reconnect budget', async () => {
    const f = fixture(), reconnect = f.session.reconnect;
    f.session.reconnect = async () => {
        await reconnect();
        f.session.control.request = async op => { f.events.push(op); throw new SyncError('SSH', 'lost resume acknowledgement'); };
    };
    await assert.rejects(finalize(f), { code: 'SSH' });
    assert.equal(f.reconnects(), 5); assert.ok(!f.events.includes('commit'));
});

for (const seconds of [60, 120]) {
    test(`upload resumes after ${seconds} seconds of BUSY on the same connection`, async () => {
        const f = fixture({ busy: seconds / 2 });
        assert.equal((await finalize(f)).digest, manifest.digest);
        assert.equal(f.reconnects(), 1);
        assert.deepEqual(f.waits, [1000, ...Array(seconds / 2).fill(2000)]);
    });
}

for (const loseBusyConnection of [false, true]) {
    test(`upload lock wait stops after 150 seconds${loseBusyConnection ? ' across two connections' : ''}`, async () => {
        const f = fixture({ busy: 100, loseBusyConnection });
        await assert.rejects(finalize(f), { code: 'BUSY' });
        assert.equal(f.reconnects(), loseBusyConnection ? 2 : 1);
        assert.deepEqual(f.waits, [1000, ...Array(loseBusyConnection ? 76 : 75).fill(2000)]);
        assert.ok(!f.events.includes('commit'));
    });
}

test('initial upload, correction and control share a five-reconnect budget', async () => {
    const f = fixture();
    for (const failures of [2, 2]) {
        let attempts = 0;
        await f.recovery.run(async () => {
            if (++attempts <= failures) throw disconnected();
        }, true);
    }
    assert.equal(f.recovery.stats(stats).interruptedTransfers, 4);
    assert.equal(f.recovery.stats(stats).incompleteNetworkStats, true);
    await assert.rejects(f.recovery.run(async () => {
        throw new SyncError('SSH', 'connection reset');
    }), { code: 'SSH' });
    assert.equal(f.reconnects(), 5);
    assert.deepEqual(f.waits, [1000, 2000, 4000, 8000, 10000]);
});

test('upload cancellation during rsync does not resume a job', async () => {
    const f = fixture();
    await assert.rejects(f.recovery.run(async () => {
        f.session.control.intentional = true;
        throw disconnected();
    }, true), { code: 'PROCESS_FAILED' });
    assert.equal(f.reconnects(), 0);
});

test('an idle control exit is logged immediately with its exit code even without pending requests', () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    const logs = [], control = new Control(child, line => logs.push(line));
    child.emit('exit', 255, null); child.emit('close', 255, null);
    assert.equal(control.closed, true); assert.equal(logs.length, 1); assert.match(logs[0], /退出码 255/);
});

test('logical rsync progress is not presented as a percentage of actual transfer bytes', () => {
    const text = progressDetail({ phase: 'UPLOADING', direction: 'push', progress: { logicalBytes: 125161853, percent: 25 } });
    assert.match(text, /含复用部分/); assert.doesNotMatch(text, /25%/);
    const failed = progressDetail({ phase: 'FAILED', direction: 'push', progress: { stage: 'transferred', stats }, stats });
    assert.match(failed, /文件传输已结束/); assert.match(failed, /同步尚未完成/); assert.match(failed, /29\.57 MiB/);
    assert.doesNotMatch(failed, /中断尝试流量/);
    const reconnected = progressDetail({ phase: 'SUCCEEDED', direction: 'push', stats: { ...stats, incompleteNetworkStats: true } });
    assert.equal(reconnected.match(/未包含部分中断尝试流量/g)?.length, 1);
});
