import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DriveRepository } from '../lib/drive-repository.mjs';
import { driveApi, driveFingerprint, driveKey } from '../lib/drive-connection.mjs';
import { readDriveCredentials } from '../lib/drive-auth.mjs';
import { packDriveArchive, unpackDriveArchive } from '../lib/drive-archive.mjs';
import { atomicJson, exists, noLinks, readJson, requireThat } from '../lib/io.mjs';
import { connectionId } from '../lib/completion.mjs';
import { enoughSpace, validateContent } from '../lib/content.mjs';
import { hashFile, validateManifest, verify } from '../lib/manifest.mjs';

const sameHead = (a, b) => (a?.generation ?? null) === (b?.generation ?? null) && (a?.digest ?? null) === (b?.digest ?? null);
function checkSession(session, device) {
    requireThat(!session.closed && session.identity === connectionId(device), 'CONFIG_CHANGED', '云盘仓库或授权应用已改变，不能继续此任务。');
}
export async function connect(device, apiFactory = driveApi, log = () => {}) {
    requireThat(device.provider === 'google-drive' && device.drive?.rootId && device.drive?.dataset, 'DRIVE_CONFIG', '请先授权 Google 云盘并创建或加入仓库。');
    const credentials = await readDriveCredentials(device), key = driveKey(credentials);
    requireThat(credentials.refreshToken && credentials.clientId === device.drive.clientId
        && driveFingerprint(key) === device.drive.keyFingerprint, 'DRIVE_CONFIG', '云盘授权或仓库密钥与本机绑定不一致。');
    const identity = connectionId(device), cacheFile = path.join(device.state, 'drive-head.json');
    await noLinks(cacheFile);
    const cached = await exists(cacheFile) ? await readJson(cacheFile).catch(() => null) : null;
    const api = apiFactory(device), repository = new DriveRepository(api, { ...device.drive, key,
        anchor: cached?.connection === identity ? cached.head : null });
    await repository.open();
    const current = await repository.head();
    const session = { provider: 'google-drive', api, repository, key, identity, log, closed: false,
        hello: { protocol: 1, dataset: device.drive.dataset, current, capabilities: ['full-sync', 'encrypted-snapshot'] } };
    const remember = async head => {
        if (!head) return;
        await atomicJson(cacheFile, { connection: identity, head }).catch(() => log('云盘提交缓存未保存；下次连接将重新读取提交链。'));
    };
    session.remember = remember;
    session.control = {
        close() { session.closed = true; },
        async request(operation, fields = {}) {
            checkSession(session, device);
            requireThat(['hello', 'published'].includes(operation), 'DRIVE_PROTOCOL', '云盘不支持该控制操作。');
            const head = await repository.head(); await remember(head);
            if (operation === 'published') {
                requireThat(head?.generation === fields.job && head.digest === fields.snapshotDigest, 'COMMIT_NOT_CONFIRMED', '尚不能确认此云盘快照已发布。');
                return head;
            }
            return { ...session.hello, current: head };
        },
    };
    session.assertCurrent = async () => {
        checkSession(session, device);
        const latest = await repository.head();
        requireThat(sameHead(latest, session.downloadHead ?? session.hello.current), 'REMOTE_CHANGED', 'Google 云盘已有新快照，请重新拉取；本机数据未被替换。');
        await remember(latest);
    };
    await remember(current);
    log(`Google 云盘连接成功；仓库 ${device.drive.dataset}；当前代次 ${current?.generation ?? '尚未发布'}`);
    return session;
}
export async function push(session, device, job, payload, manifest, onProgress = () => {}, onBegin = async () => {}, { scope = null, onPlan } = {}) {
    requireThat(!scope, 'UNSUPPORTED_SCOPE', 'Google 云盘目前只支持完整同步。'); checkSession(session, device);
    validateManifest(manifest); await verify(payload, manifest); await validateContent(payload, manifest);
    const latest = await session.repository.head();
    if (latest?.generation === job) {
        requireThat(latest.digest === manifest.digest, 'DRIVE_INTEGRITY', '同一云盘任务的快照摘要发生变化。');
        await session.remember(latest);
        return { ...latest, stats: { sentBytes: 0, receivedBytes: 0, literalBytes: 0, matchedBytes: 0, transferredFiles: 0 } };
    }
    requireThat(sameHead(latest, session.hello.current), 'REMOTE_CHANGED', '另一台设备已推送新快照，请重新检查后推送。');
    const root = path.dirname(payload), archiveFile = path.join(root, `drive-${randomUUID()}.bin`);
    await enoughSpace(root, manifest.bytes, 1);
    session.log('正在压缩并加密完整快照；授权令牌与仓库密钥不进入同步内容。');
    try {
        const archive = await packDriveArchive(payload, manifest, archiveFile, session.key, { rootId: device.drive.rootId, generation: job });
        await onPlan?.({ files: 1, bytes: archive.bytes, sourceBytes: manifest.bytes, sourceFiles: manifest.files.length, archive: true });
        await onBegin({ job, direction: 'push', generation: job });
        const published = await session.repository.publish({ generation: job, manifestDigest: manifest.digest, archiveFile,
            archiveSha256: archive.sha256, base: session.hello.current, onProgress: value => onProgress({ stage: 'transfer', ...value }) });
        requireThat(published.generation === job && published.digest === manifest.digest, 'DRIVE_INTEGRITY', '云盘发布回执与本次快照不一致。');
        const stats = { sentBytes: archive.bytes, receivedBytes: 0, literalBytes: archive.bytes, matchedBytes: 0,
            transferredFiles: 1, unit: 'encrypted snapshot bytes; excludes HTTP and retry overhead' };
        await session.remember(published);
        const maintenance = [...(published.maintenance ?? [])];
        if (published.maintenancePending && !maintenance.length) maintenance.push('旧云盘快照清理尚未完成，下次推送会重试。');
        // Publication is already confirmed. A local progress fsync failure must
        // not turn that durable result into a failed or repeatable upload.
        try { await onProgress({ stage: 'transferred', stats }); }
        catch { maintenance.push('云盘发布已确认，但本机最终进度记录未写入；以完成回执为准。'); }
        return { ...published, stats, ...(maintenance.length ? { maintenance } : {}) };
    } finally { await fs.unlink(archiveFile).catch(() => {}); }
}
export async function pull(session, device, job, payload, onProgress = () => {}, onBegin = async () => {}, { scope = null, onPlan, resume = null } = {}) {
    requireThat(!scope && !resume, 'UNSUPPORTED_SCOPE', 'Google 云盘目前仅支持完整拉取；中断后请重新拉取。'); checkSession(session, device);
    let remote = session.hello.current;
    requireThat(remote, 'EMPTY_REMOTE', 'Google 云盘仓库还没有快照，请先从数据完整的设备推送。');
    const root = path.dirname(payload); await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const archiveFile = path.join(root, `drive-download-${randomUUID()}.bin`);
    await onBegin({ job, direction: 'pull', generation: remote.generation });
    try {
        for (let attempt = 0; ; attempt++) {
            await enoughSpace(root, remote.size, 1);
            await onPlan?.({ files: 1, bytes: remote.size, archive: true });
            try {
                const received = await session.api.downloadFile(remote.fileId, archiveFile, value => onProgress({ stage: 'transfer', ...value }));
                requireThat(received.bytes === remote.size && received.sha256 === remote.archiveSha256,
                    'DRIVE_INTEGRITY', '云盘下载字节数或 SHA-256 与已发布提交不一致。');
                break;
            } catch (error) {
                await fs.unlink(archiveFile).catch(() => {});
                if (attempt >= 1 || error.status !== 404) throw error;
                const newer = await session.repository.head();
                requireThat(newer && !sameHead(newer, remote), 'DRIVE_INTEGRITY', '云盘最新快照文件不存在，请从完整设备重新推送。');
                remote = newer; session.log('下载期间云盘已更新，正在获取新快照。');
            }
        }
        session.downloadHead = remote;
        await session.assertCurrent();
        const manifest = await unpackDriveArchive(archiveFile, payload, session.key, { rootId: device.drive.rootId,
            generation: remote.generation, digest: remote.digest, archiveSha256: remote.archiveSha256 },
        { onManifest: manifest => enoughSpace(root, manifest.bytes, 3) });
        await verify(payload, manifest); await validateContent(payload, manifest);
        await atomicJson(path.join(root, 'manifest.json'), manifest);
        await atomicJson(path.join(root, 'download.json'), { format: 1, provider: 'google-drive', job, dataset: device.drive.dataset,
            generation: remote.generation, digest: manifest.digest, connection: session.identity });
        const stats = { sentBytes: 0, receivedBytes: remote.size, literalBytes: remote.size, matchedBytes: 0,
            transferredFiles: 1, unit: 'encrypted snapshot bytes; excludes HTTP and retry overhead' };
        await onProgress({ stage: 'transferred', stats });
        return { ...remote, manifest, stats };
    } finally { await fs.unlink(archiveFile).catch(() => {}); }
}
export async function catalog() { requireThat(false, 'UNSUPPORTED_SCOPE', 'Google 云盘目前只支持完整同步。'); }
