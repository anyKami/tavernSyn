import { spawn } from 'node:child_process';
import { requireThat, SyncError } from '../lib/io.mjs';

const TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function commandError(error) {
    if (error instanceof SyncError && error.code?.startsWith('USB_ADB_')) return error;
    const detail = `${error?.stderr ?? ''}\n${error?.message ?? ''}`.toLowerCase();
    if (error?.code === 'ENOENT') return new SyncError('USB_ADB_MISSING', '找不到 adb，请安装 Android SDK Platform-Tools，或指定 adb 可执行文件路径。');
    if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') return new SyncError('USB_ADB_TIMEOUT', 'ADB 操作超过 30 秒，请检查 USB 连接并重新尝试。');
    if (/unauthorized|unauthorised|still authorizing/.test(detail)) return new SyncError('USB_ADB_UNAUTHORIZED', '手机尚未授权 USB 调试。请解锁手机并允许这台电脑，再重新连接。');
    if (/more than one|multiple devices/.test(detail)) return new SyncError('USB_ADB_MULTIPLE', '检测到多台 USB 设备，请指定手机序列号；Windows 原生 ADB 无法识别 USB 路径时，请只连接一台手机。');
    if (/offline/.test(detail)) return new SyncError('USB_ADB_OFFLINE', '手机的 ADB 连接离线，请重新插拔数据线并检查手机上的 USB 调试授权。');
    if (/no devices|no device|device.*not found/.test(detail)) return new SyncError('USB_ADB_NO_DEVICE', '未找到已连接的 USB 手机，请使用数据线连接并开启 USB 调试。');
    return new SyncError('USB_ADB_FAILED', 'ADB 操作未完成，请检查 Platform-Tools、手机授权和 USB 连接。');
}

// No shell is involved, including when the executable path contains spaces.
// Keep both streams bounded; a stalled or noisy adb must not hang the launcher.
export function runAdbCommand(executable, args, { timeoutMs = TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES, spawnProcess = spawn } = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { reject(commandError(error)); return; }
        let stdout = '', stderr = '', bytes = 0, settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) reject(error); else resolve(result);
        };
        const abort = error => {
            try { child.kill('SIGKILL'); } catch { /* The child may already have exited. */ }
            child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
            finish(error);
        };
        const timer = setTimeout(() => abort(new SyncError('USB_ADB_TIMEOUT', 'ADB 操作超时，请检查 USB 连接并重新尝试。')), timeoutMs);
        const collect = (chunk, isError) => {
            if (settled) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) { abort(new SyncError('USB_ADB_OUTPUT', 'ADB 返回内容过大，已停止本次连接。')); return; }
            if (isError) stderr += chunk; else stdout += chunk;
        };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => collect(chunk, false));
        child.stderr.on('data', chunk => collect(chunk, true));
        child.once('error', error => finish(commandError(error)));
        child.once('close', code => finish(code === 0 ? null : commandError({ stderr }), { stdout, stderr }));
    });
}

function validSerial(serial) {
    return typeof serial === 'string' && SERIAL.test(serial) && serial !== 'unknown';
}

function validateExecutable(adb) {
    requireThat(typeof adb === 'string' && adb.length > 0 && adb.length <= 4096 && !/[\x00-\x1f\x7f]/.test(adb)
        && !/^\s|\s$/.test(adb) && !/\.(?:cmd|bat)$/i.test(adb), 'USB_ADB_PATH', 'ADB 路径必须是可执行文件（如 adb.exe），不能使用批处理脚本或附加命令。');
}

function forwardingFor(output, local) {
    const entries = output.split(/\r?\n/).filter(line => line.trim()).map(line => line.trim().split(/\s+/));
    requireThat(entries.every(parts => parts.length === 3), 'USB_ADB_OUTPUT', 'ADB 端口转发列表格式异常，未删除任何转发。');
    return entries.filter(parts => parts[1] === local);
}

/** Create one USB-only tunnel and remove only its unchanged forwarding entry. */
export async function connectUsb({ adb = 'adb', serial, port = 17653, runCommand = runAdbCommand } = {}) {
    validateExecutable(adb);
    requireThat(Number.isInteger(port) && port > 0 && port <= 65535, 'USB_ADB_PORT', 'USB 服务端口必须是 1–65535 的整数。');
    requireThat(serial === undefined || validSerial(serial), 'USB_ADB_SERIAL', '手机序列号无效，请使用 adb devices 显示的完整序列号。');
    requireThat(typeof runCommand === 'function', 'USB_ADB_INPUT', 'ADB 执行器无效。');
    const invoke = async args => {
        let result;
        try { result = await runCommand(adb, args, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_OUTPUT_BYTES }); }
        catch (error) { throw commandError(error); }
        requireThat(result && typeof result.stdout === 'string' && (result.stderr === undefined || typeof result.stderr === 'string')
            && Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr ?? '') <= MAX_OUTPUT_BYTES,
        'USB_ADB_OUTPUT', 'ADB 返回内容异常，已停止本次连接。');
        return result.stdout.trim();
    };
    const selected = serial ?? await invoke(['-d', 'get-serialno']);
    requireThat(validSerial(selected), 'USB_ADB_SERIAL', 'ADB 未返回唯一有效的 USB 手机序列号，请检查数据线和授权。');
    requireThat(!selected.startsWith('emulator-'), 'USB_ADB_NOT_USB', 'USB 同步只支持数据线连接的手机，不支持模拟器或无线 ADB。');
    const selector = ['-s', selected];
    const state = await invoke([...selector, 'get-state']);
    if (state === 'unauthorized') throw commandError({ stderr: 'unauthorized' });
    if (state === 'offline') throw commandError({ stderr: 'offline' });
    requireThat(state === 'device', 'USB_ADB_STATE', '手机尚未处于可用的 ADB 状态，请完成 USB 调试授权后重试。');
    const devpath = await invoke([...selector, 'get-devpath']);
    if (devpath === 'unknown') {
        // The native Windows backend registers USB transports with a null
        // devpath. Prove USB membership through adb's USB-only selector instead.
        // This intentionally requires one USB device on that backend.
        const usbSerial = await invoke(['-d', 'get-serialno']);
        requireThat(usbSerial === selected, 'USB_ADB_NOT_USB', '所选设备不是当前唯一的 USB 手机。请关闭无线 ADB，或只连接目标手机后重试。');
    } else requireThat(/^usb:[^\s\x00-\x1f\x7f]+$/.test(devpath), 'USB_ADB_NOT_USB', '所选设备不是 USB 数据线连接，拒绝通过网络 ADB 或模拟器传输。');

    const target = `tcp:${port}`;
    const answer = await invoke([...selector, 'forward', 'tcp:0', target]);
    requireThat(/^[1-9][0-9]{0,4}$/.test(answer) && Number(answer) <= 65535, 'USB_ADB_PORT', 'ADB 未返回有效的本机转发端口，已停止同步；未尝试删除无法确认归属的转发。');
    const localPort = Number(answer), local = `tcp:${localPort}`;
    const owns = async () => {
        const entries = forwardingFor(await invoke([...selector, 'forward', '--list']), local);
        return entries.length === 1 && entries[0][0] === selected && entries[0][2] === target;
    };
    requireThat(await owns(), 'USB_ADB_FORWARD', 'USB 转发记录与本次设备或端口不一致，已停止同步；未修改其他转发。');
    let closed = false, closing = null;
    const close = async () => {
        if (closed) return;
        if (closing) return closing;
        closing = (async () => {
            if (await owns()) await invoke([...selector, 'forward', '--remove', local]);
            closed = true;
        })();
        try { await closing; } finally { closing = null; }
    };
    return { serial: selected, port: localPort, origin: `http://127.0.0.1:${localPort}`, close };
}
