import { loadDevice } from '../lib/device.mjs';
import { cliOptions, requireThat } from '../lib/io.mjs';
import { configureDevice } from '../lib/connection.mjs';

async function passwordInput() {
    process.stderr.write('同步账号密码（留空保留已保存的密码）：');
    const input = process.stdin;
    if (!input.isTTY) {
        let value = ''; for await (const chunk of input) value += chunk;
        return value.replace(/\r?\n$/, '');
    }
    input.setRawMode(true); input.setEncoding('utf8'); input.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = error => { input.off('data', data); input.setRawMode(false); input.pause(); process.stderr.write('\n'); error ? reject(error) : resolve(value); };
        const data = text => {
            for (const char of text) {
                if (char === '\u0003') { finish(new Error('已取消配置。')); return; }
                if (char === '\r' || char === '\n') { finish(); return; }
                if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
                else value += char;
            }
        };
        input.on('data', data);
    });
}

try {
    const options = cliOptions(), device = await loadDevice(options.state);
    requireThat(options.host && Object.keys(options).every(key => ['state', 'host', 'user', 'dataset'].includes(key)), 'CONFIG', '需要 --state 和 --host，可选 --user；密码通过提示输入。');
    await configureDevice(device, 'configure', { host: options.host, user: options.user ?? 'tavernsyn', password: await passwordInput(),
        ...(options.dataset === undefined ? {} : { dataset: options.dataset }) });
    console.log('账号密码已保存。可在酒馆扩展设置中检查连接，数据集会自动读取。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
