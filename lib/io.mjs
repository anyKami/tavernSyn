import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(condition, code, message) {
    if (!condition) throw new SyncError(code, message);
}
export const exists = async file => !!await fs.lstat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export async function renamePath(source, target) {
    // Windows readers/antivirus can briefly deny replacement. Never unlink the valid target.
    for (let attempt = 0; ; attempt++) {
        try { await fs.rename(source, target); return; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 15) throw error;
            await delay(Math.min(20 * (attempt + 1), 150));
        }
    }
}
export async function atomicJson(file, value, { io = fs, rename = renamePath } = {}) {
    await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    let created = false, renamed = false;
    try {
        const handle = await io.open(temp, 'wx', 0o600); created = true;
        try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file); renamed = true;
        // Windows does not support opening directories for fsync in the same way.
        if (process.platform !== 'win32') {
            const dir = await io.open(path.dirname(file), 'r');
            try { await dir.sync(); } finally { await dir.close(); }
        }
    } catch (error) {
        if (created && !renamed) await io.unlink(temp).catch(() => {});
        // Callers at a transaction boundary must distinguish a failed directory
        // fsync from a replacement that never happened.
        if (renamed) error.atomicCommitted = true;
        throw error;
    }
}
export function inside(parent, child, allowEqual = false) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (allowEqual || relative !== '') && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export async function noLinks(file) {
    requireThat(process.platform !== 'win32' || !/^[\\/]{2}/.test(file), 'UNSAFE_PATH', '不支持 UNC 或设备命名空间路径。');
    const absolute = path.resolve(file);
    let cursor = path.parse(absolute).root;
    for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        const stat = await fs.lstat(cursor).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (!stat) break;
        requireThat(!stat.isSymbolicLink(), 'UNSAFE_PATH', '路径含链接或目录联接，已停止操作。');
    }
    return absolute;
}
export async function removeOwned(root, target) {
    requireThat(inside(root, target), 'UNSAFE_PATH', '拒绝删除工作区以外的目录。');
    await noLinks(root); await noLinks(target);
    await fs.rm(target, { recursive: true, force: true });
}
export function run(executable, args, { cwd, input, env, onOutput, maxBytes = 8 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        let stdout = '', stderr = '', overflow = false;
        const collect = (chunk, error) => {
            const text = chunk.toString(); onOutput?.(text);
            if (error) stderr = (stderr + text).slice(-maxBytes);
            else if (stdout.length + text.length > maxBytes) overflow = true;
            else stdout += text;
        };
        child.stdout.on('data', c => collect(c, false)); child.stderr.on('data', c => collect(c, true));
        child.on('error', () => reject(new SyncError('DEPENDENCY', `无法启动 ${path.basename(executable)}，请检查依赖。`)));
        child.stdin.on('error', () => {});
        child.once('close', code => code === 0 && !overflow ? resolve({ stdout, stderr }) : reject(new SyncError('PROCESS_FAILED', `${path.basename(executable)} 未成功完成（${code ?? '未启动'}）。详细输出保留在本机；未发布或应用数据。`)));
        child.stdin.end(input);
    });
}
export function cliOptions(argv = process.argv.slice(2)) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        requireThat(/^--[a-z-]+$/.test(argv[i]) && i + 1 < argv.length, 'ARGUMENT', '参数格式应为 --名称 值。');
        result[argv[i].slice(2)] = argv[++i];
    }
    return result;
}
