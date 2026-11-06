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
}
