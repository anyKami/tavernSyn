import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { noLinks, requireThat } from '../lib/io.mjs';

// Match the complete generated v0.5.0 scripts, not just a familiar filename or
// a pause somewhere inside a user-maintained launcher. Preserve every path.
const formats = {
    'Start-TavernSyn.cmd': [
        '@echo off', 'chcp 65001 >nul', 'pushd "%~dp0"',
        'if /I "%~1"=="--desktop-shortcut" goto desktop_shortcut', 'set NODE_ENV=production',
        /^"[^"%\r\n!]+" "%~dp0TavernSyn-Startup\.mjs" --st "%~dp0\." --state "[^"%\r\n!]+" %\*$/,
        'set "tavernsyn_exit=%ERRORLEVEL%"', 'popd', 'if not "%tavernsyn_exit%"=="0" pause',
        'exit /b %tavernsyn_exit%', ':desktop_shortcut',
        /^powershell\.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "[^"%\r\n!]+[\\/]bin[\\/]create-desktop-shortcut\.ps1" -LauncherPath "%~f0"$/,
        'set "tavernsyn_exit=%ERRORLEVEL%"', 'popd', 'if not "%tavernsyn_exit%"=="0" pause',
        'exit /b %tavernsyn_exit%', '',
    ],
    'USB-TavernSyn.cmd': [
        '@echo off', 'setlocal DisableDelayedExpansion', 'chcp 65001 >nul', 'pushd "%~dp0"',
        /^"[^"%\r\n!]+" "[^"%\r\n!]+[\\/]bin[\\/]usb\.mjs" --state "[^"%\r\n!]+" --mode client %\*$/,
        'set "tavernsyn_usb_exit=%ERRORLEVEL%"', 'popd', 'pause', 'exit /b %tavernsyn_usb_exit%', '',
    ],
};

function pauseOffsets(bytes, format) {
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) return null;
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length !== format.length || lines.some((line, index) => {
        const expected = format[index];
        return typeof expected === 'string'
            ? line !== expected && !(expected.endsWith('pause') && line === expected.slice(0, -5) + 'rem  ')
            : !expected.test(line);
    })) return null;
    return [...source.matchAll(/^(?:if not "%tavernsyn_exit%"=="0" )?pause\r?$/gm)]
        .map(match => Buffer.byteLength(source.slice(0, match.index + match[0].indexOf('pause')), 'utf8'));
}

export async function refreshWindowsLaunchers({ install, platform = process.platform, log = console.log }) {
    const result = { updated: [], skipped: [] };
    if (platform !== 'win32') return result;
    const report = message => { try { log(message); } catch { /* Logging cannot prevent startup. */ } };
    for (const [name, format] of Object.entries(formats)) {
        let handle;
        try {
            const file = await noLinks(path.join(install, name)), stat = await fs.lstat(file);
            requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024, 'LAUNCHER_FILE', '启动入口不是独立普通文件。');
            handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
            const opened = await handle.stat();
            requireThat(opened.isFile() && opened.nlink === 1 && opened.dev === stat.dev && opened.ino === stat.ino,
                'LAUNCHER_FILE', '启动入口已改变。');
            const bytes = await handle.readFile();
            // Current scripts and already-migrated scripts need no rewrite.
            if (!/\bpause\s*$/m.test(bytes.toString('utf8'))) continue;
            const offsets = pauseOffsets(bytes, format);
            if (!offsets) {
                result.skipped.push(name); report(`保留自定义启动入口 ${name}：未匹配 TavernSyn 生成格式。`); continue;
            }
            // cmd.exe may be waiting inside this very file. Equal-length ASCII
            // writes keep every later byte offset stable; do not replace or
            // truncate an executing batch file, or regenerate its local paths.
            for (const offset of offsets) {
                const old = Buffer.alloc(5);
                requireThat((await handle.read(old, 0, 5, offset)).bytesRead === 5 && old.toString('ascii') === 'pause',
                    'LAUNCHER_CHANGED', '启动入口已改变。');
                requireThat((await handle.write(Buffer.from('rem  ', 'ascii'), 0, 5, offset)).bytesWritten === 5,
                    'LAUNCHER_WRITE', '启动入口未能完整写入。');
            }
            await handle.sync(); result.updated.push(name);
            report(`已移除 ${name} 的按键等待，原启动路径和退出码保持不变。`);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            result.skipped.push(name); report(`未能刷新启动入口 ${name}（${error.code ?? 'IO'}），继续启动；下次启动会重试。`);
        } finally { await handle?.close().catch(() => {}); }
    }
    return result;
}
