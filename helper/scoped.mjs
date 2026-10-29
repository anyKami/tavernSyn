import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, exists, readJson, requireThat } from '../lib/io.mjs';
import { copyTree, verify, validateManifest } from '../lib/manifest.mjs';
import { snapshot, portableState, stateFromFiles } from '../lib/snapshot.mjs';
import { validateContent } from '../lib/content.mjs';
import { normalizeScope, sameScope, inScope, scopeLabel } from '../lib/scope.mjs';
import { prepare, buildPlan, applyPlan, rollback, commitPlan, retireRecovery } from './apply.mjs';

function selectedMetadata(metadata, scope, manifest) {
    requireThat(sameScope(metadata.scope, scope) && Array.isArray(metadata.sourceState?.files)
        && metadata.sourceState.files.every(file => inScope(file.path, scope))
        && metadata.plugins?.length === 0 && metadata.extraRoots?.length === 0 && Object.keys(metadata.config ?? {}).length === 0
        && stateFromFiles(metadata.sourceState.files, metadata).digest === metadata.sourceState.digest,
    'PAYLOAD_SCOPE', '所选类别的来源清单不完整或范围不一致。');
    if (manifest) requireThat(JSON.stringify(metadata.sourceState.files.map(file => file.path).sort())
        === JSON.stringify(manifest.files.filter(file => file.path !== 'environment.json').map(file => file.path).sort()),
    'PAYLOAD_SCOPE', '来源状态与分类文件清单不匹配。');
    return metadata;
}
function catalogMetadata(remote, scope) {
    const manifest = validateManifest(remote.manifest);
    const environment = manifest.files.find(file => file.path === 'environment.json');
    requireThat(sameScope(remote.scope, scope) && typeof remote.environment === 'string'
        && environment?.sha256 === createHash('sha256').update(remote.environment).digest('hex')
        && /^[a-f0-9]{64}$/.test(remote.digest ?? ''), 'REMOTE_PROTOCOL', 'VPS 分类目录摘要无效。');
    return selectedMetadata(JSON.parse(remote.environment), scope, manifest);
}
function difference(before, after) {
    const entries = state => { const executables = new Set(state.executables ?? []); return new Map(state.files.map(file => [file.path, `${file.sha256}:${executables.has(file.path)}`])); };
    const a = entries(before), b = entries(after);
    return { added: [...b.keys()].filter(name => !a.has(name)).length, changed: [...b.keys()].filter(name => a.has(name) && a.get(name) !== b.get(name)).length,
        deleted: [...a.keys()].filter(name => !b.has(name)).length, files: b.size };
}
const zero = () => ({ sentBytes: 0, receivedBytes: 0, literalBytes: 0, matchedBytes: 0, transferredFiles: 0 });

export async function executeScoped(manager) {
    const m = manager, scope = normalizeScope(m.job.scope), device = m.device;
    const root = path.join(device.state, 'jobs', m.job.id), payload = path.join(root, 'payload');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const inventory = () => portableState(device, { scope });
    const session = m.pendingSource ? null : await m.transport.connect(device, undefined, m.log);
    let remoteBegun = false;
    const onBegin = async () => { remoteBegun = true; await m.write(m.job.phase, { remoteJob: m.job.id }); };
    try {
        let remote, metadata, local;
        if (!m.pendingSource && !m.resumeSource) {
            remote = await m.transport.catalog(session, device, scope);
            metadata = catalogMetadata(remote, scope);
            session.hello.current = { generation: remote.generation, digest: remote.digest };
            await m.write('PREFLIGHT', { connection: m.connectionId(), remoteBase: session.hello.current,
                note: `本次仅同步${scopeLabel(scope)}，包含删除；其他类别、配置及插件保持不变。` });
            local = await inventory();
            const summary = m.job.direction === 'push' ? difference(metadata.sourceState, local) : difference(local, metadata.sourceState);
            await m.write('PREFLIGHT', { summary });
            if (m.job.preview) { await m.write('PREVIEW', { summary, remote: session.hello.current }); return; }
            if (local.digest === metadata.sourceState.digest) {
                const latest = await m.transport.catalog(session, device, scope);
                const current = catalogMetadata(latest, scope);
                if (current.sourceState.digest === local.digest && (await inventory()).digest === local.digest) {
                    await m.success(local, { generation: latest.generation, digest: latest.digest }, zero(), { noChanges: true });
                    return;
                }
                // Re-run with the newer pinned catalog; never skip a concurrent publication.
                remote = latest; metadata = current;
                session.hello.current = { generation: latest.generation, digest: latest.digest };
            }
        }
        if (m.job.direction === 'push') {
            let frozen;
            if (m.resumeSource) {
                requireThat(session.hello.current?.generation === m.job.id || session.hello.current?.digest === m.resumeSource.remoteBase?.digest,
                    'REMOTE_CHANGED', 'VPS 已发布其他数据，请重新预览所选类别后推送。');
                const manifest = validateManifest(await readJson(path.join(root, 'manifest.json')));
                requireThat(manifest.digest === m.resumeSource.snapshotDigest, 'MANIFEST', '原分类快照与中断记录不符。');
                await verify(payload, manifest); await validateContent(payload, manifest, { scope });
                frozen = { manifest, metadata: selectedMetadata(await readJson(path.join(payload, 'environment.json')), scope, manifest) };
            } else {
                local = await inventory();
                const summary = difference(metadata.sourceState, local);
                await m.write('PREFLIGHT', { summary });
                const approved = await m.confirm(`仅以本机为准更新 VPS 的${scopeLabel(scope)}，包含上面列出的删除。其他内容保持不变。`, local, remote.digest, metadata.sourceState);
                await m.saveAndStop();
                try {
                    requireThat((await inventory()).digest === approved, 'LOCAL_CHANGED', '确认后所选内容有更新，请重新预览确认；未发布。');
                    await m.write('SNAPSHOT'); frozen = await snapshot(device, payload, { scope });
                    requireThat(frozen.metadata.sourceState.digest === approved, 'LOCAL_CHANGED', '创建快照期间所选数据发生变化，未上传。');
                } finally { if (m.lifecycle.stopped) { await m.write('STARTING'); await m.lifecycle.start(); } else await m.lifecycle.resume(); }
                await atomicJson(path.join(root, 'manifest.json'), frozen.manifest);
            }
            await m.write('UPLOADING', { snapshotReady: true, snapshotDigest: frozen.manifest.digest, files: frozen.manifest.files.length, bytes: frozen.manifest.bytes });
            const published = await m.transport.push(session, device, m.job.id, payload, frozen.manifest, m.progress, onBegin, { scope, onPlan: m.confirmTransfer });
            remoteBegun = false;
            await m.success(frozen.metadata.sourceState, { generation: published.generation, digest: published.digest, snapshotDigest: published.snapshotDigest,
                ...(published.maintenance?.length ? { maintenance: published.maintenance } : {}) }, published.stats);
            return;
        }
        await m.write('DOWNLOADING');
        let downloaded;
        if (m.pendingSource) {
            const old = m.pendingSource;
            requireThat(sameScope(old.scope, scope) && old.connection === m.connectionId(), 'PAYLOAD_SCOPE', '待应用任务的范围或连接已改变。');
            const manifest = validateManifest(await readJson(path.join(old.jobRoot, 'manifest.json')));
            const record = await readJson(path.join(old.jobRoot, 'download.json'));
            requireThat(manifest.digest === old.remote.snapshotDigest && record.format === 1 && record.job === old.id
                && record.dataset === device.remote.dataset && record.generation === old.remote.generation
                && record.digest === manifest.digest && record.publicationDigest === old.remote.digest && sameScope(record.scope, scope),
            'DOWNLOAD_BINDING', '待应用下载与原任务、VPS 或摘要不匹配，未应用。');
            await verify(path.join(old.jobRoot, 'payload'), manifest);
            await copyTree(path.join(old.jobRoot, 'payload'), payload);
            await atomicJson(path.join(root, 'manifest.json'), manifest);
            downloaded = { generation: old.remote.generation, digest: old.remote.digest, manifest, stats: old.stats };
        } else downloaded = await m.transport.pull(session, device, m.job.id, payload, m.progress, onBegin, { scope, onPlan: m.confirmTransfer });
        remoteBegun = false;
        await verify(payload, downloaded.manifest); await validateContent(payload, downloaded.manifest, { scope });
        metadata = selectedMetadata(await readJson(path.join(payload, 'environment.json')), scope, downloaded.manifest);
        remote = { generation: downloaded.generation, digest: downloaded.digest, snapshotDigest: downloaded.manifest.digest };
        await m.write('VERIFYING', { files: downloaded.manifest.files.length, bytes: downloaded.manifest.bytes, stats: downloaded.stats, remote });
        if (!m.lifecycle) {
            await m.write('PENDING_APPLY', { jobRoot: root, remote, reason: '分类数据已下载并校验；请从受控入口启动后继续确认和应用。' });
            return;
        }
        await m.write('PREPARING');
        const prepared = await prepare(device, payload, downloaded.manifest, root, { scope });
        local = await inventory();
        await m.write('PREPARING', { summary: difference(local, metadata.sourceState) });
        const approved = await m.confirm(`仅以 VPS 为准替换本机的${scopeLabel(scope)}，包含上面列出的删除。应用前保留一次恢复副本，其他内容保持不变。`, local, remote.digest, metadata.sourceState);
        await m.saveAndStop();
        requireThat((await inventory()).digest === approved, 'LOCAL_CHANGED', '确认后所选数据发生变化，保留下载，请重新确认。');
        await retireRecovery(device);
        m.plan = await buildPlan(device, prepared, root);
        await m.write('APPLYING'); await applyPlan(device, m.plan);
        const applied = await inventory();
        await m.write('STARTING'); await m.lifecycle.start();
        m.plan.completion = m.makeOutcome(applied, remote, downloaded.stats);
        await commitPlan(device, m.plan); await m.success(applied, remote, downloaded.stats, { outcome: m.plan.completion });
    } catch (error) {
        if (m.plan && !['committed', 'rolled-back'].includes(m.plan.phase)) {
            await m.write('ROLLING_BACK');
            if (!m.lifecycle.stopped) await m.lifecycle.stop();
            await rollback(device, m.plan); await m.lifecycle.start();
        } else if (m.lifecycle?.stopped) await m.lifecycle.start();
        throw error;
    } finally {
        if (remoteBegun) await m.write(m.job.phase, { note: '分类同步中断，已保存的暂存文件保留，可继续原上传或重新发起拉取。' }).catch(() => {});
        session?.control.close();
        if (m.lifecycle && !m.lifecycle.stopped && ['AWAITING_SAVE', 'WAITING_PAGE', 'QUIESCING'].includes(m.job.phase)) await m.lifecycle.resume().catch(() => {});
    }
}
