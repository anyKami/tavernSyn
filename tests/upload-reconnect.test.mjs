import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Control, finalizeUpload } from '../helper/transport.mjs';
import { digest, SyncError } from '../lib/io.mjs';
import { progressDetail } from '../ui/progress.js';

const manifest = { format: 1, files: [], bytes: 0, digest: digest([]) };
const stats = { sentBytes: 31006460, receivedBytes: 183831, literalBytes: 37960996, matchedBytes: 87200857, transferredFiles: 215 };
function fixture({ failAt = 'inspect', resumePhase = 'transfer', resumed = {}, alwaysFail = false, busyOnce = false } = {}) {
    const job = randomUUID(), dataset = randomUUID(), events = [], logs = [];
    const base = 'a'.repeat(64);
    let failed = false, reconnects = 0, busy = busyOnce;
    const session = { hello: { dataset, current: { digest: base } }, env: { jobBound: true }, log: line => logs.push(line),
        control: { async request(op) {
            events.push(op);
            if (alwaysFail || (!failed && op === failAt)) { failed = true; throw new SyncError('SSH', 'synthetic disconnected control'); }
            return op === 'inspect' ? { changed: [], extra: [] } : { digest: manifest.digest, generation: job };
        } },
        async reconnect() {
            reconnects++; events.push('reconnect');
            session.control = { async request(op, fields) {
                events.push(op);
                if (op === 'begin') {
                    assert.deepEqual(fields, { job, dataset, direction: 'push', base, jobBound: true, resumeOnly: true });
                    if (busy) { busy = false; throw new SyncError('BUSY', 'old session is still draining'); }
                    return { job, generation: job, base, phase: resumePhase, ...resumed };
                }
                if (alwaysFail) throw new SyncError('SSH', 'still disconnected');
                return op === 'inspect' ? { changed: [], extra: [] } : { digest: manifest.digest, generation: job };
            } };
        },
    };
    return { session, job, device: { remote: { dataset } }, events, logs, reconnects: () => reconnects };
}

test('a dead upload control reconnects only to the retained task and keeps the original transfer statistics', async () => {
    const f = fixture();
    const result = await finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats);
    assert.equal(result.digest, manifest.digest); assert.deepEqual(result.stats, stats);
    assert.deepEqual(f.events, ['inspect', 'reconnect', 'begin', 'inspect', 'commit']);
    assert.equal(f.reconnects(), 1);
});

test('lost commit acknowledgement recovers a completed publication without another inspect or transfer', async () => {
    const f = fixture({ failAt: 'commit', resumePhase: 'done' });
    assert.equal((await finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats)).digest, manifest.digest);
    assert.deepEqual(f.events, ['inspect', 'commit', 'reconnect', 'begin', 'commit']);
});

test('finalizing publication recovery retries commit and a brief old-session lock is bounded', async () => {
    const f = fixture({ failAt: 'commit', resumePhase: 'finalizing', busyOnce: true });
    assert.equal((await finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats)).digest, manifest.digest);
    assert.deepEqual(f.events, ['inspect', 'commit', 'reconnect', 'begin', 'begin', 'commit']);
});

test('a different task, generation, base or phase cannot be claimed after reconnect', async () => {
    for (const resumed of [{ job: randomUUID() }, { generation: randomUUID() }, { base: 'b'.repeat(64) }, { phase: 'paused' }]) {
        const f = fixture({ resumed });
        await assert.rejects(finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats), { code: 'REMOTE_PROTOCOL' });
        assert.ok(!f.events.includes('commit'));
    }
});

test('permission and integrity errors never trigger automatic reconnect or publishing', async () => {
    for (const code of ['PERMISSION', 'REMOTE_CHANGED', 'INTEGRITY', 'REMOTE_PROTOCOL']) {
        const f = fixture(); f.session.control.request = async () => { throw new SyncError(code, 'synthetic refusal'); };
        await assert.rejects(finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats), { code });
        assert.equal(f.reconnects(), 0);
    }
});

test('control reconnection stops after two attempts and never declares success while still disconnected', async () => {
    const f = fixture({ alwaysFail: true });
    await assert.rejects(finalizeUpload(f.session, f.device, f.job, 'unused', manifest, stats), { code: 'SSH' });
    assert.equal(f.reconnects(), 2); assert.ok(!f.events.includes('commit'));
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
});
