// Optional portable MSYS2 client runtime. Does not modify PATH or install a service.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson, cliOptions, exists, inside, readJson, requireThat, run, removeOwned } from '../lib/io.mjs';

const REPOSITORY = 'https://repo.msys2.org/msys/x86_64/';
async function download(url, target, expected) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    requireThat(response.ok, 'DOWNLOAD', '无法从 MSYS2 官方仓库下载依赖。');
    const hash = createHash('sha256'), file = await fs.open(target, 'wx', 0o600);
    try { for await (const chunk of response.body) { hash.update(chunk); await file.write(chunk); } await file.sync(); }
    finally { await file.close(); }
    const sha256 = hash.digest('hex');
    requireThat(!expected || sha256 === expected, 'CHECKSUM', 'MSYS2 包摘要与仓库元数据不同，未安装或执行它。');
    return sha256;
}
export async function windowsRuntime(destination) {
    requireThat(process.platform === 'win32' && destination && path.isAbsolute(destination), 'RUNTIME', '请在 Windows 提供 --destination 完整路径。');
    requireThat(!await exists(destination), 'RUNTIME', '运行库目标必须是新目录，不能覆盖现有 MSYS2 或 Git。');
    const work = `${destination}.download-${randomUUID()}`; await fs.mkdir(work, { recursive: true });
    const db = path.join(work, 'msys.db'); await download(REPOSITORY + 'msys.db', db);
    const metadata = path.join(work, 'metadata'); await fs.mkdir(metadata);
    await run('tar', ['-xf', db, '-C', metadata]);
    const packages = new Map(), provides = new Map();
    for (const folder of await fs.readdir(metadata)) {
        const desc = await fs.readFile(path.join(metadata, folder, 'desc'), 'utf8');
        const fields = {};
        for (const match of desc.matchAll(/%([A-Z0-9]+)%\n([\s\S]*?)(?:\n\n|$)/g)) fields[match[1]] = match[2].trim().split('\n');
        const name = fields.NAME?.[0];
        if (name) { packages.set(name, fields); for (const alias of fields.PROVIDES ?? []) provides.set(alias.split(/[<>=]/)[0], name); }
    }
    const needed = new Set();
    function add(name) {
        name = name.split(/[<>=]/)[0]; if (!packages.has(name)) name = provides.get(name);
        requireThat(name && packages.has(name), 'RUNTIME', 'MSYS2 依赖解析失败，请使用官方完整安装器。');
        if (needed.has(name)) return; needed.add(name);
        for (const dependency of packages.get(name).DEPENDS ?? []) add(dependency);
    }
    add('msys2-runtime'); add('rsync'); add('openssh'); add('bash');
    // Stage all verified files. No package .INSTALL scripts are run by this portable bootstrap.
    const staged = path.join(work, 'runtime'); await fs.mkdir(staged);
    const receipt = [];
    for (const name of needed) {
        const pkg = packages.get(name), filename = pkg.FILENAME?.[0], sha256 = pkg.SHA256SUM?.[0];
        requireThat(/^[A-Za-z0-9_.+-]+\.pkg\.tar\.(?:zst|xz)$/.test(filename) && /^[a-f0-9]{64}$/.test(sha256), 'RUNTIME', '仓库包名称或摘要无效。');
        const archive = path.join(work, filename); console.log(`正在准备 MSYS2 ${name}…`);
        await download(REPOSITORY + filename, archive, sha256);
        const entries = (await run('tar', ['-tf', archive])).stdout.split(/\r?\n/).filter(Boolean);
        requireThat(entries.every(entry => !entry.startsWith('/') && !entry.includes('\\') && !entry.split('/').includes('..')), 'RUNTIME', '包中含越界路径。');
        // Only runtime binaries and official license files; executable package hooks are not extracted.
        const selected = entries.filter(entry => /^(?:usr\/bin\/[^/]+|usr\/share\/licenses\/.*)$/.test(entry) && !entry.endsWith('/'));
        if (selected.length) await run('tar', ['-xf', archive, '-C', staged, ...selected]);
        receipt.push({ name, version: pkg.VERSION?.[0], filename, sha256 });
    }
    for (const binary of ['rsync.exe', 'ssh.exe', 'sh.exe', 'cygpath.exe', 'msys-2.0.dll']) requireThat(await exists(path.join(staged, 'usr/bin', binary)), 'RUNTIME', '运行库文件不完整。');
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(staged, destination);
    await atomicJson(path.join(destination, 'packages.json'), { source: REPOSITORY, trust: 'HTTPS official repository metadata plus per-package SHA256; not detached PGP verification', packages: receipt });
    const tools = { rsync: path.join(destination, 'usr/bin/rsync.exe'), ssh: path.join(destination, 'usr/bin/ssh.exe') };
    await run(tools.rsync, ['--version']); await run(tools.ssh, ['-V']);
    await removeOwned(path.dirname(destination), work);
    console.log('便携运行库已准备完成。原系统 PATH 和 Git 未修改。');
    return tools;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    (async () => {
        const options = cliOptions(), tools = await windowsRuntime(options.destination);
        if (options.state) {
            const state = path.resolve(options.state);
            requireThat(!inside(options.destination, state, true), 'RUNTIME', '控制目录不能位于运行库中。');
            requireThat(!await exists(path.join(state, 'operation.lock')) && !await exists(path.join(state, 'launcher.lock')), 'BUSY', '请先关闭酒馆和任务再更新设备工具路径。');
            const config = await readJson(path.join(state, 'device.json')); config.tools = tools; await atomicJson(path.join(state, 'device.json'), config);
        }
        console.log(JSON.stringify(tools, null, 2));
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
