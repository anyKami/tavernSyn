import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { requireThat, SyncError } from '../lib/io.mjs';
import { hashFile } from '../lib/manifest.mjs';

export class Lifecycle {
    constructor(device, onRequest, output = {}) { this.device = device; this.onRequest = onRequest; this.output = output; this.outputDrained = Promise.resolve(); this.child = null; this.pending = new Map(); this.nonce = null; this.stopped = true; this.closing = false; }
    async command(op, fields = {}) {
        requireThat(this.child?.connected && !this.stopped, 'UNMANAGED', '当前实例不受启动器管理。');
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new SyncError('IPC_TIMEOUT', '酒馆控制响应超时，未强制结束进程。')); }, 20000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.send({ channel: 'tavernsyn', type: 'command', nonce: this.nonce, id, op, ...fields });
        });
    }
    async start() {
        requireThat(!this.closing, 'CLOSING', '启动终端已关闭，不再重启酒馆。');
        requireThat(this.stopped, 'OWNERSHIP', '旧进程尚未确认退出。');
        await this.outputDrained;
        this.nonce = randomUUID(); this.stopped = false;
        const log = fs.openSync(path.join(this.device.state, 'server.log'), 'a');
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const timer = setTimeout(() => readyReject(new SyncError('START_TIMEOUT', '酒馆启动超时；仅在确认新进程退出后才允许恢复旧数据。')), 90000);
        const mirror = !!(this.output.stdout || this.output.stderr);
        try { this.child = fork(fileURLToPath(new URL('./bootstrap.mjs', import.meta.url)), [], {
            cwd: this.device.install, windowsHide: true, stdio: ['ignore', mirror ? 'pipe' : log, mirror ? 'pipe' : log, 'ipc'],
            env: { ...process.env, TAVERNSYN_STATE: this.device.state, TAVERNSYN_NONCE: this.nonce, NODE_ENV: 'production',
                SILLYTAVERN_BROWSERLAUNCH_ENABLED: 'false', SILLYTAVERN_ENABLESERVERPLUGINS: 'true',
                SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE: 'false', SILLYTAVERN_EXTENSIONS_AUTOUPDATE: 'false' },
        }); } catch (error) { fs.closeSync(log); clearTimeout(timer); this.stopped = true; throw error; }
        if (mirror) {
            const logfile = fs.createWriteStream(null, { fd: log, autoClose: true });
            this.outputDrained = new Promise(resolve => logfile.once('close', resolve));
            logfile.on('error', () => { readyReject(new SyncError('LOG', '无法写入 server.log，请检查设备控制目录。')); });
            let remaining = 2;
            for (const name of ['stdout', 'stderr']) {
                const stream = this.child[name]; let ended = false;
                const finish = () => { if (!ended) { ended = true; if (--remaining === 0) logfile.end(); } };
                stream.once('end', finish); stream.once('close', finish);
                stream.pipe(logfile, { end: false });
                if (this.output[name]) stream.pipe(this.output[name], { end: false });
            }
        } else fs.closeSync(log);
        this.exit = new Promise(resolve => this.child.once('exit', (code, signal) => {
            this.stopped = true; clearTimeout(timer); readyReject(new SyncError('START_FAILED', '酒馆子进程已退出，请查看本机 server.log。'));
            for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new SyncError('EXITED', '酒馆进程已退出。')); } this.pending.clear(); resolve({ code, signal });
        }));
        this.child.on('error', () => { if (!this.child.pid) this.stopped = true; readyReject(new SyncError('START_FAILED', '无法启动酒馆子进程。')); });
        this.child.on('message', async message => {
            if (message?.channel !== 'tavernsyn' || message.nonce !== this.nonce) return;
            if (message.type === 'ready') {
                if (message.install === this.device.install && message.profile === this.device.profile && message.stateRoot === this.device.state) readyResolve(message);
            } else if (message.type === 'reply') {
                const p = this.pending.get(message.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(message.id);
                if (message.ok) p.resolve(message); else p.reject(new SyncError(message.error?.code ?? 'DRAIN', message.error?.message ?? '无法完成请求排空。'));
            } else if (message.type === 'request') {
                try { const result = await this.onRequest(message.action, message.payload); this.child.send({ channel: 'tavernsyn', type: 'response', nonce: this.nonce, id: message.id, result }); }
                catch (error) { if (this.child.connected) this.child.send({ channel: 'tavernsyn', type: 'response', nonce: this.nonce, id: message.id, error: { code: error.code, message: error.message } }); }
            }
        });
        try {
            const started = await ready;
            requireThat(!started.pluginErrors?.length, 'PLUGIN_HEALTH', '至少一个服务端插件加载失败。保留日志，并在确认退出后恢复旧数据。');
            const ping = await this.command('ping');
            requireThat(ping.install === this.device.install && ping.stateRoot === this.device.state && ping.profile === this.device.profile, 'HEALTH', '启动器与酒馆身份不匹配。');
            const response = await fetch(this.device.origin, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
            requireThat([200, 302].includes(response.status) && response.headers.get('x-tavernsyn-epoch') === this.nonce, 'HEALTH', '监听端口不属于预期酒馆实例。');
            await response.arrayBuffer();
            for (const check of this.device.healthChecks ?? []) {
                requireThat(Number.isInteger(check.port) && check.port > 0 && check.port < 65536 && /^\/[A-Za-z0-9_./-]*$/.test(check.path), 'CONFIG', '插件健康检查只接受本机端口与固定路径。');
                const health = await fetch(`http://127.0.0.1:${check.port}${check.path}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
                await health.arrayBuffer();
                requireThat(health.status === (check.status ?? 200), 'PLUGIN_HEALTH', '本机插件服务健康检查未通过。');
            }
        } finally { clearTimeout(timer); }
        return { nonce: this.nonce, pid: this.child.pid };
    }
    async close() {
        this.closing = true;
        if (this.stopped) { await this.outputDrained; return; }
        const child = this.child;
        if (child.connected) child.disconnect();
        // Only explicit terminal exit has a bound; synchronization still uses strict stop().
        const timer = setTimeout(() => child.kill(), 10000);
        try { await this.exit; await this.outputDrained; } finally { clearTimeout(timer); }
    }
    async stop({ interruptOnDrain = false, onInterrupt = () => {} } = {}) {
        if (this.stopped) { await this.outputDrained; return; }
        try {
            const drained = await this.command('pause');
            requireThat(drained.ok && !drained.active && !drained.uncertain, 'DRAIN', '请求未能安全排空，酒馆保持运行。');
            await this.command('shutdown');
        } catch (error) {
            // Only the saved, handed-off synchronization path opts into this.
            // Never replace an unknown IPC/ownership failure with an interruption.
            if (!interruptOnDrain || error.code !== 'DRAIN') throw error;
            await onInterrupt(error);
            await this.command('interrupt-shutdown');
        }
        let timeout;
        const limit = new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new SyncError('STOP_TIMEOUT', '酒馆退出钩子尚未结束，未强制杀进程。')), 45000); });
        let exit;
        try { exit = await Promise.race([this.exit, limit]); } finally { clearTimeout(timeout); }
        requireThat(exit.code === 0, 'EXIT_FAILED', '酒馆未正常退出，暂停自动应用并保留暂存。');
        await this.outputDrained;
    }
    async receipt(nonce) { return (await this.command('receipt', { receipt: nonce })).receipt; }
    async verifyReceipt(receipt) {
        requireThat(receipt && Date.now() - receipt.created < 180000, 'SAVE_ACK', '保存回执无效或过期。');
        for (const file of receipt.files) requireThat(await hashFile(file.path) === file.sha256, 'SAVE_CHANGED', '保存确认后文件发生变化，请重新执行同步。');
    }
    async resume() { if (!this.stopped) await this.command('resume'); }
}
