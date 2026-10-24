import { run, requireThat } from '../lib/io.mjs';

export function browserCommand(origin, platform = process.platform) {
    const url = new URL(origin);
    requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash, 'BROWSER', '浏览器只自动打开本机酒馆地址。');
    if (platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(`Start-Process -FilePath '${url.href}'`, 'utf16le').toString('base64')] };
    if (platform === 'darwin') return { file: 'open', args: [url.href] };
    return { file: process.env.PREFIX?.includes('com.termux') ? 'termux-open-url' : 'xdg-open', args: [url.href] };
}

export async function openBrowser(origin, execute = run) {
    const { file, args } = browserCommand(origin);
    await execute(file, args);
}
