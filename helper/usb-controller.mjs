import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requireThat, SyncError } from '../lib/io.mjs';
import { UsbSession } from './usb-sync.mjs';
import { startUsbServer, connectUsbPeer, syncUsb } from './usb-service.mjs';
import { waitForUsbPeer } from './usb-connect-wait.mjs';
import { connectUsb } from './usb-adb.mjs';

const TERMINAL = new Set(['idle', 'completed', 'failed', 'cancelled', 'unavailable']);
const BUSY = new Set(['connecting', 'waiting', 'connected', 'selected', 'stopping', 'transferring', 'restarting']);
const JOB_TERMINAL = new Set(['IDLE', 'SUCCEEDED', 'FAILED', 'PREVIEW']);
const CHOICES = new Set(['push', 'pull']);

export function usbMode(platform = process.platform, env = process.env) {
    if (platform === 'win32') return 'client';
    if (platform === 'android' || env.TERMUX_VERSION || /\/com\.termux\/files\/usr(?:\/|$)/.test(env.PREFIX ?? '')) return 'serve';
    return null;
}
function safeError(error) {
    if (error instanceof SyncError) return { code: error.code, message: error.message };
    return { code: 'USB_FAILED', message: 'USB 运行异常，请检查本机控制目录日志及设备连接。' };
}
function sleep(ms, signal) { return delay(ms, undefined, { signal }); }

export class UsbController {
    constructor(device, lifecycle, manager, { mode = usbMode(), log = () => {}, port = 17653, adapter = {} } = {}) {
        this.device = device; this.lifecycle = lifecycle; this.manager = manager; this.mode = mode; this.log = log; this.port = port;
        this.adapter = { UsbSession, startUsbServer, connectUsbPeer, syncUsb, waitForUsbPeer, connectUsb, ...adapter };
        this.stage = 'idle'; this.peer = null; this.selection = null; this.error = null; this.note = '';
        this.cancelled = new AbortController(); this.worker = null; this.offline = null;
        this.started = false; this.stoppedByUsb = false;
    }
    status() {
        return { supported: !!this.mode, mode: this.mode, stage: this.stage, peer: this.peer, selection: this.selection,
            error: this.error, note: this.note };
    }
    update(stage, { note = '', peer = this.peer, selection = this.selection } = {}) {
        this.stage = stage; this.note = note; this.peer = peer; this.selection = selection;
        this.log('USB 插件：' + stage + (note ? '；' + note : ''));
    }
    async connect({ receipt, tab } = {}) {
        requireThat(this.mode && this.lifecycle && this.manager && this.lifecycle.child && !this.lifecycle.stopped,
            'UNMANAGED', 'USB 插件模式需要 Windows 或 Termux 上正在运行的 TavernSyn 受控酒馆。');
        requireThat(!this.worker && TERMINAL.has(this.stage) && !this.manager.busy, 'BUSY', '已有同步或 USB 连接任务正在运行。');
        requireThat(typeof tab === 'string' && /^[a-f0-9-]{36}$/.test(tab)
            && typeof receipt === 'string' && /^[a-f0-9-]{36}$/.test(receipt), 'INPUT', 'USB 保存回执或标签页无效。');
        const previous = await this.manager.status();
        requireThat(JOB_TERMINAL.has(previous.phase) && !previous.maintenancePending,
            'RECOVERY_REQUIRED', '上次同步尚待应用或收尾，请完成后再连接 USB。');
        this.receipt = await this.lifecycle.receipt(receipt);
        await this.lifecycle.verifyReceipt(this.receipt);
        this.cancelled = new AbortController();
        this.error = null; this.peer = null; this.selection = null; this.offline = null;
        this.started = false; this.stoppedByUsb = false;
        this.manager.busy = true;
        this.session = new this.adapter.UsbSession(this.device, {
            lifecycle: this.lifecycle, log: message => this.log('USB：' + message),
        });
        this.update('connecting');
        this.worker = this.run().catch(() => {}).finally(() => { this.worker = null; this.manager.busy = false; });
        return this.status();
    }
    async select(direction) {
        requireThat(CHOICES.has(direction), 'INPUT', 'USB 同步方向无效。');
        requireThat(this.stage === 'connected' && this.peer, 'USB_STAGE', '请先连接另一端 USB 设备。');
        const selected = this.mode === 'serve' ? this.server.chooseDirection(direction) : await this.connection.chooseDirection(direction);
        requireThat(selected.direction === direction, 'USB_DIRECTION', '另一端已先选择了不同方向，本机自动跟随该方向。');
        this.selection = selected;
        this.update('selected', { note: '已选择方向，正在交接两端酒馆。' });
        return this.status();
    }
    async cancel() {
        requireThat(['connecting', 'waiting', 'connected'].includes(this.stage), 'USB_STAGE', '同步方向已选定，不能中断正在应用的数据。');
        this.cancelled.abort(new SyncError('CANCELLED', '本次 USB 连接已取消。'));
        this.connection?.close(); this.server?.close();
        return { ...this.status(), stage: 'cancelled', note: '正在清理连接。' };
    }
    async cancelForExit() {
        if (['connecting', 'waiting', 'connected'].includes(this.stage)) {
            this.cancelled.abort(new SyncError('CANCELLED', '启动器退出，停止 USB 等待。'));
            this.connection?.close(); await this.server?.close();
            if (this.worker) await this.worker;
        } else requireThat(!BUSY.has(this.stage), 'USB_RUNNING', 'USB 数据同步正在进行，请在完成或失败恢复后再退出启动器。');
    }
    async prepareOffline() {
        if (this.offline) return this.offline;
        this.offline = (async () => {
            this.update('stopping', { note: '正在让受控酒馆正常保存交接并退出。' });
            await this.lifecycle.verifyReceipt(this.receipt);
            this.stoppedByUsb = true;
            await this.lifecycle.stop({ interruptOnDrain: true,
                onInterrupt: async () => { await this.lifecycle.verifyReceipt(this.receipt); },
            });
            this.cancelled.signal.throwIfAborted();
            await this.session.open({ managedLauncher: true });
            this.update('transferring');
        })();
        return this.offline;
    }
    async phone() {
        this.server = await this.adapter.startUsbServer(this.session, {
            port: this.port,
            beforeTransfer: () => this.prepareOffline(),
            onFailure: () => { void this.server?.close(); },
        });
        this.update('waiting', { note: '等待电脑在插件中点击「连接 USB」。' });
        const peer = await this.server.connected;
        requireThat(peer && !this.cancelled.signal.aborted, 'CANCELLED', 'USB 连接已结束。');
        this.update('connected', { peer });
        const selected = await this.server.selection;
        requireThat(selected && !this.cancelled.signal.aborted, 'CANCELLED', '未选择 USB 同步方向。');
        this.update('selected', { selection: selected });
        // Start the phone's stop before the PC sends /export or /receive.
        await this.prepareOffline();
        await this.server.closed;
        requireThat(this.session.stage === 'completed', 'USB_FAILED',
            this.session.manager.job?.error?.message ?? 'USB 对端未确认完整同步，请核对日志。');
    }
    async computer() {
        this.tunnel = await this.adapter.connectUsb({ port: this.port });
        this.update('waiting', { note: '等待手机在插件中点击「连接 USB」。' });
        this.connection = await this.adapter.waitForUsbPeer(this.session, {
            origin: this.tunnel.origin, signal: this.cancelled.signal,
        });
        this.update('connected', { peer: this.connection.peer });
        const selected = await this.connection.waitForSelection({ signal: this.cancelled.signal });
        requireThat(selected && !this.cancelled.signal.aborted, 'CANCELLED', '未选择 USB 同步方向。');
        this.update('selected', { selection: selected });
        await this.prepareOffline();
        const token = this.connection.token;
        this.connection.close(); this.connection = null;
        const outcome = await this.adapter.syncUsb(this.session, {
            origin: this.tunnel.origin, token, direction: selected.direction,
            onProgress: progress => { if (progress.stage && progress.stage !== 'completed') this.note = 'USB 阶段：' + progress.stage; },
        });
        requireThat(outcome && this.session.stage === 'completed', 'USB_RESULT_UNKNOWN', 'USB 传输结果尚未确认，请检查接收设备。');
    }
    async run() {
        let failure;
        try {
            if (this.mode === 'serve') await this.phone();
            else await this.computer();
            this.update('completed', { note: '数据已同步并校验，受控酒馆将自动重新启动。' });
        } catch (error) {
            failure = error;
            this.error = safeError(error);
            this.update(this.cancelled.signal.aborted && !this.stoppedByUsb ? 'cancelled' : 'failed', { note: '原始数据和恢复记录将按本机状态保留。' });
        } finally {
            this.connection?.close();
            await this.server?.close().catch(() => {});
            await this.tunnel?.close().catch(() => {});
            try { if (this.session?.opened || this.session?.locks?.length) await this.session.close(); }
            catch (error) { failure ??= error; this.error = safeError(error); this.update('failed', { note: 'USB 任务未能释放全部文件锁，请查看恢复日志。' }); }
            if (this.stoppedByUsb && this.lifecycle.stopped && !this.lifecycle.closing && !this.session?.opened) {
                try {
                    const outcome = this.stage;
                    this.update('restarting', { note: 'USB ' + outcome + '，正在重新启动酒馆。' });
                    await this.lifecycle.start();
                    this.update(outcome, { note: outcome === 'completed' ? 'USB 完整同步已经完成。' : 'USB 未完成，原酒馆已重启。' });
                } catch (error) {
                    this.error = safeError(error);
                    this.update('failed', { note: '酒馆重新启动失败，请查看 server.log 并从受控入口重新启动。' });
                }
            }
            if (failure) this.log('USB 插件失败：' + this.error?.code + '，' + this.error?.message);
        }
    }
}
