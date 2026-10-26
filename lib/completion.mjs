import path from 'node:path';
import { digest, exists, noLinks, readJson, requireThat } from './io.mjs';
import { normalizeScope, sameScope, scopeLabel } from './scope.mjs';

export function connectionId(device) {
    const { host, user, dataset } = device.remote ?? {};
    return digest({ host: host ?? '', user: user ?? '', dataset: dataset ?? '' });
}
export function completionPath(device, id) {
    requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? ''), 'JOB', '任务标识无效。');
    return path.join(device.state, 'jobs', id, 'outcome.json');
}
export function validateCompletion(device, record, id) {
    requireThat(record?.format === 1 && record.id === id && record.job?.id === id
        && record.connection === connectionId(device) && ['published', 'applied', 'restored', 'checked'].includes(record.kind)
        && Number.isFinite(Date.parse(record.completedAt)), 'COMPLETION', '提交回执与当前任务或连接不匹配。');
    requireThat(record.kind === 'restored' ? record.job.direction === 'restore'
        : ['push', 'pull'].includes(record.job.direction) && /^[a-f0-9-]{36}$/.test(record.remote?.generation ?? '')
            && /^[a-f0-9]{64}$/.test(record.remote?.digest ?? '') && record.localState?.digest,
    'COMPLETION', '提交回执缺少已核实的结果。');
    requireThat(record.kind !== 'published' || record.job.direction === 'push', 'COMPLETION', '发布回执方向无效。');
    requireThat(record.kind !== 'applied' || record.job.direction === 'pull', 'COMPLETION', '应用回执方向无效。');
    if (record.job.scope) requireThat(normalizeScope(record.job.scope) && sameScope(record.localState?.scope, record.job.scope), 'COMPLETION', '分类完成回执的范围不一致。');
    return record;
}
export async function readCompletion(device, id) {
    const file = completionPath(device, id);
    await noLinks(file);
    return await exists(file) ? validateCompletion(device, await readJson(file), id) : null;
}
export function completedStatus(record, pending = []) {
    const noChanges = record.kind === 'checked';
    const note = record.job.scope ? `所选${scopeLabel(record.job.scope)}${noChanges ? '未变化，已跳过文件传输和重启。' : '已同步，包含删除；其他类别、配置及插件保持不变。'}`
        : noChanges ? '本机共享内容、插件 Git 状态及 VPS 内容均未变化，已跳过快照、文件传输、依赖准备和重启。'
        : record.kind === 'published' ? '已上传停机快照；酒馆重新启动后的新改动留待下次推送。'
        : record.kind === 'restored' ? '已恢复到最近一次拉取前的本机数据。VPS 副本未改变；该次恢复副本已使用。'
        : '数据已应用，受控实例健康检查通过。';
    return { ...record.job, phase: 'SUCCEEDED', updated: new Date().toISOString(), stats: record.stats, remote: record.remote,
        commit: { kind: record.kind, at: record.completedAt, remote: record.remote }, noChanges,
        remoteJob: null, snapshotReady: false, error: null, progress: null, maintenancePending: !!pending.length,
        maintenance: { pending, remote: record.remote?.maintenance ?? [] }, note: note
            + (pending.length ? ' 本机缓存或完成记录尚待整理，可点击“核对同步结果”重试；已提交的数据不会重新上传或覆盖。' : '')
            + (record.remote?.maintenance?.length ? ' VPS 发布已确认，但文件系统同步或记录整理有警告，请检查 VPS 存储。' : '') };
}
