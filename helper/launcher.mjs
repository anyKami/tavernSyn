import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { loadDevice } from '../lib/device.mjs';
import { atomicJson, cliOptions, exists, readJson, requireThat } from '../lib/io.mjs';
import { checkCompatibility } from '../adapters/release-1.19.mjs';
import { rollback } from './apply.mjs';
import { Lifecycle } from './lifecycle.mjs';
import { Manager } from './manager.mjs';
import { recoverStopped } from '../bin/recover.mjs';
import { openBrowser } from './browser.mjs';
import { createSyncLog } from './sync-log.mjs';

async function main() {
    const options = cliOptions(), device = await loadDevice(options.state);
    await checkCompatibility(device.install);
    for (const name of ['instance.lock', 'launcher.lock', 'operation.lock']) {
        if (await exists(path.join(device.state, name))) { await recoverStopped(device); break; }
    }
    const leaseFile = path.join(device.state, 'launcher.lock'), nonce = randomUUID();
    const handle = await fsp.open(leaseFile, 'wx', 0o600).catch(() => { throw Object.assign(new Error('受控启动器锁仍存在。请查看故障恢复说明。'), { code: 'LAUNCHER_LOCK' }); });
    await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.close();
    const release = () => { try { if (JSON.parse(fs.readFileSync(leaseFile, 'utf8')).nonce === nonce) fs.unlinkSync(leaseFile); } catch {} };
    process.once('exit', release);
    await new Promise((resolve, reject) => {
        const socket = net.createServer(); socket.once('error', () => reject(new Error('酒馆端口已占用；启动器不会结束其他进程。')));
        socket.listen({ host: '127.0.0.1', port: Number(new URL(device.origin).port), exclusive: true }, () => socket.close(resolve));
    });
    const applyFile = path.join(device.state, 'apply.json');
    if (await exists(applyFile)) {
        const journal = await readJson(applyFile);
        if (!['committed', 'rolled-back'].includes(journal.phase)) {
            requireThat(!await exists(path.join(device.state, 'operation.lock')), 'RECOVERY_REQUIRED', '上次任务锁仍存在，请按恢复文档先确认所有旧进程已经退出。');
            await rollback(device, journal);
            await atomicJson(path.join(device.state, 'status.json'), { phase: 'FAILED', error: { code: 'INTERRUPTED', message: '已恢复上次中断前的数据，请重新执行同步。' } });
        }
    }
    let manager;
    const syncLog = createSyncLog(device.state);
    process.once('exit', () => syncLog.close());
    const lifecycle = new Lifecycle(device, (action, payload) => manager.action(action, payload), { stdout: process.stdout, stderr: process.stderr });
    manager = new Manager(device, lifecycle, undefined, syncLog);
    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        console.log('正在停止酒馆…');
        try { await lifecycle.close(); release(); process.exit(0); }
        catch (error) { console.error(error.message); process.exit(1); }
    };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);
    await lifecycle.start();
    console.log(`TavernSyn 已启动：${device.origin}\n请从浏览器操作同步。关闭本窗口或按 Ctrl+C 即可停止酒馆。`);
    syncLog(null, `同步详细日志：${syncLog.file}`);
    if (options['open-browser'] === 'yes') {
        try { await openBrowser(device.origin); syncLog(null, `已自动打开浏览器：${device.origin}`); }
        catch { syncLog(null, `自动打开浏览器失败，请手动访问 ${device.origin}`); }
    }
}
main().catch(error => { console.error(`TavernSyn：${error.message}`); process.exitCode = 1; });
