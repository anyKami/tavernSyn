import { progressDetail } from './progress.js';

const BASE = '/api/plugins/tavernsyn/';
const tab = crypto.randomUUID();
const labels = { IDLE: '就绪', PREFLIGHT: '正在检查环境', DOWNLOADING: '正在下载', VERIFYING: '正在校验文件', PREPARING: '正在准备插件', AWAITING_SAVE: '正在核对保存', WAITING_PAGE: '正在交接重启任务', QUIESCING: '正在快速关闭酒馆', SNAPSHOT: '正在创建快照', UPLOADING: '正在上传', APPLYING: '正在应用更新', RESTORING: '正在恢复上一版数据', STARTING: '正在重新启动', ROLLING_BACK: '正在恢复旧数据', SUCCEEDED: '同步完成', PREVIEW: '预览完成', PENDING_APPLY: '已下载，等待受控启动后应用', FAILED: '同步未完成', RECOVERY_REQUIRED: '需要恢复处理' };
let status = { phase: 'IDLE' }, handlingSave = false, starting = false, resumed = false, localError = '';
let setupBusy = false, configLoaded = false, configLoading = false, savedTarget = '', passwordSaved = false;
let driveConfig = {}, authorizationPending = false, authorizationDeadline = 0;
let usbState = { stage: 'idle', supported: false }, usbBusy = false, usbIntent = null, usbWatchToken = '';
const context = () => SillyTavern.getContext();
async function api(route, body, { signal } = {}) {
    const response = await fetch(BASE + route, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        headers: body === undefined ? undefined : context().getRequestHeaders(), body: body === undefined ? undefined : JSON.stringify(body), signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.message || `无法连接同步助手（${response.status}）`), { code: result.error });
    return result;
}
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
async function hash(value) {
    const normalized = JSON.parse(JSON.stringify(value));
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(normalized)));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function flush() {
    const epoch = window.__TAVERNSYN__;
    if (!epoch) throw Error('页面尚未启用受控写入检查。请从 TavernSyn 入口启动酒馆并刷新页面。');
    const ctx = context(), nonce = crypto.randomUUID(), controller = new AbortController();
    const save = async () => {
        // Save what can finish promptly; sync may use the current disk contents
        // when a generation, editor or third-party save handler cannot finish.
        try { if (ctx.stopGeneration) await ctx.stopGeneration(); else document.querySelector('#mes_stop')?.click(); } catch {}
        if (controller.signal.aborted) return null;
        ctx.extensionSettings.tavernsyn ??= {};
        ctx.extensionSettings.tavernsyn.flushReceipt = nonce;
        Promise.resolve(ctx.saveSettingsDebounced()).catch(() => {});
        await ctx.saveChat();
        if (controller.signal.aborted) return null;
        const settingsDigest = await hash({ extension_settings: ctx.extensionSettings, power_user: ctx.powerUserSettings,
            oai_settings: ctx.chatCompletionSettings, textgenerationwebui_settings: ctx.textCompletionSettings });
        let chat;
        if (ctx.chatId && (ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar)) chat = {
            type: ctx.groupId ? 'group' : 'single', id: String(ctx.chatId), avatar: ctx.characters?.[ctx.characterId]?.avatar,
            digest: await hash({ messages: ctx.chat, metadata: ctx.chatMetadata ?? {} }),
        };
        while (!controller.signal.aborted) {
            try { return (await api('flush', { nonce, settingsDigest, chat }, { signal: controller.signal })).receipt; }
            catch (error) { if (!['SAVE_PENDING', 'FAILED'].includes(error.code)) throw error; }
            await delay(100);
        }
        return null;
    };
    let timer;
    try {
        const receipt = await Promise.race([save().catch(() => null), new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
        if (receipt) return receipt;
    } finally { clearTimeout(timer); controller.abort(); }
    return (await api('flush', { nonce, quick: true })).receipt;
}
const root = document.createElement('div'); root.id = 'tavernsyn-panel'; root.className = 'extension_container';
root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>TavernSyn 跨设备同步</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content"><p class="ts-device"></p><p class="ts-phase" role="status">正在连接同步助手……</p>
<details class="ts-usb ts-section" open><summary><span class="ts-section-icon ts-usb-icon" aria-hidden="true">USB</span><span class="ts-section-heading"><strong>USB 数据线完整同步</strong><small>电脑 ⇄ 安卓手机 · 连接后选择方向</small></span><span class="ts-section-chevron" aria-hidden="true"></span></summary>
<div class="ts-section-content"><p class="ts-usb-status" role="status">正在检测本机 USB 能力……</p>
<div class="ts-actions ts-usb-connection"><button type="button" class="menu_button ts-usb-connect">连接 USB</button><button type="button" class="menu_button ts-usb-cancel" hidden>取消连接</button></div>
<div class="ts-actions ts-usb-directions" hidden><button type="button" class="menu_button ts-usb-push">电脑 → 手机</button><button type="button" class="menu_button ts-usb-pull">手机 → 电脑</button></div>
<div class="ts-usb-live" hidden role="status" aria-live="polite"><strong class="ts-usb-live-title"></strong><div class="ts-usb-live-stage"></div><progress class="ts-usb-progress" max="100"></progress><small class="ts-usb-live-bytes"></small></div>
<p class="ts-hint">两端连接后，任选一端点击方向，自动完成关闭、同步和重启。</p>
<details class="ts-usb-help"><summary>连接方法与同步范围</summary><p>在电脑与手机上分别打开受控酒馆，点击“连接 USB”。电脑需要安装 ADB，并通过数据线连接已允许 USB 调试的手机。无需启动额外脚本、输入配对码或再次确认。</p>
<p>传输只走数据线，不使用 VPS 或 Google Drive。以选定来源完整覆盖接收端，包含删除；接收端保留最近一次恢复备份。</p>
<a href="https://github.com/anyKami/tavernSyn/blob/main/docs/usb-sync.md" target="_blank" rel="noopener noreferrer">查看 USB 使用指南</a></details></div></details>
<details class="ts-settings ts-section"><summary><span class="ts-section-icon" aria-hidden="true">⚙</span><span class="ts-section-heading"><strong>设置与检查 · 同步仓库</strong><small>Google 云盘 / VPS · 配置与连接检查</small></span><span class="ts-section-chevron" aria-hidden="true"></span></summary><div class="ts-section-content">
<form class="ts-config"><fieldset disabled><legend>同步仓库</legend>
<label>存储位置<select class="text_pole" name="provider"><option value="vps">VPS（SSH / Tailscale）</option><option value="google-drive">Google 云盘</option></select></label>
<div class="ts-vps-config">
<label>VPS 地址<input class="text_pole" name="host" required maxlength="253" placeholder="100.100.100.100 或设备的完整 .ts.net 域名" autocomplete="off" spellcheck="false"></label>
<label>专用同步账号<input class="text_pole" name="user" required maxlength="32" value="tavernsyn" autocomplete="off" spellcheck="false"></label>
<label>账号密码<input class="text_pole" type="password" name="password" required maxlength="1024" placeholder="输入 tavernsyn 账号的密码" autocomplete="current-password"></label>
<p class="ts-hint">首次使用先在 VPS 运行 vps/init.sh 并设置同步账号密码。SSH 端口为 22，数据集自动读取，无需生成或复制公钥。</p>
</div>
<div class="ts-drive-config" hidden>
<label>Google OAuth 客户端 ID<input class="text_pole" name="clientId" maxlength="1024" placeholder="桌面应用客户端：…apps.googleusercontent.com" autocomplete="off" spellcheck="false" disabled></label>
<label>Google OAuth 客户端密钥<input class="text_pole" type="password" name="clientSecret" maxlength="1024" placeholder="输入桌面应用的客户端密钥" autocomplete="off" disabled></label>
<p class="ts-hint">使用你自己的 Google Cloud 项目，启用 Drive API，并创建“桌面应用”OAuth 客户端。两台设备使用同一个客户端和 Google 账号。先保存配置，再授权并创建或加入仓库。</p>
<a href="https://github.com/anyKami/tavernSyn/blob/main/docs/google-drive.md" target="_blank" rel="noopener noreferrer">查看 Google 云盘配置指南</a>
<p class="ts-drive-state" role="status"></p>
<div class="ts-config-actions"><button type="button" class="menu_button ts-drive-authorize">授权 Google 账号</button><button type="button" class="menu_button ts-drive-refresh">刷新授权状态</button></div>
<p class="ts-drive-auth-link" hidden><a target="_blank" rel="noopener noreferrer">打开 Google 授权页面</a>；完成后回到这里。</p>
<div class="ts-config-actions ts-drive-repository-actions"><button type="button" class="menu_button ts-drive-create">创建新仓库</button><button type="button" class="menu_button ts-drive-pairing">显示仓库配对码</button></div>
<label>加入已有仓库<input class="text_pole ts-drive-join-code" type="password" name="pairingCode" maxlength="16384" placeholder="粘贴第一台设备显示的仓库配对码" autocomplete="off" spellcheck="false" disabled></label>
<button type="button" class="menu_button ts-drive-join">加入这个仓库</button>
<p class="ts-hint">首台设备创建仓库；第二台设备粘贴配对码后加入。配对码含解密密钥，应妥善保存。同步完整的可迁移内容，包含删除；当前不支持按类别同步。</p>
<button type="button" class="menu_button ts-drive-disconnect">移除本机 Google 授权</button>
</div>
<p class="ts-dataset ts-hint"></p>
<div class="ts-config-actions"><button type="submit" class="menu_button ts-save-config">保存配置</button><button type="button" class="menu_button ts-check">检查连接</button></div>
</fieldset></form><p class="ts-config-result" role="status">正在读取连接配置……</p><p class="ts-check-result" role="status"></p>
<p>默认同步：聊天、角色、世界书、预设、图片附件、API 密钥、用户设置、自定义用户数据及前后端插件。本机端口、网络与屏幕字段会保留。</p>
<p>同步前会自动尝试保存并快速关闭酒馆，未及时保存的编辑可能丢失。浏览器数据库和未知脚本尚未提交的内存不在同步范围内。</p>
<button type="button" class="menu_button ts-preview-push">预览推送</button><button type="button" class="menu_button ts-preview-pull">预览拉取</button>
</div></details>
<p class="ts-hint ts-sync-hint">点击推送、拉取或恢复即开始，覆盖与删除自动执行。</p>
<div class="ts-actions"><button class="menu_button ts-push">推送到 VPS</button><button class="menu_button ts-pull">从 VPS 拉取</button>
<button type="button" class="menu_button ts-resume-download" hidden>继续上次下载</button><button type="button" class="menu_button ts-resume-upload" hidden>继续上次上传</button><button type="button" class="menu_button ts-resume-apply" hidden>继续应用已下载文件</button></div>
<button type="button" class="menu_button ts-reconcile" hidden>核对同步结果</button>
<fieldset class="ts-scope"><legend>仅同步所选内容（增量传输，包含删除）</legend>
<div class="ts-scope-options"><label><input type="checkbox" name="scope" value="chats" checked>聊天记录（含群聊）</label><label><input type="checkbox" name="scope" value="characters" checked>角色卡</label><label><input type="checkbox" name="scope" value="worlds" checked>世界书</label></div>
<div class="ts-actions"><button type="button" class="menu_button ts-scoped-push">仅推送所选内容</button><button type="button" class="menu_button ts-scoped-pull">仅拉取所选内容</button></div>
<div class="ts-scope-previews"><button type="button" class="menu_button ts-preview-scoped-push">预览分类推送</button><button type="button" class="menu_button ts-preview-scoped-pull">预览分类拉取</button></div>
<small>所选类别以来源为准，接收端多出的文件会删除；其他类别、配置和插件保持不变。首次使用需先在 VPS 建立一次完整副本。</small></fieldset>
<button type="button" class="menu_button ts-restore" disabled>恢复上一版</button><small class="ts-recovery"></small>
<p class="ts-detail"></p><small class="ts-history"></small></div></div>`;
const dialog = document.createElement('dialog'); dialog.className = 'ts-dialog';
dialog.innerHTML = '<h3>同步酒馆</h3><p class="ts-phase"></p><p class="ts-detail"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-cancel" hidden>取消</button></div>';
dialog.addEventListener('cancel', event => event.preventDefault());
dialog.addEventListener('click', event => event.stopPropagation());
document.body.append(dialog);
const pairingDialog = document.createElement('dialog'); pairingDialog.className = 'ts-dialog ts-pairing-dialog';
pairingDialog.innerHTML = '<h3>Google 云盘仓库配对码</h3><p>在另一台设备授权同一个 Google 账号后，粘贴此配对码加入仓库。它包含解密密钥，请保存到你自己的密码管理器；不要发到公开位置。</p><textarea class="text_pole ts-pairing-code" readonly rows="5" aria-label="仓库配对码" spellcheck="false"></textarea><p class="ts-pairing-result" role="status"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-pairing-copy">复制配对码</button><button type="button" class="menu_button ts-pairing-close">关闭并隐藏</button></div>';
document.body.append(pairingDialog);
pairingDialog.addEventListener('click', event => event.stopPropagation());
function clearPairingDialog() {
    pairingDialog.querySelector('.ts-pairing-code').value = '';
    pairingDialog.querySelector('.ts-pairing-result').textContent = '';
}
function closePairingDialog() {
    // The native close event is queued. Remove the secret before hiding the dialog.
    clearPairingDialog(); pairingDialog.close();
}
pairingDialog.addEventListener('close', () => { if (!pairingDialog.open) clearPairingDialog(); });
pairingDialog.addEventListener('cancel', event => { event.preventDefault(); closePairingDialog(); });
pairingDialog.querySelector('.ts-pairing-close').onclick = closePairingDialog;
pairingDialog.querySelector('.ts-pairing-copy').onclick = async () => {
    const input = pairingDialog.querySelector('.ts-pairing-code');
    try { await navigator.clipboard.writeText(input.value); pairingDialog.querySelector('.ts-pairing-result').textContent = '已复制。'; }
    catch { input.focus(); input.select(); pairingDialog.querySelector('.ts-pairing-result').textContent = '请复制已选中的配对码。'; }
};
for (const modal of [dialog, pairingDialog]) for (const event of ['mousedown', 'touchstart']) {
    modal.addEventListener(event, interaction => interaction.stopPropagation());
}
const scopeNames = { chats: '聊天记录（含群聊）', characters: '角色卡', worlds: '世界书' };
const scopeText = scope => scope.map(name => scopeNames[name]).join('、');
const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
if (target) target.append(root);
const form = root.querySelector('.ts-config');
const field = name => form.elements.namedItem(name);
const usbLabel = direction => direction === 'push' ? '电脑 → 手机' : direction === 'pull' ? '手机 → 电脑' : '';
const usbAccepted = stage => ['selected', 'stopping', 'transferring', 'restarting', 'completed'].includes(stage);
function acceptUsbState(next) {
    if (!next) return;
    if (next.watchToken) usbWatchToken = next.watchToken;
    usbState = next;
    if (usbIntent && (usbAccepted(next.stage) || ['failed', 'cancelled'].includes(next.stage))) usbIntent = null;
    if (usbIntent && next.stage === 'connected' && Date.now() - usbIntent.at > 10000) {
        usbIntent = null; localError = '尚未确认 USB 同步方向，请检查两端状态后重新点击。';
    }
}
async function watchUsbStatus() {
    if (!usbWatchToken) throw Error('尚未取得 USB 状态通道。');
    const response = await fetch(BASE + 'usb/status', {
        cache: 'no-store', headers: { 'X-TavernSyn-USB-Watch': usbWatchToken },
        signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) throw Error('USB 进度通道尚未就绪。');
    return await response.json();
}
const usbSize = bytes => {
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    const step = Math.min(3, bytes > 0 ? Math.floor(Math.log(bytes) / Math.log(1024)) : 0);
    return (bytes / 1024 ** step).toFixed(step ? 2 : 0) + ' ' + units[step];
};
function text(selector, value) { for (const parent of [root, dialog]) { const element = parent.querySelector(selector); if (element) element.textContent = value; } }
function render() {
    const google = status.provider === 'google-drive', remote = google ? 'Google 云盘' : 'VPS';
    text('.ts-device', `${status.deviceName ?? ''} · ${google ? (status.configured ? remote : `${remote} 尚未配置完成`) : status.host || '尚未配置 VPS'}`);
    const phase = status.phase === 'DOWNLOADING' ? `正在从 ${remote} 下载` : status.phase === 'UPLOADING' ? `正在上传到 ${remote}` : labels[status.phase] ?? status.phase;
    text('.ts-phase', localError ? '操作未完成，请查看提示' : status.phase === 'SUCCEEDED' && status.direction === 'restore' ? '恢复完成' : phase);
    root.querySelector('.ts-push').textContent = `推送到 ${remote}`;
    root.querySelector('.ts-pull').textContent = `从 ${remote} 拉取`;
    root.querySelector('.ts-scope').hidden = google;
    let detail = localError || status.error?.message || status.note || '';
    if (status.summary) detail += `\n新增 ${status.summary.added}，修改 ${status.summary.changed}，删除 ${status.summary.deleted} 个文件。`;
    if (status.scope) detail += `\n范围：${scopeText(status.scope)}（包含删除）。`;
    const progressText = progressDetail(status);
    if (progressText) detail += `\n${progressText}`;
    text('.ts-detail', detail);
    const when = value => value ? new Date(value).toLocaleString() : '尚无';
    text('.ts-history', `最近推送：${when(status.history?.push)}\n最近拉取：${when(status.history?.pull)}\n最近恢复：${when(status.history?.restore)}`);
    text('.ts-recovery', status.recovery?.available ? `可恢复到 ${when(status.recovery.created)} 覆盖前的本机数据；下次实际覆盖时替换此备份。`
        : status.recovery?.reason || '暂无可用恢复备份；本机应用后保留最新一份覆盖前备份。');
    dialog.querySelector('.ts-cancel').hidden = !['AWAITING_SAVE', 'WAITING_PAGE'].includes(status.phase);
    const terminal = ['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED', 'PENDING_APPLY', 'RECOVERY_REQUIRED'].includes(status.phase);
    const usbActive = ['connecting', 'waiting', 'connected', 'selected', 'stopping', 'transferring', 'restarting'].includes(usbState.stage) || !!usbIntent;
    for (const button of root.querySelectorAll('button')) button.disabled = !terminal || starting || setupBusy || usbActive;
    const usbConnect = root.querySelector('.ts-usb-connect'), usbCancel = root.querySelector('.ts-usb-cancel');
    const usbDirections = root.querySelector('.ts-usb-directions');
    usbConnect.hidden = usbActive;
    usbConnect.disabled = !status.managed || !usbState.supported || usbBusy || !terminal;
    usbCancel.hidden = !!usbIntent || !['connecting', 'waiting', 'connected'].includes(usbState.stage);
    usbCancel.disabled = usbBusy;
    usbDirections.hidden = usbState.stage !== 'connected' || !!usbIntent;
    for (const button of usbDirections.querySelectorAll('button')) button.disabled = usbBusy;
    const usbNames = { idle: '未连接', connecting: '正在建立 USB 连接…', waiting: '等待另一端打开酒馆并点击“连接 USB”…', connected: 'USB 已连接：请选择方向；也可以在另一端选择。', selected: '方向已确认，准备关闭酒馆。', stopping: '正在快速关闭酒馆…', transferring: '正在通过 USB 同步…', restarting: '传输已结束，正在重新启动酒馆…', completed: 'USB 同步完成。', failed: 'USB 同步失败。', cancelled: '已取消 USB 连接。' };
    const pending = !!usbIntent && !usbAccepted(usbState.stage);
    const direction = usbState.selection?.direction || usbIntent?.direction || usbState.job?.direction;
    const name = usbLabel(direction);
    const job = usbState.job ?? {};
    const phases = { SNAPSHOT: '正在制作来源快照', UPLOADING: '正在发送文件', DOWNLOADING: '正在接收文件',
        VERIFYING: '正在校验文件', PREPARING: '正在准备插件', APPLYING: '正在覆盖目标数据',
        STARTING: '正在检查目标酒馆', SUCCEEDED: '数据已应用并校验', FAILED: '同步未完成' };
    const step = phases[job.phase] || (pending ? '正在通知另一端并等待后台确认…'
        : usbNames[usbState.stage] || '正在检查 USB 任务');
    const title = (pending ? '已点击 ' : usbAccepted(usbState.stage) ? '已确认 ' : '') + name;
    // Final completion intentionally clears in-flight progress. Keep the
    // successful transfer at 100% instead of showing an indeterminate bar.
    const total = Number(job.bytes);
    const progressBytes = usbState.stage === 'completed' && Number.isSafeInteger(total) ? total : Number(job.progress?.bytes);
    const metered = Number.isSafeInteger(progressBytes) && progressBytes >= 0 && Number.isSafeInteger(total) && total >= 0;
    const percentage = metered && total > 0 ? Math.min(100, Math.max(0, progressBytes / total * 100)) : null;
    const description = metered ? '已传输 ' + usbSize(progressBytes) + ' / ' + usbSize(total)
        + (percentage === null ? '' : '（' + percentage.toFixed(1) + '%）')
        + (Number.isSafeInteger(job.files) ? ' · 共 ' + job.files + ' 个文件' : '')
        : pending ? '操作已发起，请勿重复点击。' : '正在准备文件总大小，暂未开始传输。';
    const visible = !!usbIntent || ['selected', 'stopping', 'transferring', 'restarting', 'completed', 'failed'].includes(usbState.stage);
    const statusText = pending ? '已点击“' + name + '”，正在通知另一端，无需再次确认。'
        : (usbNames[usbState.stage] || 'USB 状态未知') + (name ? ' 方向：' + name + '。' : '');
    root.querySelector('.ts-usb-status').textContent = !status.managed ? '请使用 TavernSyn 受控启动器启动酒馆。'
        : !usbState.supported ? '当前操作系统不是 Windows 或 Android Termux，不能使用 USB 直连。'
            : statusText + (usbState.peer?.deviceName ? ' 对端：' + usbState.peer.deviceName : '')
                + (usbState.error?.message ? ' ' + usbState.error.message : '') + (usbState.note ? ' ' + usbState.note : '');
    if (visible && terminal && !starting) text('.ts-phase', (pending ? 'USB 指令已发起' : 'USB ' + (usbNames[usbState.stage] || '同步中')));
    for (const holder of [root.querySelector('.ts-usb-live')]) {
        holder.hidden = !visible;
        if (!visible) continue;
        holder.dataset.stage = usbState.stage;
        holder.querySelector('.ts-usb-live-title').textContent = title || 'USB 同步';
        holder.querySelector('.ts-usb-live-stage').textContent = step + (usbState.error?.message ? ' · ' + usbState.error.message : '');
        holder.querySelector('.ts-usb-live-bytes').textContent = description;
        const bar = holder.querySelector('.ts-usb-progress');
        if (percentage === null) bar.removeAttribute('value');
        else bar.value = percentage;
    }
    for (const checkbox of root.querySelectorAll('.ts-scope input')) checkbox.disabled = !terminal || starting || setupBusy;
    root.querySelector('.ts-resume-download').hidden = !status.canResumeDownload;
    root.querySelector('.ts-resume-upload').hidden = !(status.phase === 'FAILED' && !status.commit && status.direction === 'push' && status.snapshotReady === true);
    root.querySelector('.ts-resume-upload').disabled ||= !status.managed;
    const driveCleanupPending = (google || status.transport === 'google-drive') && status.phase === 'SUCCEEDED'
        && ['published', 'applied', 'checked'].includes(status.commit?.kind)
        && Array.isArray(status.maintenance?.remote) && status.maintenance.remote.length > 0;
    root.querySelector('.ts-reconcile').hidden = !(status.maintenancePending || driveCleanupPending || (status.phase === 'FAILED' && status.direction === 'push' && status.snapshotReady));
    root.querySelector('.ts-reconcile').disabled ||= !status.managed;
    form.querySelector('fieldset').disabled = !configLoaded || !terminal || starting || setupBusy;
    root.querySelector('.ts-drive-authorize').disabled ||= !driveConfig.clientConfigured;
    root.querySelector('.ts-drive-create').disabled ||= !driveConfig.authorized || !!driveConfig.configured;
    root.querySelector('.ts-drive-join').disabled ||= !driveConfig.authorized;
    root.querySelector('.ts-drive-pairing').disabled ||= !driveConfig.configured;
    root.querySelector('.ts-drive-disconnect').disabled ||= !driveConfig.authorized;
    for (const button of root.querySelectorAll('.ts-drive-config button')) button.disabled ||= status.provider !== 'google-drive';
    updateProviderFields();
    root.querySelector('.ts-restore').disabled ||= !status.managed || !status.recovery?.available || ['PENDING_APPLY', 'RECOVERY_REQUIRED'].includes(status.phase);
    if (!status.managed && status.recovery?.available) text('.ts-recovery', '有恢复副本；请从 TavernSyn 入口启动酒馆后恢复。');
    root.querySelector('.ts-resume-apply').hidden = status.phase !== 'PENDING_APPLY';
    root.querySelector('.ts-resume-apply').disabled ||= !status.managed;
    if (terminal && dialog.open) dialog.close();
    else if (!terminal && !dialog.open) dialog.showModal();
}
function showError(error) { starting = false; localError = error.message; if (dialog.open) dialog.close(); render(); }
async function begin(direction, preview = false, scoped = false) {
    if (starting || setupBusy) return; starting = true; localError = '';
    try {
        if (scoped && status.provider === 'google-drive') throw Error('Google 云盘当前支持完整同步，请使用完整推送或拉取。');
        const scope = scoped ? [...root.querySelectorAll('.ts-scope input:checked')].map(input => input.value) : null;
        if (scoped && !scope.length) throw Error('请至少选择聊天记录、角色卡或世界书中的一项。');
        render();
        // Save once, at AWAITING_SAVE immediately before the controlled stop.
        const started = await api('start', { direction, preview, tab, ...(scope ? { scope } : {}) });
        status = { ...status, ...started, scope, reason: '', note: '', error: null, stats: null, summary: null, progress: null }; starting = false; render();
    } catch (error) { showError(error); }
}
async function usbConnect() {
    if (usbBusy || starting || setupBusy) return;
    usbBusy = true; localError = ''; render();
    try {
        // Try a prompt save, then let the launcher use the current disk receipt
        // if an editor or third-party save handler would delay the transfer.
        const receipt = await flush();
        acceptUsbState(await api('usb/connect', { tab, receipt }));
        root.querySelector('.ts-usb').open = true;
    } catch (error) { localError = error.message; }
    finally { usbBusy = false; render(); }
}
root.querySelector('.ts-usb-connect').onclick = usbConnect;
for (const [selector, direction] of [['.ts-usb-push', 'push'], ['.ts-usb-pull', 'pull']]) {
    root.querySelector(selector).onclick = async () => {
        if (usbBusy || usbIntent || usbAccepted(usbState.stage)) return;
        usbIntent = { direction, at: Date.now() };
        usbBusy = true; localError = ''; root.querySelector('.ts-usb').open = true; render();
        try { acceptUsbState(await api('usb/select', { direction })); }
        catch (error) {
            // The child HTTP connection may close after the launcher accepted
            // this command. Do not mistake a lost HTTP acknowledgement for
            // a rejected direction; reconcile through the launcher bridge.
            let observed = null;
            try { observed = await watchUsbStatus(); } catch {}
            if (observed) acceptUsbState(observed);
            if (!observed || usbAccepted(observed.stage)) {
                if (!usbWatchToken) { usbIntent = null; localError = error.message; }
                else usbState = { ...usbState, note: '指令可能已被接收，正在自动查询后台状态…' };
            } else { usbIntent = null; localError = error.message; }
        } finally { usbBusy = false; render(); }
    };
}
root.querySelector('.ts-usb-cancel').onclick = async () => {
    if (usbBusy) return;
    usbBusy = true; render();
    try { acceptUsbState(await api('usb/cancel', {})); }
    catch (error) { localError = error.message; }
    finally { usbBusy = false; render(); }
};
root.querySelector('.ts-push').onclick = () => begin('push');
root.querySelector('.ts-pull').onclick = () => begin('pull');
root.querySelector('.ts-scoped-push').onclick = () => begin('push', false, true);
root.querySelector('.ts-scoped-pull').onclick = () => begin('pull', false, true);
root.querySelector('.ts-preview-scoped-push').onclick = () => begin('push', true, true);
root.querySelector('.ts-preview-scoped-pull').onclick = () => begin('pull', true, true);
root.querySelector('.ts-reconcile').onclick = async () => {
    if (starting || setupBusy) return;
    starting = true; localError = ''; render();
    try { status = { ...status, ...await api('reconcile', { id: status.id }) }; }
    catch (error) { localError = error.message; }
    finally { starting = false; render(); }
};
root.querySelector('.ts-resume-upload').onclick = async () => {
    if (starting || setupBusy) return;
    starting = true; localError = '';
    try {
        render();
        const started = await api('resume-upload', { id: status.id, tab });
        status = { ...status, ...started, error: null, progress: null }; starting = false; render();
    } catch (error) { showError(error); }
};
root.querySelector('.ts-resume-download').onclick = async () => {
    if (starting || setupBusy) return;
    starting = true; localError = ''; render();
    try { const started = await api('resume-download', { id: status.id, tab }); status = { ...status, ...started, error: null, progress: null }; }
    catch (error) { showError(error); }
    finally { starting = false; render(); }
};
async function resumePending() {
    if (starting || setupBusy || status.phase !== 'PENDING_APPLY' || !status.managed) return;
    resumed = true; starting = true; localError = ''; render();
    try {
        const started = await api('resume-pending', { tab });
        status = { ...status, ...started, reason: '', note: '', error: null, progress: null };
    } catch (error) { showError(error); }
    finally { starting = false; render(); }
}
root.querySelector('.ts-resume-apply').onclick = resumePending;
root.querySelector('.ts-restore').onclick = () => begin('restore');
root.querySelector('.ts-preview-push').onclick = () => begin('push', true);
root.querySelector('.ts-preview-pull').onclick = () => begin('pull', true);
function showConfiguration(config) {
    field('provider').value = config.provider ?? 'vps';
    for (const name of ['host', 'user']) field(name).value = config[name] ?? (name === 'user' ? 'tavernsyn' : '');
    passwordSaved = config.passwordSaved; savedTarget = `${config.host}\n${config.user}`;
    field('password').value = ''; updatePasswordField();
    driveConfig = config.drive ?? {};
    field('clientId').value = driveConfig.clientId ?? '';
    field('clientSecret').value = '';
    field('clientSecret').placeholder = driveConfig.clientConfigured ? '已保存；留空保留原客户端密钥' : '输入桌面应用的客户端密钥';
    const google = config.provider === 'google-drive';
    const dataset = google ? driveConfig.dataset : config.dataset;
    text('.ts-dataset', dataset ? `已连接的数据集：${dataset}` : google ? '授权后创建新仓库，或用另一台设备的配对码加入已有仓库。' : '首次连接成功后自动读取数据集。');
    text('.ts-drive-state', driveConfig.authError || (driveConfig.authPending ? '正在等待 Google 授权，请在打开的页面完成后返回。'
        : !driveConfig.clientConfigured ? '尚未保存 OAuth 客户端。' : !driveConfig.authorized ? 'OAuth 客户端已保存，尚未授权 Google 账号。'
            : driveConfig.configured ? 'Google 账号已授权，仓库已连接。' : 'Google 账号已授权；请创建或加入仓库。'));
    text('.ts-config-result', google ? (driveConfig.configured ? 'Google 云盘仓库已配置，可以检查连接。' : '按顺序保存 OAuth 客户端、授权 Google 账号，再创建或加入仓库。')
        : !config.runtimeReady ? '尚未准备 VPS 同步运行库，请按安装说明安装后重启酒馆。'
            : config.configured ? '账号密码已保存，可以检查连接。' : '请填写 VPS 地址、账号和密码。');
    if (driveConfig.authorized && !driveConfig.authPending) {
        authorizationPending = false;
        root.querySelector('.ts-drive-auth-link').hidden = true;
        root.querySelector('.ts-drive-auth-link a').removeAttribute('href');
    }
    if (!google || driveConfig.authError) authorizationPending = false;
    status.provider = config.provider ?? 'vps'; status.configured = config.configured; status.host = config.host;
    configLoaded = true;
    updateProviderFields();
}
function updateProviderFields() {
    const google = field('provider').value === 'google-drive';
    root.querySelector('.ts-vps-config').hidden = google;
    root.querySelector('.ts-drive-config').hidden = !google;
    for (const name of ['host', 'user', 'password']) field(name).disabled = google;
    for (const name of ['clientId', 'clientSecret', 'pairingCode']) field(name).disabled = !google;
    field('clientId').required = google;
    field('clientSecret').required = google && !driveConfig.clientConfigured;
}
function updatePasswordField() {
    const reuse = passwordSaved && savedTarget === `${field('host').value.trim().toLowerCase()}\n${field('user').value.trim()}`;
    field('password').required = !reuse;
    field('password').placeholder = reuse ? '已保存；留空保留原密码' : '输入同步账号的密码';
}
async function loadConfiguration() {
    if (configLoading) return; configLoading = true;
    try { showConfiguration(await api('configuration')); }
    catch (error) { text('.ts-config-result', error.message); }
    finally { configLoading = false; render(); }
}
async function setupAction(body) {
    if (setupBusy) return; setupBusy = true; render();
    text('.ts-config-result', '正在保存配置……');
    try {
        const config = await api('configure', body);
        showConfiguration(config);
        localError = ''; text('.ts-check-result', ''); text('.ts-config-result', config.provider === 'google-drive'
            ? '配置已保存并立即生效。请授权 Google 账号，然后创建或加入仓库。' : '配置已保存并立即生效。点击「检查连接」验证账号密码。');
    } catch (error) { text('.ts-config-result', error.message); }
    finally { setupBusy = false; render(); }
}
form.onsubmit = event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const names = field('provider').value === 'google-drive' ? ['provider', 'clientId', 'clientSecret'] : ['provider', 'host', 'user', 'password'];
    setupAction(Object.fromEntries(names.map(name => [name, field(name).value])));
};
field('provider').addEventListener('change', () => {
    field('clientSecret').value = ''; field('pairingCode').value = '';
    if (pairingDialog.open) closePairingDialog();
    updateProviderFields();
    text('.ts-config-result', '选择后请保存配置。推送和拉取仍使用当前已保存的仓库。');
});
for (const name of ['host', 'user']) field(name).addEventListener('input', updatePasswordField);
root.querySelector('.ts-settings').addEventListener('toggle', () => {
    if (root.querySelector('.ts-settings').open && !configLoaded) loadConfiguration();
});
root.querySelector('.ts-check').onclick = async () => {
    if (setupBusy) return; setupBusy = true; render();
    text('.ts-check-result', `正在检查已保存的 ${status.provider === 'google-drive' ? 'Google 云盘仓库' : 'VPS'} 连接……`);
    try { const result = await api('check', {}); text('.ts-dataset', `已连接的数据集：${result.dataset}`); text('.ts-check-result', result.current
        ? '连接成功，已读取当前同步副本。' : '连接成功；仓库还没有同步副本，请先从有完整数据的设备推送。'); }
    catch (error) { text('.ts-check-result', error.message); }
    finally { setupBusy = false; render(); }
};
async function driveAction(action, body = {}) {
    if (setupBusy || starting) return;
    setupBusy = true; localError = ''; render(); text('.ts-config-result', '正在处理 Google 云盘仓库……');
    try {
        const result = await api(action, body);
        field('pairingCode').value = '';
        showConfiguration(await api('configuration'));
        text('.ts-check-result', '');
        if (result.pairingCode) {
            pairingDialog.querySelector('.ts-pairing-code').value = result.pairingCode;
            pairingDialog.showModal();
            pairingDialog.querySelector('.ts-pairing-close').focus();
        }
        if (action === 'drive-disconnect') {
            authorizationPending = false;
            text('.ts-config-result', '已移除本机 Google 授权，云端数据仍然保留。再次使用时重新授权。');
        }
    } catch (error) { text('.ts-config-result', error.message); }
    finally { setupBusy = false; render(); }
}
root.querySelector('.ts-drive-create').onclick = () => driveAction('drive-create');
root.querySelector('.ts-drive-join').onclick = () => {
    const pairingCode = field('pairingCode').value.trim();
    if (!pairingCode) { text('.ts-config-result', '请先粘贴另一台设备的仓库配对码。'); return; }
    driveAction('drive-join', { pairingCode });
};
root.querySelector('.ts-drive-pairing').onclick = () => driveAction('drive-pairing');
root.querySelector('.ts-drive-disconnect').onclick = () => driveAction('drive-disconnect');
root.querySelector('.ts-drive-refresh').onclick = () => loadConfiguration();
async function pollAuthorization() {
    if (!authorizationPending || Date.now() > authorizationDeadline) return;
    if (!setupBusy && !starting) await loadConfiguration();
    if (authorizationPending) setTimeout(pollAuthorization, 2500);
}
root.querySelector('.ts-drive-authorize').onclick = async () => {
    if (setupBusy || starting) return;
    // Open from the click itself so the browser doesn't block the asynchronous redirect.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setupBusy = true; render(); text('.ts-config-result', '正在准备 Google 授权……');
    try {
        const result = await api('drive-authorize', {}), url = new URL(result.authorizationUrl);
        if (url.origin !== 'https://accounts.google.com') throw Error('授权页面地址无效，请更新 TavernSyn 后重试。');
        root.querySelector('.ts-drive-auth-link a').href = url.href;
        root.querySelector('.ts-drive-auth-link').hidden = false;
        if (popup) popup.location.href = url.href;
        authorizationPending = true; authorizationDeadline = Date.now() + 10 * 60 * 1000;
        text('.ts-config-result', '请在 Google 页面完成授权后回到这里；授权状态会自动刷新。');
    } catch (error) { if (popup) popup.close(); text('.ts-config-result', error.message); }
    finally { setupBusy = false; render(); }
    if (authorizationPending) pollAuthorization();
};
dialog.querySelector('.ts-cancel').onclick = async () => {
    try { await api('cancel', { id: status.id }); } catch (error) { showError(error); }
};
async function poll() {
    try {
        status = await api('status');
        const pageEpoch = globalThis.window?.__TAVERNSYN__?.epoch;
        if (pageEpoch && status.epoch && pageEpoch !== status.epoch) {
            // USB controlled stop/start replaces the underlying ST process.
            // Reload to bind a fresh save/CSRF barrier before accepting writes.
            location.reload(); return;
        }
        if (status.phase === 'WAITING_PAGE' && status.id && status.tab && status.ticket) {
            // A ready reply may be lost after the helper accepted it. Any tab
            // can follow the recorded owner without saving or asking again.
            location.assign(`${BASE}wait?${new URLSearchParams({ id: status.id, tab: status.tab, ticket: status.ticket })}`);
            return;
        }
        if (status.phase !== 'AWAITING_SAVE') handlingSave = false;
        if (status.managed) acceptUsbState(await api('usb/status').catch(() => usbState));
        if (!starting) render();
        if (!status.configured && !configLoaded) { root.querySelector('.ts-settings').open = true; loadConfiguration(); }
        if (status.phase === 'PENDING_APPLY' && status.managed && !resumed) {
            await resumePending();
        }
        if (status.phase === 'AWAITING_SAVE' && !handlingSave) {
            handlingSave = true;
            try {
                const receipt = await flush();
                const ready = await api('ready', { id: status.id, receipt, tab });
                location.assign(`${BASE}wait?${new URLSearchParams({ id: ready.id, tab: ready.tab ?? tab, ticket: ready.ticket })}`);
                return;
            } catch (error) {
                handlingSave = ['INPUT', 'UNMANAGED', 'ADMIN_LOCAL_ONLY', 'OWNERSHIP'].includes(error.code);
                if (handlingSave) { localError = error.message; render(); }
                else { localError = ''; text('.ts-phase', '正在自动重试保存交接…'); text('.ts-detail', error.message); }
            }
        }
    } catch (error) {
        if (usbWatchToken && (usbIntent || ['connected', 'selected', 'stopping', 'transferring', 'restarting'].includes(usbState.stage))) {
            try { acceptUsbState(await watchUsbStatus()); render(); }
            catch {
                usbState = { ...usbState, note: '酒馆暂时离线，正在重新连接后台进度…' };
                render();
            }
        } else if (!starting) text('.ts-phase', error.message);
    }
    setTimeout(poll, usbIntent || ['selected', 'stopping', 'transferring', 'restarting'].includes(usbState.stage) ? 650 : 1200);
}
setInterval(() => api('tabs', { tab }).catch(() => {}), 5000);
await api('tabs', { tab }).catch(() => {});
poll();
