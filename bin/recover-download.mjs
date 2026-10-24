import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevice } from '../lib/device.mjs';
import { withDeviceLock } from '../lib/connection.mjs';
import { verifiedDownload } from '../lib/download.mjs';
import { atomicJson, cliOptions, readJson } from '../lib/io.mjs';

export async function recoverDownload(device) {
    return withDeviceLock(device, async () => {
        const file = path.join(device.state, 'status.json'), status = await readJson(file);
        const { jobRoot, manifest, remote } = await verifiedDownload(device, status);
        const pending = { ...status, phase: 'PENDING_APPLY', jobRoot, remote,
            remoteJob: null, error: null, progress: null, updated: new Date().toISOString(),
            files: manifest.files.length, bytes: manifest.bytes,
            note: '已重新校验并复用完整下载；从受控入口打开酒馆后继续确认、应用和重启。' };
        await atomicJson(path.join(jobRoot, 'job.json'), pending);
        await atomicJson(file, pending);
        return pending;
    });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = await recoverDownload(await loadDevice(cliOptions().state));
        console.log(`${result.files} 个文件 SHA-256 校验通过；已转为待应用，无需重新下载。请从 TavernSyn 入口启动并打开酒馆页面。`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
