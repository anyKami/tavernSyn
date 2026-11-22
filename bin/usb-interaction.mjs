import { requireThat, SyncError } from '../lib/io.mjs';

export function usbDirectionLabel(direction) {
    requireThat(['push', 'pull'].includes(direction), 'USB_DIRECTION', 'USB 同步方向必须是 push（电脑 → 手机）或 pull（手机 → 电脑）。');
    return direction === 'push' ? '电脑 → 手机' : '手机 → 电脑';
}

// Both terminals race for one choice held by the phone. The accepted choice is
// authoritative, including when the other terminal wins while this one types.
export async function chooseUsbDirection({ direction, choose, waitForSelection, ask, write = () => {}, signal } = {}) {
    requireThat(!signal?.aborted, 'CANCELLED', '已退出 USB 方向选择，未开始新的同步。');
    if (direction !== undefined) usbDirectionLabel(direction);
    requireThat(typeof choose === 'function' && typeof waitForSelection === 'function', 'USB_CONFIG', 'USB 方向选择器未连接。');
    const controller = new AbortController();
    const active = () => requireThat(!signal?.aborted && !controller.signal.aborted, 'CANCELLED', '已退出 USB 方向选择，未开始新的同步。');
    const select = value => { active(); return choose(value); };
    const stopped = new Promise((resolve, reject) => {
        const abort = () => reject(new SyncError('CANCELLED', '已退出 USB 方向选择，未开始新的同步。'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true, signal: controller.signal });
    });
    const waiting = Promise.resolve().then(() => { active(); return waitForSelection({ signal: controller.signal }); });
    const operations = [waiting, stopped];
    if (direction !== undefined) operations.push(Promise.resolve().then(() => select(direction)));
    else if (ask) operations.push((async () => {
        for (;;) {
            active();
            const answer = await ask('选择方向：1 = 电脑 → 手机，2 = 手机 → 电脑（也可在另一端选择）：', { signal: controller.signal });
            active();
            if (!['1', '2'].includes(answer.trim())) { write('请输入 1 或 2；尚未开始同步。'); continue; }
            return select(answer.trim() === '1' ? 'push' : 'pull');
        }
    })());
    else write('等待另一端选择同步方向……');
    try {
        const selected = await Promise.race(operations);
        requireThat(selected && ['push', 'pull'].includes(selected.direction)
            && ['phone', 'computer'].includes(selected.selectedBy), 'USB_CLOSED', 'USB 会话已结束，未选择同步方向。');
        return selected;
    } finally {
        // Aborting readline also removes a stale prompt when the peer chooses.
        controller.abort();
        for (const operation of operations) operation.catch(() => {});
    }
}
