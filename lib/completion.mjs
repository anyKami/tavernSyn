import path from 'node:path';
import { digest, exists, noLinks, readJson, requireThat } from './io.mjs';
import { normalizeScope, sameScope, scopeLabel } from './scope.mjs';

export function configuredProvider(device) {
    const provider = device.provider ?? 'vps';
    requireThat(['vps', 'google-drive'].includes(provider), 'CONFIG', '同步存储类型无效。');
    return provider;
}
export function remoteDataset(device) {
    return configuredProvider(device) === 'google-drive' ? device.drive?.dataset : device.remote?.dataset;
}
export function remoteLabel(device) {
    return configuredProvider(device) === 'google-drive' ? 'Google 云盘' : 'VPS';
}
export function connectionIdentity(device) {
    if (configuredProvider(device) === 'google-drive') {
        const { rootId, folderId, dataset, clientId, keyFingerprint } = device.drive ?? {};
        return { provider: 'google-drive', rootId: rootId ?? '', folderId: folderId ?? '', dataset: dataset ?? '',
            clientId: clientId ?? '', keyFingerprint: keyFingerprint ?? '' };
    }
    const { host, user, dataset } = device.remote ?? {};
    // Preserve the identity of existing VPS receipts and resume records.
    return { host: host ?? '', user: user ?? '', dataset: dataset ?? '' };
}
export function connectionId(device, job = null) {
    if (job?.transport === 'usb') {
        requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.peerDeviceId ?? '')
            && job.peerDeviceId !== device.deviceId, 'USB_IDENTITY', 'USB 对端设备标识无效。');
        return digest({ transport: 'usb', deviceId: device.deviceId, peerDeviceId: job.peerDeviceId });
    }
    const provider = configuredProvider(device);
    if (job) requireThat((job.provider ?? (job.transport === 'google-drive' ? 'google-drive' : 'vps')) === provider,
        'CONFIG_CHANGED', '同步存储已改变，不能继续或核对另一存储的旧任务。');
    const identity = connectionIdentity(device);
    if (job?.connectionBinding) requireThat(digest(job.connectionBinding) === digest(identity),
        'CONFIG_CHANGED', '云盘仓库或授权身份已改变，不能继续旧任务。');
    return digest(identity);
}
export function completionPath(device, id) {
    requireThat(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? ''), 'JOB', '任务标识无效。');
    return path.join(device.state, 'jobs', id, 'outcome.json');
}
export function validateCompletion(device, record, id) {
    requireThat(record?.format === 1 && record.id === id && record.job?.id === id
        && record.connection === connectionId(device, record.job) && ['published', 'applied', 'restored', 'checked'].includes(record.kind)
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
    const target = record.job.provider === 'google-drive' || record.job.transport === 'google-drive' ? 'Google 云盘' : 'VPS';
    const note = record.job.transport === 'usb' ? (record.kind === 'published'
        ? 'USB 完整同步已确认：对端应用及启动健康检查通过。请关闭 USB 服务后从正常入口启动酒馆。'
        : 'USB 完整同步已应用，启动健康检查通过；已保留本次覆盖前的备份。请从正常入口启动酒馆。')
        : record.job.scope ? `所选${scopeLabel(record.job.scope)}${noChanges ? '未变化，已跳过文件传输和重启。' : '已同步，包含删除；其他类别、配置及插件保持不变。'}`
        : noChanges ? `本机共享内容、插件 Git 状态及 ${target} 内容均未变化，已跳过快照、文件传输、依赖准备和重启。`
        : record.kind === 'published' ? '已上传停机快照；酒馆重新启动后的新改动留待下次推送。'
        : record.kind === 'restored' ? '已恢复到最近一次覆盖前的本机数据。另一台设备及远端副本未改变；该次恢复副本已使用。'
        : '数据已应用，受控实例健康检查通过。';
    return { ...record.job, phase: 'SUCCEEDED', updated: new Date().toISOString(), stats: record.stats, remote: record.remote,
        commit: { kind: record.kind, at: record.completedAt, remote: record.remote }, noChanges,
        remoteJob: null, snapshotReady: false, error: null, progress: null, maintenancePending: !!pending.length,
        maintenance: { pending, remote: record.remote?.maintenance ?? [] }, note: note
            + (pending.length ? ' 本机缓存或完成记录尚待整理，可点击“核对同步结果”重试；已提交的数据不会重新上传或覆盖。' : '')
            + (record.remote?.maintenance?.length ? ` ${target}发布已确认，但旧文件清理或记录整理尚未全部完成，请查看同步日志。` : '') };
}
