import fs from 'node:fs';
import path from 'node:path';

const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function createSyncLog(state, output = process.stdout) {
    const file = path.join(state, 'sync.log');
    const fd = fs.openSync(file, 'a', 0o600);
    let closed = false, fileFailed = false;
    const log = (job, message) => {
        if (closed) return;
        const direction = { push: '推送', pull: '拉取', restore: '恢复' }[job?.direction] ?? '启动器';
        const context = `${direction}${job?.id ? ` ${job.id.slice(0, 8)}` : ''}`;
        // Log stage/metadata and rsync filenames, never configuration or file contents.
        const clean = String(message).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 8192);
        const line = `[${timestamp.format(new Date())} +08:00] [TavernSyn ${context}] ${clean}\n`;
        if (!fileFailed) {
            try { fs.writeSync(fd, line); }
            catch { fileFailed = true; output?.write('TavernSyn：sync.log 写入失败，后续日志继续显示在控制台。\n'); }
        }
        output?.write(line);
    };
    log.close = () => { if (!closed) { closed = true; try { if (!fileFailed) fs.fsyncSync(fd); } catch { /* Console output remains available. */ } finally { fs.closeSync(fd); } } };
    log.file = file;
    return log;
}

export function rsyncOutputLog(log = () => {}, now = Date.now) {
    let pending = '', lastProgress = -Infinity;
    const line = value => {
        value = value.trim();
        if (!value) return;
        if (/^[\d,]+\s+\d+%/.test(value)) {
            if (now() - lastProgress < 5000) return;
            lastProgress = now();
        }
        log(`rsync: ${value}`);
    };
    return {
        write(text) {
            const lines = (pending + text).split(/\r\n|\r|\n/);
            pending = lines.pop();
            for (const value of lines) line(value);
            if (pending.length > 8192) { line(pending.slice(0, 8192)); pending = ''; }
        },
        end() { line(pending); pending = ''; },
    };
}
