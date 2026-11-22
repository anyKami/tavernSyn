import fs from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, requireThat, SyncError } from './io.mjs';
import { driveIdPattern } from './drive-api.mjs';

const ROOT_FORMAT = 'tavernsyn-drive-repository-v1';
const COMMIT_FORMAT = 'tavernsyn-drive-commit-v1';
const UPLOAD_FORMAT = 'tavernsyn-drive-upload-v1';
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
function owned(metadata, { id, folderId, dataset, kind, includeTrashed = false }) {
    requireThat(metadata?.id === id && metadata.mimeType === (kind === 'payload' ? 'application/octet-stream' : 'application/json')
        && metadata.parents?.length === 1 && metadata.parents[0] === folderId && (includeTrashed || !metadata.trashed)
        && metadata.appProperties?.tavernsyn === '1' && metadata.appProperties?.repositoryId === dataset
        && metadata.appProperties?.kind === kind,
    'DRIVE_OWNERSHIP', 'Google 云盘文件不属于当前仓库，已停止操作。');
}
function storedIntent(metadata) {
    const properties = metadata?.appProperties, count = Number(properties?.uploadIntentParts);
    if (!Number.isInteger(count) || count < 1 || count > 20) return null;
    let text = '';
    for (let index = 0; index < count; index++) {
        const part = properties[`uploadIntent${index}`];
        if (typeof part !== 'string' || !/^[\x20-\x7e]{1,100}$/.test(part)) return null;
        text += part;
    }
    try { return JSON.parse(text); } catch { return null; }
}
function processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}
function matchesArchive(metadata, proof) {
    if (Number(metadata.size) !== proof.size) return false;
    if (metadata.sha256Checksum) return metadata.sha256Checksum === proof.archiveSha256;
    return !proof.archiveMd5 || metadata.md5Checksum === proof.archiveMd5;
}
function headValue(record) {
    if (!record) return null;
    return { generation: record.generation, digest: record.digest, fileId: record.payloadId,
        commitId: record.commitId, nextCommitId: record.nextCommitId, archiveSha256: record.archiveSha256,
        size: record.size, sequence: record.sequence, parentCommitId: record.parentCommitId,
        dataset: record.dataset, rootId: record.rootId, folderId: record.folderId,
        ...(record.archiveMd5 ? { archiveMd5: record.archiveMd5 } : {}) };
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
    constructor(api, { rootId, folderId, dataset, key, anchor = null, maxCommits = 10_000,
        pendingUploads = [], savePendingUploads = async () => {}, ownerAlive = processAlive } = {}) {
        requireThat(api && validId(rootId) && (folderId === undefined || validId(folderId))
            && (dataset === undefined || uuid.test(dataset)) && Number.isInteger(maxCommits) && maxCommits > 0 && maxCommits <= 100_000,
        'DRIVE_REPOSITORY', 'Google 云盘仓库配置无效。');
        Object.assign(this, { api, rootId, folderId, dataset, key: Buffer.from(keyValue(key)), maxCommits });
        requireThat(Array.isArray(pendingUploads) && pendingUploads.length <= 1000 && typeof savePendingUploads === 'function'
            && typeof ownerAlive === 'function', 'DRIVE_JOURNAL', 'Google 云盘上传恢复记录无效。');
        this.records = []; this.publishing = false; this.anchor = anchor; this.cleanupRecords = new Map();
        this.pendingUploads = structuredClone(pendingUploads); this.savePendingUploads = savePendingUploads; this.ownerAlive = ownerAlive;
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
        this.root = root; this.folderId = root.folderId; this.dataset = root.dataset;
        try {
            const pendingIds = new Set();
            for (const entry of this.pendingUploads) {
                const intent = this.verifyIntent(entry?.intent);
                requireThat(['uploading', 'publishing', 'failed'].includes(entry.phase) && Number.isInteger(entry.ownerPid)
                    && entry.ownerPid > 0 && entry.ownerPid <= 0x7fffffff && !pendingIds.has(intent.payloadId),
                'DRIVE_JOURNAL', 'Google 云盘上传恢复记录无效。');
                pendingIds.add(intent.payloadId);
            }
        } catch (error) { this.root = null; throw error; }
        return this;
    }
    verifyIntent(raw) {
        const intent = verified(raw, this.key);
        requireThat(intent.format === UPLOAD_FORMAT && intent.rootId === this.rootId && intent.folderId === this.folderId
            && intent.dataset === this.dataset && uuid.test(intent.generation) && validId(intent.payloadId)
            && validId(intent.commitId) && validId(intent.parentCommitId) && sha.test(intent.archiveSha256)
            && Number.isSafeInteger(intent.size) && intent.size > 0 && Number.isSafeInteger(intent.sequence) && intent.sequence > 0
            && new Set([intent.payloadId, intent.commitId, this.rootId, this.folderId]).size === 4
            && (intent.sequence !== 1 || (intent.parentCommitId === this.rootId && intent.commitId === this.root.firstCommitId)),
        'DRIVE_UPLOAD', 'Google 云盘上传归属记录与当前仓库不一致。');
        return intent;
    }
    async saveUpload(intent, phase) {
        this.verifyIntent(intent);
        requireThat(['uploading', 'publishing', 'failed'].includes(phase), 'DRIVE_JOURNAL', 'Google 云盘上传阶段无效。');
        const previous = this.pendingUploads.find(entry => entry.intent.payloadId === intent.payloadId);
        const entry = { intent, phase, ownerPid: previous?.ownerPid ?? process.pid };
        const next = [...this.pendingUploads.filter(item => item.intent.payloadId !== intent.payloadId), entry];
        requireThat(next.length <= 1000, 'DRIVE_JOURNAL', '未完成的云盘上传记录过多，请先连接仓库完成清理。');
        await this.savePendingUploads(next); this.pendingUploads = next;
    }
    async forgetUpload(payloadId) {
        if (!this.pendingUploads.some(entry => entry.intent.payloadId === payloadId)) return;
        const next = this.pendingUploads.filter(entry => entry.intent.payloadId !== payloadId);
        await this.savePendingUploads(next); this.pendingUploads = next;
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
            && (record.archiveMd5 === undefined || /^[a-f0-9]{32}$/.test(record.archiveMd5))
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
    async cleanupRecord(commitId) {
        for (const record of this.records) this.cleanupRecords.set(record.commitId, record);
        if (this.cleanupRecords.has(commitId)) return this.cleanupRecords.get(commitId);
        const raw = verified(await this.api.getJson(commitId), this.key);
        const record = await this.readRecord(commitId, { commitId: raw.parentCommitId, sequence: raw.sequence - 1 });
        this.cleanupRecords.set(commitId, record); return record;
    }
    async parentRecord(child) {
        if (child.sequence === 1) {
            requireThat(child.parentCommitId === this.rootId && child.commitId === this.root.firstCommitId,
                'DRIVE_COMMIT', 'Google 云盘初始提交与仓库不一致。');
            return null;
        }
        const parent = await this.cleanupRecord(child.parentCommitId);
        requireThat(parent.sequence === child.sequence - 1 && parent.nextCommitId === child.commitId,
            'DRIVE_COMMIT', 'Google 云盘旧快照记录与当前版本不一致。');
        return parent;
    }
    async ancestorOf(record, current) {
        if (!current || record.sequence > current.sequence) return false;
        let cursor = current;
        for (let steps = 0; cursor?.sequence > record.sequence; steps++) {
            requireThat(steps < this.maxCommits, 'DRIVE_LIMIT', 'Google 云盘旧记录检查达到读取上限，未继续删除。');
            cursor = await this.parentRecord(cursor);
        }
        return cursor?.commitId === record.commitId && canonical(cursor) === canonical(record);
    }
    async intentSlot(intent) {
        if (intent.sequence > 1) {
            const parent = await this.cleanupRecord(intent.parentCommitId);
            requireThat(parent.sequence === intent.sequence - 1 && parent.nextCommitId === intent.commitId,
                'DRIVE_UPLOAD', 'Google 云盘上传任务不属于声明的提交槽位。');
        }
        return this.readRecord(intent.commitId, { commitId: intent.parentCommitId, sequence: intent.sequence - 1 }, { missing: true });
    }
    failedUpload(entry) {
        return entry?.phase === 'failed' || (entry?.phase === 'uploading' && !this.ownerAlive(entry.ownerPid));
    }
    async removeUpload(intent) {
        // This is called only when this operation has not attempted publication,
        // or when an immutable competing commit proves this upload cannot win.
        const metadata = await this.api.metadata(intent.payloadId, { includeTrashed: true }).catch(error => {
            if (error.status === 404) return null; throw error;
        });
        if (metadata) {
            owned(metadata, { id: intent.payloadId, folderId: this.folderId, dataset: this.dataset, kind: 'payload', includeTrashed: true });
            const actual = this.verifyIntent(storedIntent(metadata));
            requireThat(canonical(actual) === canonical(verified(intent, this.key)), 'DRIVE_UPLOAD', '云盘待删除上传的归属记录已改变。');
            await this.api.deleteFile(intent.payloadId);
            await this.forgetUpload(intent.payloadId);
            return;
        }
        // An upload whose response was lost can materialize after this 404.
        // Keep the tiny failed intent until its slot is decided or the actual
        // object has been observed and deleted; otherwise a late file is orphaned.
        if (await this.intentSlot(verified(intent, this.key))) await this.forgetUpload(intent.payloadId);
    }
    async retryCleanup() {
        const current = await this.head(), currentRecord = this.records.at(-1), maintenance = [];
        let maintenancePending = false, deletedSnapshots = 0, retainedUnconfirmed = 0;
        const warn = () => {
            maintenancePending = true;
            const message = 'Google 云盘旧快照或失败上传尚未清理；下次连接或核对结果时会重试。';
            if (!maintenance.includes(message)) maintenance.push(message);
        };
        const files = new Map(), proofs = new Map(), intents = new Map();
        try {
            for (const file of await this.api.list({ parentId: this.folderId, kind: 'payload', repositoryId: this.dataset, includeTrashed: true })) {
                files.set(file.id, file);
            }
        } catch { warn(); return { current, maintenance, maintenancePending, deletedSnapshots, retainedUnconfirmed }; }
        // A just-completed object may not yet be present in files.list. Add the
        // exact predecessor and pending upload IDs using direct reads as well.
        const extraIds = new Set(this.pendingUploads.map(entry => entry.intent.payloadId));
        try { const parent = currentRecord ? await this.parentRecord(currentRecord) : null; if (parent) extraIds.add(parent.payloadId); }
        catch { warn(); }
        for (const fileId of extraIds) {
            if (files.has(fileId)) continue;
            try { files.set(fileId, await this.api.metadata(fileId, { includeTrashed: true })); }
            catch (error) {
                if (error.status !== 404) { warn(); continue; }
                const pending = this.pendingUploads.find(entry => entry.intent.payloadId === fileId);
                if (!pending) continue;
                try {
                    const intent = this.verifyIntent(pending.intent), slot = await this.intentSlot(intent);
                    if (slot) await this.forgetUpload(fileId);
                } catch { warn(); }
            }
        }
        const legacy = new Set();
        for (const [fileId, metadata] of files) {
            if (fileId === current?.fileId) {
                const pending = this.pendingUploads.find(entry => entry.intent.payloadId === fileId);
                if (pending && pending.intent.generation === current.generation && pending.intent.archiveSha256 === current.archiveSha256) {
                    try { await this.forgetUpload(fileId); } catch { warn(); }
                }
                continue;
            }
            try { owned(metadata, { id: fileId, folderId: this.folderId, dataset: this.dataset, kind: 'payload', includeTrashed: true }); }
            catch { warn(); continue; }
            try {
                const intent = this.verifyIntent(storedIntent(metadata));
                requireThat(intent.payloadId === fileId, 'DRIVE_UPLOAD', 'Google 云盘上传归属标识不一致。');
                intents.set(fileId, intent);
            } catch { legacy.add(fileId); }
        }
        // Existing 0.4 repositories have no upload intent. Only their signed,
        // reachable published commits can authorize removal of old full copies.
        if (legacy.size && currentRecord) {
            let cursor = currentRecord;
            try {
                for (let steps = 0; cursor && legacy.size; steps++) {
                    requireThat(steps < this.maxCommits, 'DRIVE_LIMIT', 'Google 云盘历史快照检查达到上限。');
                    if (cursor.commitId !== currentRecord.commitId && legacy.has(cursor.payloadId)) {
                        proofs.set(cursor.payloadId, cursor); legacy.delete(cursor.payloadId);
                    }
                    cursor = await this.parentRecord(cursor);
                }
            } catch { warn(); }
        }
        retainedUnconfirmed += legacy.size;
        for (const [fileId, intent] of intents) {
            try {
                const slot = await this.intentSlot(intent), pending = this.pendingUploads.find(entry => entry.intent.payloadId === fileId);
                if (slot && slot.payloadId !== fileId) {
                    // A different immutable winner makes this upload permanently
                    // unpublishable, even if its original process is still alive.
                    proofs.set(fileId, intent);
                } else if (slot && slot.sequence < (currentRecord?.sequence ?? 0) && await this.ancestorOf(slot, currentRecord)) {
                    proofs.set(fileId, slot);
                } else if (!slot && this.failedUpload(pending)) {
                    proofs.set(fileId, intent);
                } else { retainedUnconfirmed++; }
            } catch { warn(); retainedUnconfirmed++; }
        }
        let checkedCurrent = false;
        for (const [fileId, proof] of proofs) {
            try {
                if (fileId === current?.fileId) continue;
                // Never consume the last usable cloud copy when the announced
                // current archive is missing, trashed, or visibly corrupted.
                if (current && !checkedCurrent) {
                    const live = await this.api.metadata(current.fileId);
                    owned(live, { id: current.fileId, folderId: this.folderId, dataset: this.dataset, kind: 'payload' });
                    requireThat(matchesArchive(live, current),
                    'DRIVE_INTEGRITY', 'Google 云盘当前归档未通过校验，保留旧副本。');
                    checkedCurrent = true;
                }
                const metadata = await this.api.metadata(fileId, { includeTrashed: true }).catch(error => {
                    if (error.status === 404) return null; throw error;
                });
                if (metadata) {
                    owned(metadata, { id: fileId, folderId: this.folderId, dataset: this.dataset, kind: 'payload', includeTrashed: true });
                    if (proof.format === UPLOAD_FORMAT) {
                        // A proven failed/losing upload may have only partial or
                        // corrupt bytes. Its signed ownership, not completeness,
                        // authorizes removal; it can never be the active backup.
                        const actual = this.verifyIntent(storedIntent(metadata));
                        requireThat(canonical(actual) === canonical(proof), 'DRIVE_UPLOAD', '云盘待删除上传的归属记录已改变。');
                    } else requireThat(matchesArchive(metadata, proof),
                        'DRIVE_OWNERSHIP', 'Google 云盘旧归档内容已改变，拒绝删除。');
                    await this.api.deleteFile(fileId); deletedSnapshots++;
                }
                await this.forgetUpload(fileId);
            } catch { warn(); }
        }
        if (retainedUnconfirmed) maintenance.push(`Google 云盘保留了 ${retainedUnconfirmed} 个仍在途或归属尚未确认的上传；不会猜测删除。`);
        return { current, maintenance, maintenancePending, deletedSnapshots, retainedUnconfirmed };
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
                const cleanup = await this.retryCleanup().catch(() => ({ maintenancePending: true,
                    maintenance: ['Google 云盘发布已确认；旧快照清理尚待下次连接完成。'] }));
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
            const archiveSize = (await fs.stat(archiveFile)).size;
            const intent = signed({ format: UPLOAD_FORMAT, rootId: this.rootId, folderId: this.folderId, dataset: this.dataset,
                sequence: (previous?.sequence ?? 0) + 1, parentCommitId: previous?.commitId ?? this.rootId,
                commitId, payloadId, generation, archiveSha256, size: archiveSize }, this.key);
            await this.saveUpload(intent, 'uploading'); // Durable before sending any archive bytes.
            let uploaded;
            try {
                uploaded = await this.api.uploadFile({ id: payloadId, parentId: this.folderId, repositoryId: this.dataset,
                    file: archiveFile, uploadIntent: intent, onProgress });
                requireThat(uploaded?.id === payloadId && uploaded.sha256 === archiveSha256 && uploaded.size === archiveSize && Number.isSafeInteger(uploaded.size) && uploaded.size > 0,
                    'INTEGRITY', 'Google 云盘已上传归档与本次快照不一致，未发布版本。');
            } catch (error) {
                // No commit creation has been attempted, so this exact owned
                // upload cannot be referenced by a published generation.
                await this.saveUpload(intent, 'failed').catch(() => {});
                await this.removeUpload(intent).catch(() => {});
                const winner = await this.intentSlot(intent).catch(() => null);
                if (winner && winner.payloadId !== payloadId) throw new SyncError('REMOTE_CHANGED', '另一设备已先发布 Google 云盘版本，本次上传未覆盖它。');
                throw error;
            }
            const record = signed({ format: COMMIT_FORMAT, rootId: this.rootId, folderId: this.folderId, dataset: this.dataset,
                sequence: (previous?.sequence ?? 0) + 1, parentCommitId: previous?.commitId ?? this.rootId,
                commitId, nextCommitId, payloadId, generation, digest: manifestDigest,
                archiveSha256, ...(uploaded.md5Checksum ? { archiveMd5: uploaded.md5Checksum } : {}),
                size: uploaded.size, created: new Date().toISOString() }, this.key);
            try { await this.saveUpload(intent, 'publishing'); }
            catch (error) {
                // Publication has not been attempted if this durable phase write fails.
                await this.saveUpload(intent, 'failed').catch(() => {});
                await this.removeUpload(intent).catch(() => {}); throw error;
            }
            let published;
            try { await this.api.createJson(commitId, record, { parentId: this.folderId, kind: 'commit', repositoryId: this.dataset }); }
            catch (error) {
                // The response may be lost after commit. Only readback of this
                // exact pre-generated slot can establish ownership of publication.
                try { published = await this.readRecord(commitId, previous, { missing: true }); }
                catch { throw new SyncError('DRIVE_RESULT_UNKNOWN', 'Google 云盘提交结果尚未确认；保留上传数据，请重新连接核对。'); }
                if (!published) {
                    if ([400, 401, 403, 404, 413, 422].includes(error.status)) {
                        await this.saveUpload(intent, 'failed').catch(() => {});
                        await this.removeUpload(intent).catch(() => {}); throw error;
                    }
                    throw new SyncError('DRIVE_RESULT_UNKNOWN', 'Google 云盘提交结果尚未确认；保留上传数据和恢复记录，请重新连接核对。');
                }
            }
            if (!published) published = await this.readRecord(commitId, previous).catch(() => {
                throw new SyncError('DRIVE_RESULT_UNKNOWN', 'Google 云盘提交回执尚未确认；保留上传数据，请重新连接核对。');
            });
            if (published.payloadId !== payloadId || !samePublication(published, { generation, manifestDigest, archiveSha256 })) {
                // The immutable slot belongs to another publisher. Our known,
                // unreferenced payload can be removed; the winning one is untouched.
                await this.saveUpload(intent, 'failed').catch(() => {});
                await this.removeUpload(intent).catch(() => {});
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
