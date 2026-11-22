import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadDevice } from '../lib/device.mjs';
import { cliOptions, requireThat, SyncError } from '../lib/io.mjs';
import { checkCompatibility } from '../adapters/release-1.19.mjs';
import { connectUsb } from '../helper/usb-adb.mjs';
import { UsbSession } from '../helper/usb-sync.mjs';
import { startUsbServer, syncUsb } from '../helper/usb-service.mjs';
import { createSyncLog } from '../helper/sync-log.mjs';

const HELP = `TavernSyn USB 完整同步（两端先保存并正常关闭酒馆及启动器）
手机：node bin/usb.mjs --state <控制目录> --mode serve
电脑：node bin/usb.mjs --state <控制目录> --mode client
可选：--adb <adb.exe完整路径> --serial <USB设备序列号> --port <手机服务端口>
自动化：--direction push|pull --token <会话配对码> --confirm yes
push = 电脑覆盖手机；pull = 手机覆盖电脑。接收端多出的文件也会删除。
默认交互输入配对码，不将配对码写入命令历史或日志。默认端口 17653。`;

export async function main(options = cliOptions()) {
    const allowed = ['state', 'mode', 'adb', 'serial', 'port', 'direction', 'token', 'confirm', 'help'];
    requireThat(Object.keys(options).every(key => allowed.includes(key)), 'ARGUMENT', '不支持的 USB 参数，请查看 --help yes。');
    if (options.help === 'yes') { console.log(HELP); return; }
    requireThat(['serve', 'client'].includes(options.mode), 'ARGUMENT', '请指定 --mode serve（手机）或 --mode client（电脑）。');
    const port = options.port === undefined ? 17653 : Number(options.port);
    requireThat(Number.isInteger(port) && port > 0 && port <= 65535, 'ARGUMENT', 'USB 服务端口必须为 1–65535 的整数。');
    const device = await loadDevice(options.state);
    await checkCompatibility(device.install);
    const log = createSyncLog(device.state);
    const session = new UsbSession(device, { log: message => log(null, message) });
    let tunnel, server, reader, stopping = false;
    const ask = async question => {
        requireThat(process.stdin.isTTY && process.stdout.isTTY, 'USB_INTERACTIVE', '非交互运行请提供完整参数及 --confirm yes；不能自动选择覆盖方向。');
        reader ??= createInterface({ input: process.stdin, output: process.stdout });
        return (await reader.question(question)).trim();
    };
    const stop = async () => {
        if (stopping) return; stopping = true;
        log(null, '正在等待 USB 同步安全结束；已开始的应用或回滚将完成后再退出，请勿强制结束。');
        await server?.close();
    };
    const signalStop = () => { void stop().catch(error => console.error(`USB 退出未完成：${error.message}`)); };
    try {
        await session.open();
        console.log(`\n本机：${device.deviceName}\nUSB 同步只处理已保存的完整数据，目标多余文件会删除。`);
        if (options.mode === 'serve') {
            requireThat(!options.token && !options.direction && !options.confirm && !options.adb && !options.serial,
                'ARGUMENT', '手机服务只接受 --state、--mode 和 --port；配对码由本次会话随机生成。');
            server = await startUsbServer(session, { port });
            // Intentional one-time display; the secret never enters sync.log.
            console.log(`\nUSB 手机服务已就绪，端口 ${server.port}\n本次配对码：${server.token}\n仅向自己信任的电脑输入此码。可授权该电脑读取或覆盖酒馆完整数据。\n现在在电脑运行 USB-TavernSyn.cmd。完成后服务自动退出；放弃时按 Ctrl+C。\n`);
            for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, signalStop);
            await server.closed;
            const status = session.status();
            if (status.stage === 'completed') console.log('USB 同步已完成。请从正常 TavernSyn 入口启动酒馆。');
            else if (status.stage === 'failed') throw new SyncError(status.job?.error?.code ?? 'USB_FAILED', status.job?.error?.message ?? 'USB 同步未完成。');
        } else {
            let adb = options.adb, token = options.token, direction = options.direction;
            if (!adb) adb = process.stdin.isTTY && process.stdout.isTTY && options.confirm !== 'yes'
                ? await ask('ADB 路径（已加入 PATH 可直接回车）：') || 'adb' : 'adb';
            if (!token) token = await ask('请输入手机显示的本次配对码：');
            if (!direction) {
                const answer = await ask('选择方向：1 = 电脑覆盖手机，2 = 手机覆盖电脑：');
                requireThat(['1', '2'].includes(answer), 'ARGUMENT', '方向必须选择 1 或 2，未开始同步。');
                direction = answer === '1' ? 'push' : 'pull';
            }
            requireThat(['push', 'pull'].includes(direction) && /^[a-f0-9]{32}$/.test(token ?? ''), 'ARGUMENT', '同步方向或 32 位会话配对码无效。');
            tunnel = await connectUsb({ adb, serial: options.serial, port });
            let lastPhase = '';
            const outcome = await syncUsb(session, { origin: tunnel.origin, token, direction,
                confirmPeer: async peer => {
                    const source = direction === 'push' ? device.deviceName : peer.deviceName;
                    const target = direction === 'push' ? peer.deviceName : device.deviceName;
                    console.log(`\nUSB 手机：${peer.deviceName}（${tunnel.serial}）\n来源：${source}\n将被覆盖：${target}\n包括聊天、角色、世界书、图片、设置、API 密钥、插件及源端删除。
接收端将删除旧的 TavernSyn 恢复备份，只保留本次覆盖前的备份。`);
                    requireThat(options.confirm === 'yes' || await ask('确认方向正确且两端已保存并关闭酒馆？输入 YES 开始：') === 'YES',
                        'CANCELLED', '已取消，未开始 USB 数据同步。');
                    // Once confirmed, do not let a terminal signal kill a local
                    // apply or leave the peer's result ambiguous mid-transaction.
                    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, signalStop);
                },
                onProgress: progress => {
                    const phase = progress.stage ?? progress.job?.phase;
                    if (phase && phase !== lastPhase) { lastPhase = phase; log(null, `USB 对端进度：${phase}`); }
                },
            });
            console.log(`\nUSB 完整同步已确认完成。${outcome.cleanupPending ? '对端服务退出尚未确认，请在手机终端按 Ctrl+C 关闭。' : ''}\n请从两端正常 TavernSyn 入口重新启动酒馆。`);
            if (outcome.result?.maintenancePending || outcome.localResult?.maintenancePending) console.log('数据已应用，但有完成记录待整理；请从正常入口使用“核对同步结果”。');
        }
    } catch (error) {
        await session.fail(error).catch(() => {});
        throw error;
    } finally {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, signalStop);
        reader?.close();
        await server?.close().catch(() => {});
        await tunnel?.close().catch(error => console.error(`USB 转发清理未完成：${error.message}`));
        try { await session.close(); } finally { log.close(); }
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(`TavernSyn USB [${error.code ?? 'FAILED'}]：${error.message}`); process.exitCode = 1; });
}
