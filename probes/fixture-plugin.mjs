// Installed only in a generated fixture containing synthetic user data.
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const info = { id: 'sync-probe', name: 'Sync lifecycle probe', description: 'Isolated test fixture' };
export async function init(router) {
    router.use((request, response, next) => request.user?.profile?.admin ? next() : response.sendStatus(403));
    router.get('/health', (_request, response) => response.json({
        nonce: globalThis.syncProbe.nonce, pid: process.pid,
        data: fs.readFileSync(path.join(globalThis.DATA_ROOT, 'probe-user.json'), 'utf8'),
    }));
    router.post('/echo', (_request, response) => response.json({ ok: true }));
    router.post('/request-restart', (_request, response) => {
        response.status(globalThis.syncProbe.state.managed ? 202 : 409).json({ managed: globalThis.syncProbe.state.managed });
    });
    router.get('/slow', async (request, response) => {
        process.send?.({ event: 'slow-started' });
        await delay(Number(request.query.ms));
        response.json({ ok: true });
    });
    process.serverEvents.once('server-started', () => process.send?.({ event: 'ready' }));
}
export async function exit() {
    await delay(20);
    fs.writeFileSync(path.join(globalThis.DATA_ROOT, 'probe-exit.txt'), 'exit hook completed');
}
