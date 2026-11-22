import path from 'node:path';
import { requireThat } from '../lib/io.mjs';

export function windowsUsbLauncher({ node, repository, state }) {
    for (const value of [node, repository, state]) requireThat(typeof value === 'string' && !/["%\r\n!]/.test(value), 'INSTALL', 'USB 启动路径含批处理不支持的字符。');
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\npushd "%~dp0"\r\n"${node}" "${path.join(repository, 'bin/usb.mjs')}" --state "${state}" --mode client %*\r\nset "tavernsyn_usb_exit=%ERRORLEVEL%"\r\npopd\r\npause\r\nexit /b %tavernsyn_usb_exit%\r\n`;
}

export function termuxUsbLauncher({ node, repository, state }) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    return `#!/data/data/com.termux/files/usr/bin/sh\nexec ${quote(node)} ${quote(path.join(repository, 'bin/usb.mjs'))} --state ${quote(state)} --mode serve "$@"\n`;
}
