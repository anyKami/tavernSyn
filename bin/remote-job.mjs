import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDevice, uuidPattern } from '../lib/device.mjs';
import { atomicJson, cliOptions, digest, exists, readJson, requireThat } from '../lib/io.mjs';
import { verify } from '../lib/manifest.mjs';
import { connect, push, pull } from '../helper/transport.mjs';
import { Manager } from '../helper/manager.mjs';
import { loadDownloadBinding } from '../helper/download-binding.mjs';
import { connectionId } from '../lib/completion.mjs';
import { sameScope } from '../lib/scope.mjs';

let lock, handle, session;
try {
    const options = cliOptions(), device = await loadDevice(options.state);
    requireThat(uuidPattern.test(options.job) && ['resume', 'abort'].includes(options.action), 'INPUT', '使用 --job 任务UUID --action resume 或 abort。');
    const statusFile = path.join(device.state, 'status.json'), latest = await readJson(statusFile);
    const root = path.join(device.state, 'jobs', options.job), payload = path.join(root, 'payload');
    const status = latest.id === options.job ? latest : await readJson(path.join(root, 'job.json'));
    requireThat(status.id === options.job && ['FAILED', 'PENDING_APPLY'].includes(status.phase)
        && (latest.id === options.job || ['FAILED', 'SUCCEEDED', 'PREVIEW', 'IDLE'].includes(latest.phase)), 'JOB', '只能处理本机记录的失败或待应用任务。');
    const connection = connectionId(device);
    requireThat((status.connection && status.connection === connection) || (latest.id === options.job && !status.connection),
        'CONFIG_CHANGED', '旧任务缺少连接绑定或目标已改变，未执行远端操作。');
    lock = path.join(device.state, 'operation.lock'); handle = await fs.open(lock, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, id: randomUUID() }));
    session = await connect(device);
    if (options.action === 'resume' && status.direction === 'push') requireThat(session.hello.current?.generation === status.id || (session.hello.current?.digest ?? null) === (status.remoteBase?.digest ?? null), 'REMOTE_CHANGED', 'VPS 在中断后已发布其他数据。请停止旧任务并重新预览方向，不会用旧快照静默覆盖。');
    const save = async fields => {
        const result = { ...status, ...fields, updated: new Date().toISOString() };
        await atomicJson(path.join(root, 'job.json'), result);
        await atomicJson(statusFile, result);
    };
    if (options.action === 'abort') {
        requireThat(session.env.jobBound, 'UPGRADE_REQUIRED', '请先更新 VPS，再中止保留的任务。');
        await session.control.request('begin', { job: options.job, dataset: device.remote.dataset, direction: status.direction, base: session.hello.current?.digest ?? null, jobBound: true, resumeOnly: true, ...(status.scope ? { scope: status.scope } : {}) });
        await session.control.request('abort', { job: options.job });
        await save({ phase: 'FAILED', remoteJob: null, error: null, note: '已中止远端暂存任务，当前有效数据未变。本机快照仍保留。' });
    } else if (status.direction === 'push') {
        const manifest = await readJson(path.join(root, 'manifest.json')); await verify(payload, manifest);
        const published = await push(session, device, options.job, payload, manifest, undefined, undefined, { scope: status.scope });
        const metadata = await readJson(path.join(payload, 'environment.json'));
        const manager = new Manager(device, null); manager.job = status;
        await manager.success(metadata.sourceState, { generation: published.generation, digest: published.digest,
            ...(status.scope ? { snapshotDigest: published.snapshotDigest } : {}),
            ...(published.maintenance?.length ? { maintenance: published.maintenance } : {}) }, published.stats, { cache: !status.scope });
        if (manager.job.maintenancePending) console.log(manager.job.note);
    } else {
        requireThat(status.phase === 'FAILED' && ['DOWNLOADING', 'VERIFYING'].includes(status.failurePhase), 'JOB', '只能恢复下载或校验阶段失败的任务。');
        requireThat(!await exists(path.join(root, 'candidate')), 'JOB', '候选数据已存在，不能恢复下载。');
        const applyFile = path.join(device.state, 'apply.json');
        if (await exists(applyFile)) { const journal = await readJson(applyFile); requireThat(['committed', 'rolled-back'].includes(journal.phase) && journal.jobRoot !== root, 'JOB', '存在未完成的应用记录，不能恢复下载。'); }
        const binding = await loadDownloadBinding(device, options.job);
        requireThat(sameScope(status.scope, binding.scope), 'DOWNLOAD_BINDING', '任务范围与下载恢复记录不一致。');
        const downloaded = await pull(session, device, options.job, payload, undefined, undefined, { scope: binding.scope, resume: binding });
        await save({ phase: 'PENDING_APPLY', scope: binding.scope, preview: status.preview, jobRoot: root, remoteJob: null, error: null, progress: null, stats: downloaded.stats, remote: { generation: downloaded.generation, digest: downloaded.digest ?? downloaded.manifest.digest, ...(binding.scope ? { snapshotDigest: downloaded.manifest.digest } : {}) }, note: '已恢复下载并通过校验，等待受控入口继续应用。' });
    }
    console.log('任务处理完成，请返回酒馆查看状态。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { session?.control.close(); if (handle) { await handle.close(); await fs.unlink(lock); } }
