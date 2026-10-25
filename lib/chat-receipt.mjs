import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { canonical, requireThat } from './io.mjs';

// Same canonical { messages, metadata } digest as the browser, retaining only
// one JSONL message at a time. The raw file hash comes from the very same read.
export async function chatReceipt(file) {
    const before = await fs.stat(file);
    const raw = createHash('sha256'), content = createHash('sha256');
    const input = createReadStream(file);
    input.on('data', chunk => raw.update(chunk));
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let first = true, messages = 0, metadata = {};
    content.update('{"messages":[');
    try {
        for await (const line of reader) {
            if (!line) continue;
            const value = JSON.parse(line);
            if (first) { metadata = value?.chat_metadata ?? {}; first = false; }
            else { if (messages++) content.update(','); content.update(canonical(value)); }
        }
    } catch (error) {
        requireThat(!(error instanceof SyntaxError), 'SAVE_PENDING', '聊天文件正在写入或格式无效，请等待保存完成。');
        throw error;
    } finally { reader.close(); input.destroy(); }
    const after = await fs.stat(file);
    requireThat(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
        && before.ino === after.ino, 'SAVE_PENDING', '聊天在核对期间发生变化，请重新保存。');
    content.update('],"metadata":'); content.update(canonical(metadata)); content.update('}');
    return { digest: content.digest('hex'), sha256: raw.digest('hex') };
}
