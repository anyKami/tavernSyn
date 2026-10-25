import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, requireThat } from '../lib/io.mjs';

const SOURCE = {
    'src/server-main.js': '567d8a9d52e70816e74f119409933f2b42ad03132d7ef01f8db3ae145c2fe7bf',
    'src/server-startup.js': '646bee9eefa67ed62d2f2157aef88872145b90e6d4c4c32490ad4e1792f9c0ba',
    'src/plugin-loader.js': '994cbfde97c4ef3a2e2a8078e005e61698ded61a52741cad1efe049ee2bedee9',
    'src/users.js': '3100591d000a28f6d3a548242c9de69060c2fd4777c170b13f38a99bc67f3476',
    'src/middleware/userCss.js': 'c51688f61bab030bc6daa61eb0860cf40b4861fe503764cfbf8e986a016304da',
    'src/middleware/webpack-serve.js': '23ec22ec48760ea1cc87aa288154a9fdafd51f7c8b3b8b8529e7b65b733f63cf',
    'public/scripts/st-context.js': '5a91ce36a343041c81351953baba10a54a7576f15571c01ef1af8c19bcc0e30d',
};
export async function checkCompatibility(install) {
    requireThat((await readJson(path.join(install, 'package.json'))).version === '1.19.0', 'UNSUPPORTED_VERSION', '自动重启适配当前只支持 SillyTavern 1.19.0。');
    for (const [file, expected] of Object.entries(SOURCE)) {
        const source = (await fs.readFile(path.join(install, file), 'utf8')).replaceAll('\r\n', '\n');
        requireThat(createHash('sha256').update(source).digest('hex') === expected, 'UNSUPPORTED_VERSION', '酒馆生命周期源码与已验证版本不同，已停用自动替换。');
    }
}
