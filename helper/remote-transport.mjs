import * as vps from './transport.mjs';
import { requireThat } from '../lib/io.mjs';
import { configuredProvider } from '../lib/completion.mjs';

export { configuredProvider, remoteDataset, remoteLabel } from '../lib/completion.mjs';

async function adapter(provider) {
    requireThat(['vps', 'google-drive'].includes(provider), 'CONFIG', '同步存储类型无效。');
    return provider === 'google-drive' ? import('./drive-transport.mjs') : vps;
}

export async function connect(device, makeEnvironment, log = () => {}) {
    const provider = configuredProvider(device);
    const transport = await adapter(provider);
    const session = await transport.connect(device, makeEnvironment, log);
    // Subsequent operations use the connected backend, never a newly selected
    // provider from the mutable device configuration.
    session.provider = provider;
    return session;
}

export async function push(session, ...args) {
    return (await adapter(session.provider ?? 'vps')).push(session, ...args);
}

export async function pull(session, ...args) {
    return (await adapter(session.provider ?? 'vps')).pull(session, ...args);
}

export async function catalog(session, ...args) {
    requireThat(session.provider !== 'google-drive', 'UNSUPPORTED_SCOPE', 'Google 云盘目前支持完整同步，请使用完整推送或拉取。');
    return vps.catalog(session, ...args);
}
