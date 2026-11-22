import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { connectUsbPeer } from './usb-service.mjs';
import { requireThat, SyncError } from '../lib/io.mjs';

const NOT_READY = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
const WAIT_LIMIT = 2 * 60 * 1000;

function timeoutError() {
    return new SyncError('USB_TIMEOUT', '等待手机 USB 入口超时，请在手机运行 usb-tavernsyn.sh，再重试连接。');
}

function localEndpoint(origin) {
    let url;
    try { url = new URL(origin); } catch { throw new SyncError('USB_ORIGIN', 'USB 地址必须是本机 ADB 转发端口。'); }
    requireThat(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port)
        && Number(url.port) > 0 && Number(url.port) <= 65535 && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password,
    'USB_ORIGIN', 'USB 地址必须是 http://127.0.0.1:端口，不允许网络地址或重定向。');
    return url;
}

// ADB accepts TCP connections even while the forwarded phone port is closed.
// An unauthenticated GET cannot bind a peer; its HTTP response proves that the
// phone service is responding without risking a repeated /connect handshake.
function probe(url, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
        let finished = false, timer;
        const request = http.request({ hostname: '127.0.0.1', port: Number(url.port), path: '/hello', method: 'GET',
            agent: false, signal, headers: { connection: 'close' } });
        const finish = error => {
            if (finished) return; finished = true;
            clearTimeout(timer); request.destroy();
            if (error) reject(error); else resolve();
        };
        request.once('error', finish);
        request.once('response', response => { response.on('error', () => {}); response.destroy(); finish(); });
        timer = setTimeout(() => finish(timeoutError()), timeoutMs); timer.unref?.();
        request.end();
    });
}

/** Wait for the phone entry, then perform exactly one automatic handshake. */
export async function waitForUsbPeer(session, { origin, signal, waitMs = WAIT_LIMIT, intervalMs = 1000,
    onWaiting = () => {}, ...connectOptions } = {}) {
    requireThat(Number.isFinite(waitMs) && waitMs > 0 && waitMs <= WAIT_LIMIT && Number.isFinite(intervalMs) && intervalMs > 0
        && typeof onWaiting === 'function', 'USB_CONFIG', 'USB 连接等待时限无效。');
    const url = localEndpoint(origin), deadline = performance.now() + waitMs;
    let notified = false;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw timeoutError();
            try { await probe(url, signal, remaining); break; }
            catch (error) {
                signal?.throwIfAborted();
                if (!NOT_READY.has(error.code)) throw error;
                if (!notified) { notified = true; await onWaiting(); }
                signal?.throwIfAborted();
                const pause = Math.min(intervalMs, deadline - performance.now());
                if (pause <= 0) throw timeoutError();
                await delay(pause, undefined, { signal });
            }
        }
    } catch (error) { if (signal?.aborted) throw signal.reason; throw error; }
    // A reset after /connect might mean the phone already bound this peer.
    // Never retry that ambiguous operation, or protocol/auth/busy responses.
    return connectUsbPeer(session, { ...connectOptions, origin, signal });
}
