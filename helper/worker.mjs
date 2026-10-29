import { loadDevice } from '../lib/device.mjs';
import { Manager } from './manager.mjs';
import { createSyncLog } from './sync-log.mjs';

let syncLog;
try {
    const device = await loadDevice(process.env.TAVERNSYN_STATE);
    syncLog = createSyncLog(device.state);
    const manager = new Manager(device, null, undefined, syncLog);
    process.on('message', async message => {
        if (!message?.actionId || !['confirm', 'cancel'].includes(message.action)) return;
        try { process.send?.({ actionId: message.actionId, result: await manager.action(message.action, message.payload) }); }
        catch (error) { process.send?.({ actionId: message.actionId, error: { code: error.code ?? 'WORKER', message: error.code ? error.message : '下载操作未完成。' } }); }
    });
    const task = JSON.parse(process.env.TAVERNSYN_TASK);
    const result = await manager.start(task);
    process.send?.({ result });
    await manager.done;
} catch (error) {
    process.send?.({ error: { code: error.code ?? 'WORKER', message: error.code ? error.message : '下载助手无法完成任务。' } });
    process.exitCode = 1;
} finally { syncLog?.close(); if (process.connected) process.disconnect(); }
