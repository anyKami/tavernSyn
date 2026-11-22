import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.mjs';
import { Manager } from '../helper/manager.mjs';

for (const [name, phase] of [['ready', 'AWAITING_SAVE'], ['page', 'WAITING_PAGE']]) {
    test(`${phase} still detects an unresponsive browser`, async t => {
        const manager = new Manager(await fixture());
        manager.job = { id: randomUUID(), direction: 'pull' };
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const waiting = manager.waitFor(name, phase);
        const rejected = assert.rejects(waiting, { code: 'USER_TIMEOUT' });
        await manager.writeQueue;
        t.mock.timers.tick(10 * 60 * 1000);
        await rejected;
        assert.deepEqual(manager.wake, {});
    });

    test(`${phase} accepts cancellation while its phase record is still being persisted`, async t => {
        const manager = new Manager(await fixture());
        manager.job = { id: randomUUID(), direction: 'pull' };
        let finishWrite;
        const persisted = new Promise(resolve => { finishWrite = resolve; });
        t.after(() => finishWrite());
        manager.write = async nextPhase => { manager.job.phase = nextPhase; await persisted; };
        const waiting = manager.waitFor(name, phase);
        const rejected = assert.rejects(waiting, { code: 'CANCELLED' });
        await manager.action('cancel', { id: manager.job.id });
        // Let Node detect any unhandled rejection before allowing the write to
        // complete. The original await-write-then-await-wake ordering raced here.
        await new Promise(resolve => setImmediate(resolve));
        finishWrite(); await rejected;
        assert.deepEqual(manager.wake, {});
    });
}
