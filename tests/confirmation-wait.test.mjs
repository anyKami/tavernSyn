import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.mjs';
import { portableState } from '../lib/snapshot.mjs';
import { Manager } from '../helper/manager.mjs';

for (const action of ['confirm', 'cancel']) {
    test(`confirmation can still ${action} after waiting a day`, async t => {
        const device = await fixture(), manager = new Manager(device);
        manager.job = { id: randomUUID(), direction: 'pull', tab: randomUUID() };
        const local = await portableState(device);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let outcome = 'waiting';
        const waiting = manager.confirm('Confirm the downloaded data.', local, 'fixture-remote')
            .then(() => { outcome = 'confirmed'; }, error => { outcome = error.code; });
        t.after(async () => {
            manager.wake.confirm?.(Object.assign(new Error('Test cleanup'), { code: 'CANCELLED' }));
            await waiting;
        });
        await manager.writeQueue;
        t.mock.timers.tick(24 * 60 * 60 * 1000);
        await Promise.resolve();
        assert.equal(outcome, 'waiting');
        assert.equal(typeof manager.wake.confirm, 'function');
        const status = await manager.status();
        assert.equal(status.phase, 'AWAITING_CONFIRMATION');
        await manager.action(action, { id: status.id, token: status.confirmationToken });
        await waiting;
        assert.equal(outcome, action === 'confirm' ? 'confirmed' : 'CANCELLED');
        assert.deepEqual(manager.wake, {});
    });
}

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
