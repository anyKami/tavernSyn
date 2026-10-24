import path from 'node:path';
import { uuidPattern } from './device.mjs';
import { digest, exists, noLinks, readJson, requireThat } from './io.mjs';
import { validateManifest, verify } from './manifest.mjs';

// Recover only a pull interrupted before local preparation/application began.
// Never trust 100% progress as evidence that the payload is complete.
export async function verifiedDownload(device, status) {
    requireThat(status.phase === 'FAILED' && status.direction === 'pull' && uuidPattern.test(status.id)
        && status.remoteJob === status.id && ['SSH', 'SSH_TIMEOUT'].includes(status.error?.code),
    'NO_DOWNLOAD', '该记录不是在下载阶段断开的拉取任务，请查看任务状态。');
    const { host, user, dataset } = device.remote ?? {};
    requireThat(status.connection === digest({ host: host ?? '', user: user ?? '', dataset: dataset ?? '' }),
        'CONFIG_CHANGED', '连接目标已改变，不能应用旧数据集的下载。');
    const jobRoot = await noLinks(path.join(device.state, 'jobs', status.id));
    const applyFile = path.join(device.state, 'apply.json');
    if (await exists(applyFile)) {
        const journal = await readJson(applyFile);
        requireThat(journal.jobRoot !== jobRoot && ['committed', 'rolled-back'].includes(journal.phase),
            'NO_DOWNLOAD', '存在本任务的应用记录或尚未完成的替换，请先检查恢复状态。');
    }
    const payload = path.join(jobRoot, 'payload'), file = path.join(jobRoot, 'manifest.json');
    requireThat(await exists(file), 'NO_DOWNLOAD', '尚无完整下载清单，请恢复下载。');
    await noLinks(file);
    const manifest = validateManifest(await readJson(file)), receiptFile = path.join(jobRoot, 'download.json');
    let remote;
    if (await exists(receiptFile)) {
        await noLinks(receiptFile);
        const receipt = await readJson(receiptFile);
        requireThat(receipt.format === 1 && receipt.job === status.id && receipt.dataset === dataset
            && uuidPattern.test(receipt.generation) && receipt.digest === manifest.digest,
        'MANIFEST', '下载回执与任务或清单不符，拒绝应用。');
        remote = { generation: receipt.generation, digest: receipt.digest };
    } else {
        // Older clients saved the manifest just before finish. Recover only when
        // it exactly matches the publication recorded by the original hello.
        requireThat(uuidPattern.test(status.remoteBase?.generation) && status.remoteBase.digest === manifest.digest,
            'MANIFEST', '旧版下载清单与记录的 VPS 代次不符，请恢复下载以重新确认代次。');
        remote = { generation: status.remoteBase.generation, digest: manifest.digest };
    }
    await verify(payload, manifest);
    return { jobRoot, payload, manifest, remote };
}
