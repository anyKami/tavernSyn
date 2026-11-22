import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadDevice } from '../lib/device.mjs';
import { cliOptions, requireThat, SyncError } from '../lib/io.mjs';
import { checkCompatibility } from '../adapters/release-1.19.mjs';
import { connectUsb } from '../helper/usb-adb.mjs';
import { UsbSession } from '../helper/usb-sync.mjs';
import { startUsbServer, syncUsb } from '../helper/usb-service.mjs';
import { waitForUsbPeer } from '../helper/usb-connect-wait.mjs';
import { createSyncLog } from '../helper/sync-log.mjs';
import { chooseUsbDirection, usbDirectionLabel } from './usb-interaction.mjs';

const HELP = `TavernSyn USB 完整同步（两端先保存并正常关闭酒馆及启动器）
手机：node bin/usb.mjs --state <控制目录> --mode serve
电脑：node bin/usb.mjs --state <控制目录> --mode client
连接后，手机或电脑任意一端选择方向即开始，另一端自动跟随。
两端均可指定：--direction push|pull
push = 电脑 → 手机；pull = 手机 → 电脑。接收端多出的文件也会删除。
电脑可选：--adb <adb.exe完整路径> --serial <USB设备序列号>
两端可选：--port <手机服务端口>，默认 17653。
不指定方向且无交互终端时，等待另一端选择。两端需要 TavernSyn 0.5.0 或更新版。`;

export async function main(options = cliOptions()) {
    const allowed = ['state', 'mode', 'adb', 'serial', 'port', 'direction', 'help'];
    requireThat(Object.keys(options).every(key => allowed.includes(key)), 'ARGUMENT', '不支持的 USB 参数，请查看 --help yes；新版只需连接后选择方向。');
    if (options.help === 'yes') { console.log(HELP); return; }
    requireThat(['serve', 'client'].includes(options.mode), 'ARGUMENT', '请指定 --mode serve（手机）或 --mode client（电脑）。');
    requireThat(options.mode !== 'serve' || (!options.adb && !options.serial), 'ARGUMENT', '手机入口不使用 --adb 或 --serial。');
    if (options.direction !== undefined) usbDirectionLabel(options.direction);
    const port = options.port === undefined ? 17653 : Number(options.port);
    requireThat(Number.isInteger(port) && port > 0 && port <= 65535, 'ARGUMENT', 'USB 服务端口必须为 1–65535 的整数。');
    const device = await loadDevice(options.state);
    await checkCompatibility(device.install);
    const log = createSyncLog(device.state);
    const session = new UsbSession(device, { log: message => log(null, message) });
    const cancelled = new AbortController();
    let tunnel, server, peerConnection, reader, stopping = false, transferring = false;
    const ask = process.stdin.isTTY && process.stdout.isTTY ? async (question, options) => {
        reader ??= createInterface({ input: process.stdin, output: process.stdout });
        return (await reader.question(question, options)).trim();
    } : undefined;
    const stop = async () => {
        if (stopping) return; stopping = true;
        if (!transferring) { cancelled.abort(new SyncError('CANCELLED', '已取消 USB 连接。')); peerConnection?.close(); }
        else log(null, '正在等待本次 USB 应用或回滚结束后退出。');
        await server?.close();
    };
    const signalStop = () => { void stop().catch(error => console.error(`USB 退出未完成：${error.message}`)); };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, signalStop);
    const showChoice = selected => {
        console.log(`\n已由${selected.selectedBy === 'phone' ? '手机' : '电脑'}选择：${usbDirectionLabel(selected.direction)}，开始完整同步。`);
        console.log('以来源数据为准覆盖目标，包含删除；接收端保留一份本次覆盖前的恢复备份。');
    };
    try {
        await session.open();
        requireThat(!stopping, 'CANCELLED', '已取消 USB 连接。');
        console.log(`\n本机：${device.deviceName}\nUSB 同步以所选来源为准，接收端多出的文件也会删除。`);
        if (options.mode === 'serve') {
            server = await startUsbServer(session, { port });
            requireThat(!stopping, 'CANCELLED', '已取消 USB 连接。');
            console.log(`\n手机 USB 入口已就绪，端口 ${server.port}。等待电脑 USB-TavernSyn.cmd 连接……`);
            const peer = await server.connected;
            requireThat(peer && !stopping, 'USB_CLOSED', 'USB 等待已结束，未开始同步。');
            console.log(`\n已连接电脑：${peer.deviceName}`);
            const selected = await chooseUsbDirection({ direction: options.direction, choose: value => server.chooseDirection(value),
                waitForSelection: () => server.selection, ask, write: message => console.log(message), signal: cancelled.signal });
            requireThat(!stopping, 'CANCELLED', '已取消 USB 同步。');
            transferring = true; reader?.close(); showChoice(selected);
            await server.closed;
            const status = session.status();
            if (status.stage === 'completed') console.log('USB 同步已完成。请从正常 TavernSyn 入口启动酒馆。');
            else if (status.stage === 'failed') throw new SyncError(status.job?.error?.code ?? 'USB_FAILED', status.job?.error?.message ?? 'USB 同步未完成。');
            else throw new SyncError('USB_CLOSED', 'USB 会话已结束，尚未确认同步完成，请检查电脑终端。');
        } else {
            tunnel = await connectUsb({ adb: options.adb ?? 'adb', serial: options.serial, port });
            requireThat(!stopping, 'CANCELLED', '已取消 USB 连接。');
            peerConnection = await waitForUsbPeer(session, { origin: tunnel.origin, signal: cancelled.signal,
                onWaiting: () => console.log('正在等待手机 USB 入口，请在手机运行 usb-tavernsyn.sh……') });
            console.log(`\n已连接手机：${peerConnection.peer.deviceName}（${tunnel.serial}）`);
            const selected = await chooseUsbDirection({ direction: options.direction, choose: value => peerConnection.chooseDirection(value),
                waitForSelection: options => peerConnection.waitForSelection(options), ask, write: message => console.log(message), signal: cancelled.signal });
            requireThat(!stopping, 'CANCELLED', '已取消 USB 同步。');
            transferring = true; reader?.close(); showChoice(selected);
            const token = peerConnection.token;
            peerConnection.close(); peerConnection = null;
            let lastPhase = '';
            const outcome = await syncUsb(session, { origin: tunnel.origin, token, direction: selected.direction,
                onProgress: progress => {
                    const phase = progress.stage ?? progress.job?.phase;
                    if (phase && phase !== lastPhase) { lastPhase = phase; log(null, `USB 对端进度：${phase}`); }
                },
            });
            console.log(`\nUSB 完整同步已完成。${outcome.cleanupPending ? '手机入口退出尚未确认，可在手机终端按 Ctrl+C 关闭。' : ''}\n请从两端正常 TavernSyn 入口重新启动酒馆。`);
            if (outcome.result?.maintenancePending || outcome.localResult?.maintenancePending) console.log('数据已应用，但有完成记录待整理；请从正常入口使用“核对同步结果”。');
        }
    } catch (error) {
        await session.fail(error).catch(() => {});
        throw error;
    } finally {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, signalStop);
        cancelled.abort(); peerConnection?.close(); reader?.close();
        await server?.close().catch(() => {});
        await tunnel?.close().catch(error => console.error(`USB 转发清理未完成：${error.message}`));
        try { await session.close(); } finally { log.close(); }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`TavernSyn USB [${error.code ?? 'FAILED'}]：${error.message}`); process.exitCode = 1; });
}
