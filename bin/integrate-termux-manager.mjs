import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { noLinks, run } from '../lib/io.mjs';

const BEGIN = '# BEGIN TAVERNSYN STARTUP';
const END = '# END TAVERNSYN STARTUP';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function managerSource(source, install) {
    source = source.replaceAll('\r\n', '\n');
    if (!source.includes('ClewdR & SillyTavern') || !/show_menu\s*\(\)/.test(source)
        || (source.match(/^main\s+"\$@"\s*$/gm) ?? []).length !== 1) return null;
    source = source.replace(/# BEGIN TAVERNSYN STARTUP\n[\s\S]*?# END TAVERNSYN STARTUP\n(?:\n)?/g, '');
    const branch = /(^[ \t]*4\)[ \t]*(?:\n[ \t]*)?)(?:tavernsyn_start_st|start_st|start_service[ \t]+"SillyTavern"[ \t]+"\$ST_DIR"[ \t]+"node server\.js")(?=[ \t]*(?:\n|;;))/m;
    if (!branch.test(source)) return null;
    source = source.replace(branch, '$1tavernsyn_start_st');
    const portable = install.replaceAll('\\', '/').replace(/\/$/, '');
    const block = `${BEGIN}\ntavernsyn_start_st() {\n    local entry=${quote(portable + '/start-tavernsyn.sh')}\n    if [[ ! -f "$entry" ]]; then\n        echo "未找到 TavernSyn 启动入口：$entry" >&2\n        return 1\n    fi\n    echo '正在检查 TavernSyn 后端版本并启动酒馆…'\n    ( cd ${quote(portable)} && exec bash "$entry" )\n}\n${END}\n\n`;
    return source.replace(/^main\s+"\$@"[ \t]*$/m, block + 'main "$@"');
}

export function loaderSource(source) {
    const original = /^[ \t]*curl[ \t]+-O[ \t]+https:\/\/raw\.githubusercontent\.com\/rzline\/st-cr-ins\.sh\/main\/install\.sh[ \t]*&&[ \t]*bash[ \t]+install\.sh[ \t]*$/m;
    if (!original.test(source)) return source;
    return source.replace(original, `# TavernSyn: keep the integrated manager on later logins.\nif [ -f "$HOME/install.sh" ]; then\n    bash "$HOME/install.sh"\nelse\n    curl -fL --connect-timeout 10 --max-time 60 https://raw.githubusercontent.com/rzline/st-cr-ins.sh/main/install.sh -o "$HOME/install.sh" && bash "$HOME/install.sh"\nfi`);
}

export async function integrateTermuxManager({ install, home = os.homedir(), shell = 'bash', log = console.log }) {
    const manager = await noLinks(path.join(home, 'install.sh'));
    const stat = await fs.lstat(manager).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat?.isFile()) return { status: 'not-found' };
    const original = await fs.readFile(manager, 'utf8'), updated = managerSource(original, install);
    if (updated === null) { log('未识别管理工具的菜单格式，已保留原文件；请使用 start-tavernsyn.sh。'); return { status: 'unsupported' }; }
    const changes = [];
    if (updated !== original) changes.push({ file: manager, text: updated, mode: stat.mode & 0o777 });
    const bashrc = await noLinks(path.join(home, '.bashrc'));
    const rcStat = await fs.lstat(bashrc).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (rcStat?.isFile()) {
        const old = await fs.readFile(bashrc, 'utf8'), next = loaderSource(old);
        if (next !== old) changes.push({ file: bashrc, text: next, mode: rcStat.mode & 0o777 });
    }
    // Validate every changed shell file before replacing either one.
    for (const item of changes) await run(shell, ['-n'], { input: item.text });
    for (const item of changes) {
        const temp = `${item.file}.${randomUUID()}.tmp`;
        await fs.writeFile(temp, item.text, { mode: item.mode });
        await fs.rename(temp, item.file);
    }
    log('已接入 ClewdR & SillyTavern 管理工具：选项 4 检查更新、受控启动并打开浏览器。');
    return { status: 'integrated', changed: changes.map(item => path.basename(item.file)) };
}
