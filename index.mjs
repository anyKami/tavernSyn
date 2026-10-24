import fs from 'node:fs/promises';

// The managed launcher provides this environment variable. Start.bat uses the local install record.
if (!process.env.TAVERNSYN_STATE) {
    const installed = JSON.parse(await fs.readFile(new URL('./.tavernsyn-install.json', import.meta.url), 'utf8'));
    process.env.TAVERNSYN_STATE = installed.state;
}
const plugin = await import('./server/index.mjs');
export const { info, init, exit } = plugin;
