// Shared by the panel and the standalone waiting document. This function is
// also embedded into that document, so keep it independent of module state.
export function progressDetail(status) {
    const google = status.provider === 'google-drive' || status.transport === 'google-drive', remote = google ? 'Google 云盘' : 'VPS';
    if (status.noChanges) return `待${status.direction === 'pull' ? '下载' : '上传'}文件总大小：0 B（0 个新增、修改文件）。\n无需文件传输；本次仅检查本机状态和 ${remote}版本。`;
    const mib = value => `${((value ?? 0) / 1024 / 1024).toFixed(2)} MiB`;
    const lines = [], progress = status.progress;
    if (status.transferPlan && ['UPLOADING', 'DOWNLOADING'].includes(status.phase)) {
        const { bytes, files } = status.transferPlan, units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        const unit = Math.min(bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0, units.length - 1);
        const size = `${(bytes / 1024 ** unit).toFixed(unit ? 2 : 0)} ${units[unit]}`;
        lines.push(`待${status.direction === 'pull' ? '下载' : '上传'}文件总大小：${size}（${files} 个${google ? '快照文件' : '新增、修改文件'}）。`);
        lines.push(google ? 'Google 云盘传输完整的压缩加密快照；快照内容包含删除后的最终状态。' : '不含删除和未变化文件；按完整文件大小合计，实际增量传输量另计。');
    }
    if (progress && ['UPLOADING', 'DOWNLOADING', 'FAILED'].includes(status.phase)) {
        if (progress.stage === 'transferred') {
            lines.push(status.phase === 'FAILED'
                ? '文件传输已结束；后续步骤未完成，同步尚未完成。'
                : status.direction === 'pull' ? '文件传输已结束；继续校验、应用和启动检查。' : '文件传输已结束；继续校验和发布。');
        } else if (google && Number.isFinite(progress.bytes ?? progress.logicalBytes)) {
            lines.push(`${status.phase === 'FAILED' ? '中断前' : '正在传输加密快照；'}已传输 ${mib(progress.bytes ?? progress.logicalBytes)}。`);
        } else if (Number.isFinite(progress.logicalBytes)) {
            lines.push(`${status.phase === 'FAILED' ? '中断前' : '正在传输差异数据；'}已处理文件内容 ${mib(progress.logicalBytes)}（含复用部分，非实际传输量）。`);
        } else {
            lines.push(status.phase === 'FAILED' ? '传输已中断，同步尚未完成。' : google ? '正在传输加密快照，传输量在结束后显示。' : '正在传输差异数据，实际传输量在传输结束后显示。');
        }
    }
    if (status.stats && Number.isFinite(status.stats.sentBytes)) {
        lines.push(google ? `加密快照已发送 ${mib(status.stats.sentBytes)}，接收 ${mib(status.stats.receivedBytes)}；不含 HTTP 请求和重试开销。`
            : `rsync 已发送 ${mib(status.stats.sentBytes)}，接收 ${mib(status.stats.receivedBytes)}；不含 SSH/Tailscale 封装。`);
    }
    if (status.stats?.incompleteNetworkStats === true) lines.push('未包含部分中断尝试流量。');
    return lines.join('\n');
}
