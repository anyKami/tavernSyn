import { setTimeout as delay } from 'node:timers/promises';
import { requireThat, SyncError } from '../lib/io.mjs';
import { validateManifest } from '../lib/manifest.mjs';
import { normalizeScope, sameScope } from '../lib/scope.mjs';

export function permanentTransportFailure(output) {
    const diagnostics = output.split(/\r\n|\r|\n/).filter(line => !/^[<>ch.*][fdLDS]/.test(line.trimStart())).join('\n');
    return /permission denied|host key verification failed|remote host identification has changed|no matching (?:host key|cipher|key exchange)|unable to negotiate|too many authentication failures|authentication failed|command not found|no such file or directory/i.test(diagnostics);
}

export function retryableDownloadError(error) {
    if (error?.transportRetryable === false || error?.signal) return false;
    if (['SSH', 'SSH_TIMEOUT'].includes(error?.code)) return true;
    return error?.code === 'PROCESS_FAILED' && [10, 12, 30, 35, 255].includes(error.exitCode);
}

// One budget covers the initial transfer and all targeted corrections. A retry
// never rebuilds the local basis or claims a new remote publication.
export function createDownloadRecovery(session, device, job, begun, { scope = null, wait = delay } = {}) {
    scope = normalizeScope(scope);
    requireThat(begun.job === job && begun.direction === 'pull' && ['transfer', 'done'].includes(begun.phase) && sameScope(begun.scope, scope),
    'REMOTE_PROTOCOL', 'VPS 下载回执与请求的任务、方向或范围不一致。');
    const pinned = {
        dataset: session.hello.dataset ?? device.remote.dataset,
        generation: begun.generation, digest: validateManifest(begun.manifest).digest,
        base: begun.base ?? null, publicationDigest: begun.publicationDigest, environment: begun.environment,
    };
    const maxReconnects = 5;
    let reconnects = 0, interruptedTransfers = 0;
    return {
        async run(operation) {
            let reconnect = false;
            for (;;) {
                let reclaiming = false, transferring = false;
                try {
                    if (reconnect) {
                        reclaiming = true;
                        reconnects++;
                        const backoff = Math.min(1000 * 2 ** (reconnects - 1), 10000);
                        session.log?.(`下载连接中断，${backoff / 1000} 秒后自动重连（${reconnects}/${maxReconnects}）；保留已下载文件和断点。`);
                        await wait(backoff);
                        await session.reconnect();
                        requireThat(session.env.jobBound === true
                            && (!session.env.remote || session.env.remote.dataset === pinned.dataset),
                        'REMOTE_PROTOCOL', '重连后的 VPS 身份或任务绑定能力改变，已停止下载。');
                        const resumed = await session.control.request('begin', {
                            job, dataset: pinned.dataset, direction: 'pull', jobBound: true, resumeOnly: true,
                            ...(scope ? { scope } : {}),
                        });
                        requireThat(resumed.job === job && resumed.direction === 'pull' && resumed.phase === 'transfer'
                            && resumed.generation === pinned.generation && (resumed.base ?? null) === pinned.base
                            && sameScope(resumed.scope, scope) && validateManifest(resumed.manifest).digest === pinned.digest
                            && (!scope || (resumed.publicationDigest === pinned.publicationDigest && resumed.environment === pinned.environment)),
                        'REMOTE_PROTOCOL', 'VPS 续接回执与原下载任务、代次或清单不一致，已停止下载。');
                        reconnect = false; reclaiming = false;
                        session.log?.(`SSH 已恢复同一下载任务：${job}；继续增量下载。`);
                    }
                    if (session.control.closed || session.control.intentional) throw Object.assign(new SyncError('SSH', '下载前 SSH 控制连接已关闭。'),
                        { transportRetryable: !session.control.intentional });
                    transferring = true;
                    return await operation();
                } catch (error) {
                    if (!reclaiming && session.control.intentional) throw error;
                    const recoverable = retryableDownloadError(error) || (reclaiming && error.code === 'BUSY');
                    if (!recoverable || session.env.jobBound !== true || typeof session.reconnect !== 'function') throw error;
                    if (reconnects >= maxReconnects) {
                        session.log?.('下载自动重连已达 5 次，停止本次下载并保留暂存和断点。');
                        throw error;
                    }
                    if (transferring) interruptedTransfers++;
                    reconnect = true;
                }
            }
        },
        stats(stats) {
            if (!reconnects) return stats;
            const note = interruptedTransfers
                ? '重连前中断传输的网络流量可能未包含在 rsync 完整统计中。'
                : '下载前控制连接已恢复；文件传输统计来自完成的 rsync 进程。';
            session.log?.(`下载自动重连 ${reconnects} 次；${note}`);
            return { ...stats, reconnects, interruptedTransfers, ...(interruptedTransfers ? { incompleteNetworkStats: true } : {}), note };
        },
    };
}
