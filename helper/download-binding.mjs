import path from 'node:path';
import { createHash } from 'node:crypto';
import { uuidPattern } from '../lib/device.mjs';
import { noLinks, readJson, requireThat, exists, canonical } from '../lib/io.mjs';
import { connectionId } from '../lib/completion.mjs';
import { validateManifest } from '../lib/manifest.mjs';
import { normalizeScope, sameScope, inScope } from '../lib/scope.mjs';

export function validateDownloadBinding(device, job, record) {
    requireThat(uuidPattern.test(job) && record?.format === 1 && record.job === job && record.direction === 'pull'
        && record.connection === connectionId(device) && record.dataset === device.remote.dataset
        && uuidPattern.test(record.generation) && ['transferring', 'verified'].includes(record.state)
        && (record.base === null || /^[a-f0-9]{64}$/.test(record.base)), 'DOWNLOAD_BINDING', '下载恢复记录缺失或连接、任务身份已改变，请重新拉取。');
    const scope = normalizeScope(record.scope); validateManifest(record.manifest);
    if (scope) requireThat(/^[a-f0-9]{64}$/.test(record.publicationDigest ?? '') && typeof record.environment === 'string'
        && record.manifest.files.find(f => f.path === 'environment.json')?.sha256 === createHash('sha256').update(record.environment).digest('hex')
        && record.manifest.files.every(f => f.path === 'environment.json' || inScope(f.path, scope)), 'DOWNLOAD_BINDING', '分类下载恢复记录无效。');
    return record;
}
export async function loadDownloadBinding(device, job) {
    requireThat(uuidPattern.test(job), 'JOB', '任务标识无效。');
    const file = path.join(device.state, 'jobs', job, 'download-resume.json');
    await noLinks(file);
    requireThat(await exists(file), 'DOWNLOAD_BINDING', '旧任务没有下载恢复绑定，请重新拉取。');
    return validateDownloadBinding(device, job, await readJson(file));
}
export function bindingMatches(record, begun) {
    return begun.job === record.job && begun.direction === 'pull' && ['transfer', 'done'].includes(begun.phase)
        && begun.generation === record.generation && (begun.base ?? null) === record.base
        && sameScope(begun.scope, record.scope) && canonical(validateManifest(begun.manifest)) === canonical(record.manifest)
        && (!record.scope || (begun.publicationDigest === record.publicationDigest && begun.environment === record.environment));
}
