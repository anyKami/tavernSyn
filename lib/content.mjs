import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { readJson, requireThat } from './io.mjs';

export async function enoughSpace(directory, bytes, copies = 2) {
    const usage = await fs.statfs(directory);
    const free = Number(usage.bavail) * Number(usage.bsize);
    requireThat(Number.isFinite(bytes) && bytes >= 0 && free > bytes * copies + 32 * 1024 * 1024, 'DISK_SPACE', '工作区空间不足，未开始替换。请保留下载暂存、候选和一次恢复所需空间。');
}
export async function validateContent(payload, manifest) {
    validatePayloadPaths(manifest);
    requireThat(manifest.files.some(f => f.path === 'profile/settings.json' && f.size > 2), 'EMPTY_SOURCE', '未发现有效用户设置，禁止覆盖。');
    for (const file of manifest.files) {
        const json = /^profile\/(?:settings\.json|secrets\.json|(?:worlds|groups|QuickReplies|OpenAI Settings|NovelAI Settings|KoboldAI Settings|TextGen Settings|themes|instruct|context|sysprompt|reasoning)\/.*\.json)$/.test(file.path);
        if (json) {
            try { await readJson(path.join(payload, ...file.path.split('/'))); }
            catch { requireThat(false, 'INVALID_JSON', '核心 JSON 数据无法解析，拒绝发布或应用。'); }
        }
        if (/^profile\/(chats|group chats)\/.*\.jsonl$/.test(file.path)) {
            let lines = 0;
            const stream = createReadStream(path.join(payload, ...file.path.split('/')));
            const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
            try {
                for await (const line of reader) {
                    if (!line.trim()) continue;
                    const value = JSON.parse(line);
                    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_CHAT', '聊天行格式无效。'); lines++;
                }
                requireThat(lines > 0, 'INVALID_CHAT', '聊天文件为空，拒绝应用。');
            } catch { requireThat(false, 'INVALID_CHAT', '聊天 JSONL 无法完整解析，拒绝发布或应用。'); }
            finally { reader.close(); stream.destroy(); }
        }
    }
}
export function validatePayloadPaths(manifest) {
    for (const file of manifest.files) {
        const name = file.path.toLowerCase();
        requireThat(name === 'environment.json' || /^(?:profile|extensions|server-plugins|extra)\//.test(name) || /^shared\/(?:_css|_errors)\//.test(name) || /^repositories\/\d+\/gitdata\//.test(name), 'PAYLOAD_SCOPE', '载荷包含范围以外的文件。');
        requireThat(!/^(?:extensions|server-plugins)\/tavernsyn\//.test(name) && !name.startsWith('profile/extensions/tavernsyn/') && name !== 'server-plugins/package.json', 'SELF_PROTECTION', '拒绝通过用户镜像覆盖同步插件或本机插件加载格式。');
        if (!name.startsWith('repositories/')) requireThat(!name.split('/').some(p => ['node_modules', '.git', '.ssh', '.tailscale'].includes(p)), 'PAYLOAD_SCOPE', '载荷含本机依赖或基础设施目录。');
    }
}
