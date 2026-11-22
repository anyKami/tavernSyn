import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectUsb, runAdbCommand } from '../helper/usb-adb.mjs';

const phone = 'HONOR_TEST_123';
const forward = `${phone} tcp:41321 tcp:17653\n`;

function scripted(replies) {
    const calls = [];
    const runCommand = async (file, args, options) => {
        calls.push({ file, args, options });
        assert.ok(replies.length, `unexpected adb command: ${args.join(' ')}`);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return typeof reply === 'string' ? { stdout: reply, stderr: '' } : reply;
    };
    return { calls, runCommand };
}

function failing(stderr, code) { return Object.assign(new Error('adb failed'), { stderr, code }); }

test('USB connects only the unique authorized USB phone and closes exactly its own forward once', async () => {
    const fake = scripted([`${phone}\r\n`, 'device\n', 'usb:1-4.2\n', '41321\n', forward,
        `OTHER_PHONE tcp:41322 tcp:8000\n${forward}`, '']);
    const tunnel = await connectUsb({ runCommand: fake.runCommand });
    assert.equal(tunnel.serial, phone);
    assert.equal(tunnel.port, 41321);
    assert.equal(tunnel.origin, 'http://127.0.0.1:41321');
    await Promise.all([tunnel.close(), tunnel.close()]);
    await tunnel.close();
    assert.deepEqual(fake.calls.map(call => call.args), [
        ['-d', 'get-serialno'], ['-s', phone, 'get-state'], ['-s', phone, 'get-devpath'],
        ['-s', phone, 'forward', 'tcp:0', 'tcp:17653'], ['-s', phone, 'forward', '--list'],
        ['-s', phone, 'forward', '--list'], ['-s', phone, 'forward', '--remove', 'tcp:41321'],
    ]);
    assert.ok(fake.calls.every(call => call.file === 'adb' && call.options.timeoutMs === 30000 && call.options.maxBytes === 65536));
});

test('explicit USB selection and an adb executable path with spaces remain separate argv', async () => {
    const fake = scripted(['device', 'usb:2-3', '65000', `${phone} tcp:65000 tcp:17654`, '']);
    const executable = 'C:\\Program Files\\Android SDK\\platform-tools\\adb.exe';
    const tunnel = await connectUsb({ serial: phone, adb: executable, port: 17654, runCommand: fake.runCommand });
    assert.ok(fake.calls.every(call => call.file === executable));
    assert.deepEqual(fake.calls[0].args, ['-s', phone, 'get-state']);
    assert.deepEqual(fake.calls[2].args, ['-s', phone, 'forward', 'tcp:0', 'tcp:17654']);
    await tunnel.close();
});

test('native Windows unknown devpath is accepted only after the USB-only selector proves the same phone', async () => {
    const fake = scripted(['device', 'unknown', phone, '41321', forward, '']);
    const tunnel = await connectUsb({ serial: phone, runCommand: fake.runCommand });
    assert.deepEqual(fake.calls[2].args, ['-d', 'get-serialno']);
    await tunnel.close();
});

test('ambiguous USB selection does not create a forward', async () => {
    const fake = scripted([failing('error: more than one device/emulator')]);
    await assert.rejects(connectUsb({ runCommand: fake.runCommand }), { code: 'USB_ADB_MULTIPLE' });
    assert.equal(fake.calls.length, 1);
});

test('native Windows unknown path with multiple USB devices is rejected, including an explicit serial', async () => {
    const fake = scripted(['device', 'unknown', failing('error: more than one device')]);
    await assert.rejects(connectUsb({ serial: phone, runCommand: fake.runCommand }), { code: 'USB_ADB_MULTIPLE' });
    assert.ok(fake.calls.every(call => !call.args.includes('forward')));
});

test('network ADB, emulator, and unmatched unknown device paths cannot become USB tunnels', async () => {
    for (const devpath of ['tcp:192.168.1.2:5555', 'local:5554', '', 'usb:', 'usb:1-2\nusb:1-3']) {
        const fake = scripted(['device', devpath]);
        await assert.rejects(connectUsb({ serial: phone, runCommand: fake.runCommand }), { code: 'USB_ADB_NOT_USB' });
        assert.ok(fake.calls.every(call => !call.args.includes('forward')));
    }
    const network = scripted(['device', 'unknown', phone]);
    await assert.rejects(connectUsb({ serial: '192.168.1.2:5555', runCommand: network.runCommand }), { code: 'USB_ADB_NOT_USB' });
    const emulator = scripted([]);
    await assert.rejects(connectUsb({ serial: 'emulator-5554', runCommand: emulator.runCommand }), { code: 'USB_ADB_NOT_USB' });
    assert.equal(emulator.calls.length, 0);
});

test('unauthorized, offline, absent, and missing-adb failures give useful errors without exposing raw output', async () => {
    for (const [error, code] of [
        [failing('device unauthorized. SECRET TEST OUTPUT'), 'USB_ADB_UNAUTHORIZED'],
        [failing('device offline'), 'USB_ADB_OFFLINE'],
        [failing('no devices/emulators found'), 'USB_ADB_NO_DEVICE'],
        [failing("device 'none' not found"), 'USB_ADB_NO_DEVICE'],
        [failing('', 'ENOENT'), 'USB_ADB_MISSING'],
        [failing('', 'ETIMEDOUT'), 'USB_ADB_TIMEOUT'],
    ]) {
        const fake = scripted([error]);
        await assert.rejects(connectUsb({ runCommand: fake.runCommand }), caught => {
            assert.equal(caught.code, code); assert.doesNotMatch(caught.message, /SECRET TEST OUTPUT/); return true;
        });
        assert.equal(fake.calls.length, 1);
    }
});

test('an unauthorized or nonrunning state never reaches forwarding', async () => {
    for (const [state, code] of [['unauthorized', 'USB_ADB_UNAUTHORIZED'], ['offline', 'USB_ADB_OFFLINE'], ['bootloader', 'USB_ADB_STATE'], ['device\nother', 'USB_ADB_STATE']]) {
        const fake = scripted([state]);
        await assert.rejects(connectUsb({ serial: phone, runCommand: fake.runCommand }), { code });
        assert.equal(fake.calls.length, 1);
    }
});

test('invalid serials, ports, and Windows batch executables never invoke adb', async () => {
    const never = () => assert.fail('invalid input invoked adb');
    for (const serial of ['', 'unknown', '-s', 'phone other', 'phone\n', 'phone;command', 'x'.repeat(257), null, 123]) {
        await assert.rejects(connectUsb({ serial, runCommand: never }), { code: 'USB_ADB_SERIAL' });
    }
    for (const port of [0, -1, 65536, 1.5, '17653', NaN, null]) {
        await assert.rejects(connectUsb({ port, runCommand: never }), { code: 'USB_ADB_PORT' });
    }
    for (const adb of ['', 'adb.cmd', 'C:\\tools\\adb.BAT', 'adb.exe\n', ' adb', 'adb\0.exe', null]) {
        await assert.rejects(connectUsb({ adb, runCommand: never }), { code: 'USB_ADB_PATH' });
    }
});

test('malformed or excessively large adb responses are rejected', async () => {
    for (const response of [{ stdout: null }, { stdout: phone, stderr: 123 }, { stdout: 'x'.repeat(65537) }]) {
        const fake = scripted([response]);
        await assert.rejects(connectUsb({ runCommand: fake.runCommand }), { code: 'USB_ADB_OUTPUT' });
    }
    for (const response of ['unknown', '', `${phone}\nSECOND_PHONE`]) {
        const fake = scripted([response]);
        await assert.rejects(connectUsb({ runCommand: fake.runCommand }), { code: 'USB_ADB_SERIAL' });
    }
});

test('unexpected forwarded-port output cannot cause arbitrary cleanup', async () => {
    for (const response of ['0', '-1', '65536', '41321\n41322', 'tcp:41321', '1.5', '', '041321']) {
        const fake = scripted(['device', 'usb:1-2', response]);
        await assert.rejects(connectUsb({ serial: phone, runCommand: fake.runCommand }), { code: 'USB_ADB_PORT' });
        assert.equal(fake.calls.length, 3);
        assert.ok(fake.calls.every(call => !call.args.includes('--remove') && !call.args.includes('--remove-all')));
    }
});

test('new forwarding must be listed with exactly the selected phone and both ports', async () => {
    for (const listing of ['', 'OTHER tcp:41321 tcp:17653', `${phone} tcp:41321 tcp:8000`, `${forward}${forward}`]) {
        const fake = scripted(['device', 'usb:1-2', '41321', listing]);
        await assert.rejects(connectUsb({ serial: phone, runCommand: fake.runCommand }), { code: 'USB_ADB_FORWARD' });
        assert.ok(fake.calls.every(call => !call.args.includes('--remove')));
    }
});

test('cleanup leaves a deleted, rebound, or ambiguous forwarding alone', async () => {
    for (const listing of ['', 'OTHER tcp:41321 tcp:17653', `${phone} tcp:41321 tcp:8000`, `${forward}${forward}`]) {
        const fake = scripted(['device', 'usb:1-2', '41321', forward, listing]);
        const tunnel = await connectUsb({ serial: phone, runCommand: fake.runCommand });
        await tunnel.close(); await tunnel.close();
        assert.equal(fake.calls.length, 5);
        assert.ok(fake.calls.every(call => !call.args.includes('--remove')));
    }
});

test('cleanup with an unreadable list fails safely and can be retried', async () => {
    const fake = scripted(['device', 'usb:1-2', '41321', forward, failing('device offline'), forward, '']);
    const tunnel = await connectUsb({ serial: phone, runCommand: fake.runCommand });
    await assert.rejects(tunnel.close(), { code: 'USB_ADB_OFFLINE' });
    assert.ok(fake.calls.every(call => !call.args.includes('--remove')));
    await tunnel.close();
    assert.deepEqual(fake.calls.at(-1).args, ['-s', phone, 'forward', '--remove', 'tcp:41321']);
});

test('malformed cleanup output cannot be treated as proof of ownership', async () => {
    const fake = scripted(['device', 'usb:1-2', '41321', forward, `${forward}unexpected text`]);
    const tunnel = await connectUsb({ serial: phone, runCommand: fake.runCommand });
    await assert.rejects(tunnel.close(), { code: 'USB_ADB_OUTPUT' });
    assert.ok(fake.calls.every(call => !call.args.includes('--remove')));
});

function childProcess(onSpawn) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killedWith = [];
    child.kill = signal => { child.killedWith.push(signal); queueMicrotask(() => child.emit('close', null)); return true; };
    child.unref = () => {};
    return { child, spawnProcess(file, args, options) { onSpawn?.(file, args, options); return child; } };
}

test('adb runner never uses a shell and keeps executable path and args separate', async () => {
    const executable = 'C:\\Android SDK\\adb.exe', args = ['-s', phone, 'get-state'];
    const fake = childProcess((file, actualArgs, options) => {
        assert.equal(file, executable); assert.equal(actualArgs, args);
        assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    });
    const result = runAdbCommand(executable, args, { spawnProcess: fake.spawnProcess });
    fake.child.stdout.end('device\n'); fake.child.stderr.end(); fake.child.emit('close', 0);
    assert.deepEqual(await result, { stdout: 'device\n', stderr: '' });
});

test('adb runner kills and rejects a stalled child at its deadline', async () => {
    const fake = childProcess();
    await assert.rejects(runAdbCommand('adb', [], { spawnProcess: fake.spawnProcess, timeoutMs: 5 }), { code: 'USB_ADB_TIMEOUT' });
    assert.deepEqual(fake.child.killedWith, ['SIGKILL']);
    assert.equal(fake.child.stdout.destroyed, true); assert.equal(fake.child.stderr.destroyed, true);
});

test('adb runner bounds combined output by UTF-8 bytes and stops a noisy child', async () => {
    const fake = childProcess();
    const result = runAdbCommand('adb', [], { spawnProcess: fake.spawnProcess, maxBytes: 8 });
    fake.child.stdout.write('中文'); // 6 bytes, not two bytes.
    fake.child.stderr.write('错误'); // Combined output exceeds 8 bytes.
    await assert.rejects(result, { code: 'USB_ADB_OUTPUT' });
    assert.deepEqual(fake.child.killedWith, ['SIGKILL']);
});

test('adb runner maps both spawn failures and nonzero process exits', async () => {
    await assert.rejects(runAdbCommand('adb', [], { spawnProcess() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), { code: 'USB_ADB_MISSING' });
    const fake = childProcess();
    const result = runAdbCommand('adb', [], { spawnProcess: fake.spawnProcess });
    fake.child.stderr.write('error: device unauthorized'); fake.child.emit('close', 1);
    await assert.rejects(result, { code: 'USB_ADB_UNAUTHORIZED' });
});
