import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { loadDevice } from '../lib/device.mjs';
import { atomicJson, cliOptions, exists, readJson, requireThat } from '../lib/io.mjs';

export async function recoverStopped(device) {
    await new Promise((resolve, reject) => {
        const test = net.createServer(); test.once('error', () => reject(new Error('酒馆端口仍被占用，请先关闭原实例。')));
        test.listen(Number(new URL(device.origin).port), '127.0.0.1', () => test.close(resolve));
    });
    const files = [];
    for (const name of ['instance.lock', 'launcher.lock', 'operation.lock']) {
        const file = path.join(device.state, name); if (!await exists(file)) continue;
        const lock = await readJson(file);
        requireThat(Number.isSafeInteger(lock.pid) && lock.pid > 0, 'LOCK', '锁记录格式异常，请手动核对。');
        let live = true;
        try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
        requireThat(!live, 'LIVE_PROCESS', '锁所指进程仍存在，禁止清理；本工具不会强杀进程。'); files.push(file);
    }
    for (const file of files) await fs.unlink(file);
    const statusFile = path.join(device.state, 'status.json');
    if (await exists(statusFile)) {
        const status = await readJson(statusFile);
        if (!['SUCCEEDED', 'PREVIEW', 'FAILED', 'PENDING_APPLY', 'IDLE'].includes(status.phase)) {
            const applyFile = path.join(device.state, 'apply.json');
            const journal = await exists(applyFile) ? await readJson(applyFile) : null;
            const needsRollback = journal && !['committed', 'rolled-back'].includes(journal.phase);
            await atomicJson(statusFile, { ...status, phase: needsRollback ? 'RECOVERY_REQUIRED' : 'FAILED', error: { code: 'INTERRUPTED', message: needsRollback ? '已清理死进程锁；受控启动将先恢复未完成替换。' : '上次任务中断，已确认进程退出。可恢复或中止原远端任务。' } });
        }
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = cliOptions(), device = await loadDevice(options.state);
        requireThat(options['acknowledge-stopped'] === 'yes', 'ACK', '先确认所有酒馆和助手已关闭，再提供 --acknowledge-stopped yes。本工具仅清理已死进程的锁，不会结束进程或删除用户数据。');
        await recoverStopped(device);
        console.log('已清理确认退出的进程锁。再次从 TavernSyn 入口启动时，将先检查并恢复未完成的替换记录。');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
