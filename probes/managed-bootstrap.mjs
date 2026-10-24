// Isolated feasibility probe only. This is not a production launcher.
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const state = { paused: false, active: 0, managed: true, stopping: false };
const servers = new Set();
globalThis.syncProbe = { state, nonce: process.env.SYNC_PROBE_NONCE };
for (const module of [http, https]) {
    const original = module.createServer;
    module.createServer = function (...args) {
        const index = args.length - 1;
        const listener = args[index];
        if (typeof listener === 'function') args[index] = function (request, response) {
            if (state.paused) { response.writeHead(503); response.end('maintenance'); return; }
            state.active++;
            let completed = false;
            const finish = () => { if (!completed) { completed = true; state.active--; } };
            response.once('finish', finish);
            response.once('close', finish);
            listener(request, response);
        };
        const server = original.apply(this, args);
        servers.add(server);
        return server;
    };
}
const reply = (message, result) => process.send?.({ reply: message.id, ...result });
process.on('message', async message => {
    if (!message || message.nonce !== process.env.SYNC_PROBE_NONCE) {
        reply(message ?? {}, { result: 'denied' }); return;
    }
    if (message.operation === 'ownership') {
        state.managed = Boolean(message.managed); reply(message, { result: 'ok' }); return;
    }
    if (message.operation === 'resume') {
        state.paused = false; reply(message, { result: 'ok' }); return;
    }
    if (message.operation === 'pause') {
        state.paused = true;
        const deadline = Date.now() + message.timeout;
        while (state.active && Date.now() < deadline) await delay(10);
        reply(message, { result: state.active ? 'drain-timeout' : 'drained', active: state.active });
        return;
    }
    if (message.operation === 'shutdown') {
        if (!state.managed || !state.paused || state.active || state.stopping || !process.listenerCount('SIGTERM')) {
            reply(message, { result: 'refused' }); return;
        }
        state.stopping = true;
        for (const server of servers) server.close();
        reply(message, { result: 'stopping' });
        process.emit('SIGTERM'); // Invokes this pinned ST release's own async exit hooks.
    }
});
await import(pathToFileURL(path.join(process.cwd(), 'server.js')).href);
