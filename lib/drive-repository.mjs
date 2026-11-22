import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, requireThat, SyncError } from './io.mjs';
import { driveIdPattern } from './drive-api.mjs';

const ROOT_FORMAT = 'tavernsyn-drive-repository-v1';
const COMMIT_FORMAT = 'tavernsyn-drive-commit-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{64}$/;
function validId(value) { return typeof value === 'string' && driveIdPattern.test(value); }
function keyValue(key) {
    requireThat(Buffer.isBuffer(key) && key.length === 32, 'DRIVE_KEY', 'Google 云盘仓库密钥必须为32字节。');
    return key;
}
function signed(object, key) {
    return { ...object, mac: createHmac('sha256', keyValue(key)).update(`${object.format}\n${canonical(object)}`).digest('hex') };
}
function verified(object, key) {
    requireThat(object && typeof object === 'object' && !Array.isArray(object) && sha.test(object.mac ?? ''),
        'DRIVE_SIGNATURE', 'Google 云盘仓库签名无效，未使用远端内容。');
    const { mac, ...body } = object;
    const expected = signed(body, key).mac;
    requireThat(timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex')),
        'DRIVE_SIGNATURE', 'Google 云盘仓库密钥不匹配或记录被修改，未使用远端内容。');
    return body;
}
function owned(metadata, { id, folderId, dataset, kind }) {
    requireThat(metadata?.id === id && metadata.mimeType === (kind === 'payload' ? 'application/octet-stream' : 'application/json')
        && metadata.parents?.length === 1 && metadata.parents[0] === folderId && !metadata.trashed
        && metadata.appProperties?.tavernsyn === '1' && metadata.appProperties?.repositoryId === dataset
        && metadata.appProperties?.kind === kind,
    'DRIVE_OWNERSHIP', 'Google 云盘文件不属于当前仓库，已停止操作。');
}
function headValue(record) {
    if (!record) return null;
    return { generation: record.generation, digest: record.digest, fileId: record.payloadId,
        commitId: record.commitId, nextCommitId: record.nextCommitId, archiveSha256: record.archiveSha256,
        size: record.size, sequence: record.sequence, parentCommitId: record.parentCommitId,
        dataset: record.dataset, rootId: record.rootId, folderId: record.folderId };
}
function sameBase(base, head) {
    if (base === null) return head === null;
    if (!head) return false;
    if (typeof base === 'string') return base === head.generation;
    return base && base.generation === head.generation && base.commitId === head.commitId;
}
function samePublication(record, { generation, manifestDigest, archiveSha256 }) {
    return record?.generation === generation && record.digest === manifestDigest && record.archiveSha256 === archiveSha256;
}

/** Create an empty repository. Share this descriptor, and its separate secret key, with the second device. */
export async function createRepository(api, { key } = {}) {
    keyValue(key);
    const dataset = randomUUID(), folderId = await api.createFolder('TavernSyn'), [rootId, firstCommitId] = await api.generateIds(2);
    requireThat([folderId, rootId, firstCommitId].every(validId) && new Set([folderId, rootId, firstCommitId]).size === 3,
        'DRIVE_ID', 'Google 云盘返回了重复的仓库标识。');
    const root = signed({ format: ROOT_FORMAT, rootId, folderId, dataset, firstCommitId }, key);
    try { await api.createJson(rootId, root, { parentId: folderId, kind: 'root', repositoryId: dataset }); }
    catch (error) {
        // A lost response is not permission to create another root or overwrite one.
        const actual = await api.getJson(rootId).catch(() => null);
        if (!actual || canonical(actual) !== canonical(root)) throw error;
    }
    const repository = new DriveRepository(api, { rootId, folderId, dataset, key });
    await repository.open(); return { rootId, folderId, dataset };
}

/** Immutable, signed commit chain. Pre-generated successor IDs provide create-once publication. */
export class DriveRepository {
    constructor(api, { rootId, folderId, dataset, key, anchor = null, maxCommits = 10_000 } = {}) {
        requireThat(api && validId(rootId) && (folderId === undefined || validId(folderId))
            && (dataset === undefined || uuid.test(dataset)) && Number.isInteger(maxCommits) && maxCommits > 0 && maxCommits <= 100_000,
        'DRIVE_REPOSITORY', 'Google 云盘仓库配置无效。');
        Object.assign(this, { api, rootId, folderId, dataset, key: Buffer.from(keyValue(key)), maxCommits });
        this.records = []; this.publishing = false; this.anchor = anchor;
    }
    async open() {
        if (this.root) return this;
        const root = verified(await this.api.getJson(this.rootId), this.key);
        requireThat(root.format === ROOT_FORMAT && root.rootId === this.rootId && validId(root.folderId)
            && validId(root.firstCommitId) && uuid.test(root.dataset)
            && new Set([root.rootId, root.folderId, root.firstCommitId]).size === 3
            && (this.folderId === undefined || this.folderId === root.folderId)
            && (this.dataset === undefined || this.dataset === root.dataset),
        'DRIVE_REPOSITORY', 'Google 云盘仓库标识与配对配置不一致。');
        owned(await this.api.metadata(this.rootId), { id: this.rootId, folderId: root.folderId, dataset: root.dataset, kind: 'root' });
        this.root = root; this.folderId = root.folderId; this.dataset = root.dataset; return this;
    }
    async readRecord(commitId, previous, { missing = false } = {}) {
        let raw;
        try { raw = await this.api.getJson(commitId); }
        catch (error) { if (missing && error.status === 404) return null; throw error; }
        const record = verified(raw, this.key);
        requireThat(record.format === COMMIT_FORMAT && record.rootId === this.rootId && record.folderId === this.folderId
            && record.dataset === this.dataset && record.commitId === commitId
            && record.parentCommitId === (previous?.commitId ?? this.rootId)
            && record.sequence === (previous?.sequence ?? 0) + 1
            && Number.isSafeInteger(record.sequence) && record.sequence > 0 && record.sequence < Number.MAX_SAFE_INTEGER
            && validId(record.nextCommitId) && validId(record.payloadId)
            && new Set([record.commitId, record.nextCommitId, record.payloadId, this.rootId, this.folderId]).size === 5
            && uuid.test(record.generation) && sha.test(record.digest) && sha.test(record.archiveSha256)
            && Number.isSafeInteger(record.size) && record.size > 0
            && typeof record.created === 'string' && Number.isFinite(Date.parse(record.created)),
        'DRIVE_COMMIT', 'Google 云盘提交链无效，未使用远端内容。');
        owned(await this.api.metadata(commitId), { id: commitId, folderId: this.folderId, dataset: this.dataset, kind: 'commit' });
        return record;
    }
    async head() {
        await this.open();
        if (this.anchor && !this.records.length) {
            const anchor = this.anchor;
            requireThat(validId(anchor.commitId) && Number.isSafeInteger(anchor.sequence) && anchor.sequence > 0,
                'DRIVE_ANCHOR', 'Google 云盘本地仓库位置缓存无效。');
            const raw = verified(await this.api.getJson(anchor.commitId), this.key);
            const previous = { commitId: raw.parentCommitId, sequence: raw.sequence - 1 };
            const actual = await this.readRecord(anchor.commitId, previous);
            const actualHead = headValue(actual);
            for (const field of ['generation', 'digest', 'fileId', 'commitId', 'nextCommitId', 'archiveSha256', 'size', 'sequence']) {
                requireThat(actualHead[field] === anchor[field], 'DRIVE_ANCHOR', 'Google 云盘仓库与本地已确认的位置不一致。');
            }
            requireThat(actual.sequence === 1 ? actual.parentCommitId === this.rootId : validId(actual.parentCommitId),
                'DRIVE_COMMIT', 'Google 云盘缓存提交的父记录无效。');
            this.records.push(actual); this.anchorPrevious = previous;
        }
        // Cached records are immutable and signed; revalidate the cached tip before
        // following its successor so deletion/corruption cannot silently rewind us.
        if (this.records.length) {
            const tip = this.records.at(-1), prior = this.records.at(-2) ?? this.anchorPrevious;
            const actual = await this.readRecord(tip.commitId, prior);
            requireThat(canonical(actual) === canonical(tip), 'DRIVE_COMMIT', 'Google 云盘已确认的提交被修改，已停止操作。');
        }
        const seen = new Set([this.rootId, this.folderId]);
        const generations = new Set();
        for (const record of this.records) { seen.add(record.commitId); seen.add(record.payloadId); generations.add(record.generation); }
        for (;;) {
            const previous = this.records.at(-1), slot = previous?.nextCommitId ?? this.root.firstCommitId;
            requireThat(!seen.has(slot), 'DRIVE_COMMIT', 'Google 云盘提交链存在循环或标识冲突。');
            const record = await this.readRecord(slot, previous, { missing: true });
            if (!record) return headValue(previous);
            requireThat(this.records.length < this.maxCommits, 'DRIVE_LIMIT', 'Google 云盘提交记录达到读取上限，请从已确认的位置连接或迁移到新仓库。');
            requireThat(!seen.has(record.payloadId) && !seen.has(record.nextCommitId)
                && !generations.has(record.generation), 'DRIVE_COMMIT', 'Google 云盘提交链重复使用了历史标识。');
            this.records.push(record); seen.add(record.commitId); seen.add(record.payloadId); generations.add(record.generation);
        }
    }
    async retryCleanup() {
        const current = await this.head(), maintenance = [];
        // Delete only signed, published ancestors. Unknown or in-flight uploads,
        // foreign files, commits, and the current payload are never candidates.
        let ancestor = this.records.at(-2);
        if (!ancestor && current?.sequence > 1) {
            // New publications are blocked until the previous cleanup succeeds,
            // so at most the direct predecessor can remain after a committed job.
            const raw = verified(await this.api.getJson(current.parentCommitId), this.key);
            ancestor = await this.readRecord(current.parentCommitId, { commitId: raw.parentCommitId, sequence: raw.sequence - 1 });
            requireThat(ancestor.sequence === current.sequence - 1 && ancestor.nextCommitId === current.commitId,
                'DRIVE_COMMIT', 'Google 云盘旧快照记录与当前版本不一致。');
        }
        if (ancestor) {
            try {
                let metadata;
                try { metadata = await this.api.metadata(ancestor.payloadId); }
                catch (error) { if (error.status !== 404) throw error; }
                if (!metadata) return { current, maintenance, maintenancePending: false };
                owned(metadata, { id: ancestor.payloadId, folderId: this.folderId, dataset: this.dataset, kind: 'payload' });
                requireThat(Number(metadata.size) === ancestor.size && (!metadata.sha256Checksum || metadata.sha256Checksum === ancestor.archiveSha256),
                    'DRIVE_OWNERSHIP', 'Google 云盘旧归档内容已改变，拒绝删除。');
                await this.api.deleteFile(ancestor.payloadId);
            } catch { maintenance.push('Google 云盘旧快照清理尚未完成；下一次连接可重试。'); }
        }
        return { current, maintenance, maintenancePending: maintenance.length > 0 };
    }
    async publish({ generation, manifestDigest, archiveFile, archiveSha256, base, onProgress = () => {} } = {}) {
        requireThat(!this.publishing, 'BUSY', '当前 Google 云盘仓库已有发布任务。');
        requireThat(uuid.test(generation ?? '') && sha.test(manifestDigest ?? '') && sha.test(archiveSha256 ?? '')
            && typeof archiveFile === 'string' && base !== undefined,
        'DRIVE_PUBLICATION', 'Google 云盘发布参数不完整。');
        this.publishing = true;
        try {
            const current = await this.head();
            const existing = this.records.find(record => record.generation === generation);
            if (existing) {
                requireThat(samePublication(existing, { generation, manifestDigest, archiveSha256 }), 'DRIVE_PUBLICATION', '同一任务标识不能发布不同的归档。');
                const cleanup = await this.retryCleanup();
                return { ...headValue(existing), stats: { sentBytes: 0, receivedBytes: 0 }, ...cleanup, current: cleanup.current };
            }
            requireThat(sameBase(base, current), 'REMOTE_CHANGED', 'Google 云盘仓库已由另一设备更新，请重新读取后确认方向。');
            const priorCleanup = await this.retryCleanup();
            requireThat(!priorCleanup.maintenancePending, 'DRIVE_CLEANUP', 'Google 云盘上一份旧快照尚未清理，未开始新的上传；请检查权限或稍后重试。');
            requireThat(sameBase(base, priorCleanup.current), 'REMOTE_CHANGED', 'Google 云盘仓库已由另一设备更新，请重新读取后确认方向。');
            const previous = this.records.at(-1), commitId = previous?.nextCommitId ?? this.root.firstCommitId;
            const [payloadId, nextCommitId] = await this.api.generateIds(2);
            requireThat(validId(payloadId) && validId(nextCommitId) && payloadId !== nextCommitId
                && ![this.rootId, this.folderId, commitId].includes(payloadId) && ![this.rootId, this.folderId, commitId].includes(nextCommitId),
            'DRIVE_ID', 'Google 云盘返回了重复的发布标识。');
            let uploaded;
            try {
                uploaded = await this.api.uploadFile({ id: payloadId, parentId: this.folderId, repositoryId: this.dataset, file: archiveFile, onProgress });
                requireThat(uploaded?.id === payloadId && uploaded.sha256 === archiveSha256 && Number.isSafeInteger(uploaded.size) && uploaded.size > 0,
                    'INTEGRITY', 'Google 云盘已上传归档与本次快照不一致，未发布版本。');
            } catch (error) {
                // No commit creation has been attempted, so this exact owned
                // upload cannot be referenced by a published generation.
                try {
                    owned(await this.api.metadata(payloadId), { id: payloadId, folderId: this.folderId, dataset: this.dataset, kind: 'payload' });
                    await this.api.deleteFile(payloadId);
                } catch { /* Network failure may require a later manual orphan cleanup. */ }
                throw error;
            }
            const record = signed({ format: COMMIT_FORMAT, rootId: this.rootId, folderId: this.folderId, dataset: this.dataset,
                sequence: (previous?.sequence ?? 0) + 1, parentCommitId: previous?.commitId ?? this.rootId,
                commitId, nextCommitId, payloadId, generation, digest: manifestDigest,
                archiveSha256, size: uploaded.size, created: new Date().toISOString() }, this.key);
            let published;
            try { await this.api.createJson(commitId, record, { parentId: this.folderId, kind: 'commit', repositoryId: this.dataset }); }
            catch (error) {
                // The response may be lost after commit. Only readback of this
                // exact pre-generated slot can establish ownership of publication.
                try { published = await this.readRecord(commitId, previous, { missing: true }); }
                catch { throw new SyncError('DRIVE_RESULT_UNKNOWN', 'Google 云盘提交结果尚未确认；保留上传数据，请重新连接核对。'); }
                if (!published) throw error;
            }
            if (!published) published = await this.readRecord(commitId, previous).catch(() => {
                throw new SyncError('DRIVE_RESULT_UNKNOWN', 'Google 云盘提交回执尚未确认；保留上传数据，请重新连接核对。');
            });
            if (published.payloadId !== payloadId || !samePublication(published, { generation, manifestDigest, archiveSha256 })) {
                // The immutable slot belongs to another publisher. Our known,
                // unreferenced payload can be removed; the winning one is untouched.
                try {
                    owned(await this.api.metadata(payloadId), { id: payloadId, folderId: this.folderId, dataset: this.dataset, kind: 'payload' });
                    await this.api.deleteFile(payloadId);
                } catch { /* Retain an orphan rather than endanger the winning snapshot. */ }
                throw new SyncError('REMOTE_CHANGED', '另一设备已先发布 Google 云盘版本，本次上传未覆盖它。请重新读取后确认方向。');
            }
            requireThat(canonical(published) === canonical(verified(record, this.key)), 'DRIVE_COMMIT', 'Google 云盘提交回执内容不一致。');
            this.records.push(published);
            const cleanup = await this.retryCleanup().catch(() => ({ maintenancePending: true,
                maintenance: ['Google 云盘版本已发布；旧快照清理尚待下次连接完成。'] }));
            return { ...headValue(published), stats: { sentBytes: uploaded.size, receivedBytes: 0 }, ...cleanup };
        } finally { this.publishing = false; }
    }
}
