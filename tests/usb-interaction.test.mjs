import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { chooseUsbDirection, usbDirectionLabel } from '../bin/usb-interaction.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const choice = (direction, selectedBy) => ({ id: randomUUID(), direction, selectedBy });

for (const direction of ['push', 'pull']) test(`one direction argument ${direction} starts without any extra question`, async () => {
    const selected = choice(direction, 'phone'); let calls = 0;
    const result = await chooseUsbDirection({ direction, choose: value => { calls++; assert.equal(value, direction); return selected; },
        waitForSelection: () => new Promise(() => {}), ask: () => assert.fail('a supplied direction must not prompt') });
    assert.equal(result, selected); assert.equal(calls, 1);
    assert.equal(usbDirectionLabel(direction), direction === 'push' ? '电脑 → 手机' : '手机 → 电脑');
});

test('a waiting noninteractive computer follows the phone choice without confirming', async () => {
    const remote = deferred(), selected = choice('pull', 'phone'), lines = [];
    const task = chooseUsbDirection({ choose: () => assert.fail('waiting side cannot invent a direction'), waitForSelection: () => remote.promise, write: text => lines.push(text) });
    remote.resolve(selected);
    assert.equal(await task, selected); assert.equal(lines.length, 1);
});

test('peer selection cancels a real pending readline prompt and ignores later typed input', async t => {
    const input = new PassThrough(), output = new PassThrough(); let text = '';
    output.on('data', data => { text += data; });
    const reader = createInterface({ input, output, terminal: false });
    t.after(() => { reader.close(); input.destroy(); output.destroy(); });
    const remote = deferred(), prompted = deferred(); let promptFinished = false, chose = false;
    const task = chooseUsbDirection({ choose: () => { chose = true; }, waitForSelection: () => remote.promise,
        ask: async (question, options) => { prompted.resolve(); try { return await reader.question(question, options); } finally { promptFinished = true; } } });
    await prompted.promise; const selected = choice('push', 'computer'); remote.resolve(selected);
    assert.equal(await task, selected);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(promptFinished, true); input.write('2\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(chose, false); assert.doesNotMatch(text, /YES|配对码|确认开始/);
});

test('a simultaneous opposite local choice follows the first accepted remote choice', async () => {
    const selected = choice('pull', 'phone');
    const actual = await chooseUsbDirection({ choose: value => { assert.equal(value, 'push'); return selected; },
        waitForSelection: () => new Promise(() => {}), ask: async () => '1' });
    assert.equal(actual, selected); assert.equal(actual.direction, 'pull');
});

test('invalid menu input does not start a job and valid input needs only one selection', async () => {
    const answers = ['YES', '', '2'], lines = []; let calls = 0;
    const selected = choice('pull', 'computer');
    const actual = await chooseUsbDirection({ choose: value => { calls++; assert.equal(value, 'pull'); return selected; },
        waitForSelection: () => new Promise(() => {}), ask: async () => answers.shift(), write: text => lines.push(text) });
    assert.equal(actual, selected); assert.equal(calls, 1); assert.equal(lines.length, 2);
});

test('closing a peer before choosing reports no sync and cancels the local question', async () => {
    let aborted = false;
    await assert.rejects(chooseUsbDirection({ choose: () => assert.fail('no direction was chosen'), waitForSelection: async () => null,
        ask: (_text, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })) }), { code: 'USB_CLOSED' });
    assert.equal(aborted, true);
});

test('cancellation before or during direction selection cannot create a new job', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(chooseUsbDirection({ direction: 'push', signal: cancelled.signal, choose: () => assert.fail('cancelled selection started'), waitForSelection: () => assert.fail('cancelled wait started') }), { code: 'CANCELLED' });
    const active = new AbortController();
    const task = chooseUsbDirection({ signal: active.signal, choose: () => assert.fail('waiting selection started'), waitForSelection: () => new Promise(() => {}) });
    active.abort(); await assert.rejects(task, { code: 'CANCELLED' });
    const immediate = new AbortController(); let choices = 0;
    const queued = chooseUsbDirection({ direction: 'push', signal: immediate.signal,
        choose: () => { choices++; return choice('push', 'computer'); }, waitForSelection: () => new Promise(() => {}) });
    immediate.abort(); await assert.rejects(queued, { code: 'CANCELLED' });
    assert.equal(choices, 0, 'a cancelled queued callback must not send a direction');
});
