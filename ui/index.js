import { progressDetail } from './progress.js';

const BASE = '/api/plugins/tavernsyn/';
const tab = crypto.randomUUID();
const labels = { IDLE: '就绪', PREFLIGHT: '正在检查环境', DOWNLOADING: '正在从 VPS 下载', VERIFYING: '正在校验文件', PREPARING: '正在准备插件', AWAITING_CONFIRMATION: '需要确认覆盖', AWAITING_SAVE: '正在确认保存', WAITING_PAGE: '正在交接重启任务', QUIESCING: '正在安全停止酒馆', SNAPSHOT: '正在创建快照', UPLOADING: '正在上传到 VPS', APPLYING: '正在应用更新', RESTORING: '正在恢复上一版数据', STARTING: '正在重新启动', ROLLING_BACK: '正在恢复旧数据', SUCCEEDED: '同步完成', PREVIEW: '预览完成', PENDING_APPLY: '已下载，等待受控启动后应用', FAILED: '同步未完成', RECOVERY_REQUIRED: '需要恢复处理' };
let status = { phase: 'IDLE' }, handlingSave = false, starting = false, resumed = false, localError = '';
let setupBusy = false, configLoaded = false, configLoading = false, savedTarget = '', passwordSaved = false;
const context = () => SillyTavern.getContext();
async function api(route, body) {
    const response = await fetch(BASE + route, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        headers: body === undefined ? undefined : context().getRequestHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
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
const visible = element => element && element.getClientRects().length > 0;
async function flush() {
    const epoch = window.__TAVERNSYN__;
    if (!epoch) throw Error('页面尚未启用受控写入检查。请从 TavernSyn 入口启动酒馆并刷新页面。');
    if (visible(document.querySelector('#mes_stop')) || visible(document.querySelector('.mes_edit_textarea'))
        || document.querySelector('#send_textarea')?.value?.trim()) throw Error('请先完成生成、消息编辑和未发送的输入，再执行同步。');
    if (document.querySelector('dialog[open]:not(.ts-dialog)')) throw Error('请先保存并关闭正在编辑的弹窗。');
    const ctx = context(), nonce = crypto.randomUUID();
    ctx.extensionSettings.tavernsyn ??= {};
    ctx.extensionSettings.tavernsyn.flushReceipt = nonce;
    await ctx.saveChat(); // A successful call is followed by disk readback, never treated as the barrier.
    ctx.saveSettingsDebounced();
    const settingsDigest = await hash({ extension_settings: ctx.extensionSettings, power_user: ctx.powerUserSettings,
        oai_settings: ctx.chatCompletionSettings, textgenerationwebui_settings: ctx.textCompletionSettings });
    let chat;
    if (ctx.chatId && (ctx.groupId || ctx.characters?.[ctx.characterId]?.avatar)) chat = {
        type: ctx.groupId ? 'group' : 'single', id: String(ctx.chatId), avatar: ctx.characters?.[ctx.characterId]?.avatar,
        digest: await hash({ messages: ctx.chat, metadata: ctx.chatMetadata ?? {} }),
    };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const result = await api('flush', { nonce, settingsDigest, chat });
            if (!epoch.pending && Date.now() - epoch.lastWrite > 1500) return result.receipt;
        } catch (error) { if (!['SAVE_PENDING', 'FAILED'].includes(error.code)) throw error; }
        await delay(400);
    }
    throw Error('未能核对已保存的设置和聊天。请检查保存错误并稍后重试。');
}
const root = document.createElement('div'); root.id = 'tavernsyn-panel'; root.className = 'extension_container';
root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>TavernSyn 跨设备同步</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
<div class="inline-drawer-content"><p class="ts-device"></p><p class="ts-phase" role="status">正在连接同步助手……</p>
<div class="ts-actions"><button class="menu_button ts-push">推送到 VPS</button><button class="menu_button ts-pull">从 VPS 拉取</button>
<button type="button" class="menu_button ts-resume-upload" hidden>继续上次上传</button><button type="button" class="menu_button ts-resume-apply" hidden>继续应用已下载文件</button></div>
<button type="button" class="menu_button ts-reconcile" hidden>核对同步结果</button>
<fieldset class="ts-scope"><legend>仅同步所选内容（增量传输，包含删除）</legend>
<div class="ts-scope-options"><label><input type="checkbox" name="scope" value="chats" checked>聊天记录（含群聊）</label><label><input type="checkbox" name="scope" value="characters" checked>角色卡</label><label><input type="checkbox" name="scope" value="worlds" checked>世界书</label></div>
<div class="ts-actions"><button type="button" class="menu_button ts-scoped-push">仅推送所选内容</button><button type="button" class="menu_button ts-scoped-pull">仅拉取所选内容</button></div>
<div class="ts-scope-previews"><button type="button" class="menu_button ts-preview-scoped-push">预览分类推送</button><button type="button" class="menu_button ts-preview-scoped-pull">预览分类拉取</button></div>
<small>所选类别以来源为准，接收端多出的文件会删除；其他类别、配置和插件保持不变。首次使用需先在 VPS 建立一次完整副本。</small></fieldset>
<button type="button" class="menu_button ts-restore" disabled>恢复上一版</button><small class="ts-recovery"></small>
<p class="ts-detail"></p><small class="ts-history"></small><details class="ts-settings"><summary>设置与检查 · VPS 配置</summary>
<form class="ts-config"><fieldset disabled><legend>VPS 连接</legend>
<label>VPS 地址<input class="text_pole" name="host" required maxlength="253" placeholder="100.100.100.100 或设备的完整 .ts.net 域名" autocomplete="off" spellcheck="false"></label>
<label>专用同步账号<input class="text_pole" name="user" required maxlength="32" value="tavernsyn" autocomplete="off" spellcheck="false"></label>
<label>账号密码<input class="text_pole" type="password" name="password" required maxlength="1024" placeholder="输入 tavernsyn 账号的密码" autocomplete="current-password"></label>
<p class="ts-hint">首次使用先在 VPS 运行 vps/init.sh 并设置同步账号密码。SSH 端口为 22，数据集自动读取，无需生成或复制公钥。</p>
<p class="ts-dataset ts-hint"></p>
<div class="ts-config-actions"><button type="submit" class="menu_button ts-save-config">保存配置</button><button type="button" class="menu_button ts-check">检查连接</button></div>
</fieldset></form><p class="ts-config-result" role="status">正在读取连接配置……</p><p class="ts-check-result" role="status"></p>
<p>默认同步：聊天、角色、世界书、预设、图片附件、API 密钥、用户设置、自定义用户数据及前后端插件。本机端口、网络与屏幕字段会保留。</p>
<p>同步前请保存编辑并关闭其他酒馆标签页。浏览器数据库和未知脚本尚未提交的内存不在同步范围内。</p>
<button type="button" class="menu_button ts-preview-push">预览推送</button><button type="button" class="menu_button ts-preview-pull">预览拉取</button>
</details></div></div>`;
const dialog = document.createElement('dialog'); dialog.className = 'ts-dialog';
dialog.innerHTML = '<h3>同步酒馆</h3><p class="ts-phase"></p><p class="ts-detail"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-cancel" hidden>取消</button><button type="button" class="menu_button ts-confirm" hidden>确认覆盖并继续</button></div>';
dialog.addEventListener('cancel', event => event.preventDefault());
dialog.addEventListener('click', event => event.stopPropagation());
document.body.append(dialog);
const directionDialog = document.createElement('dialog'); directionDialog.className = 'ts-dialog ts-direction-dialog';
directionDialog.innerHTML = '<h3></h3><p class="ts-detail"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-decline">取消</button><button type="button" class="menu_button ts-accept"></button></div>';
document.body.append(directionDialog);
directionDialog.addEventListener('click', event => event.stopPropagation());
for (const modal of [dialog, directionDialog]) for (const event of ['mousedown', 'touchstart']) {
    modal.addEventListener(event, interaction => interaction.stopPropagation());
}
const scopeNames = { chats: '聊天记录（含群聊）', characters: '角色卡', worlds: '世界书' };
const scopeText = scope => scope.map(name => scopeNames[name]).join('、');
function confirmDirection(direction, scope = null) {
    const push = direction === 'push', restore = direction === 'restore', resume = direction === 'resume';
    directionDialog.querySelector('h3').textContent = resume ? '继续上次上传' : restore ? '确认恢复上一版' : push ? '确认推送到 VPS' : '确认从 VPS 拉取';
    directionDialog.querySelector('.ts-detail').textContent = resume
        ? '将继续上传上次已保存的快照，复用 VPS 暂存文件。快照之后的新聊天和修改留待下次推送。是否继续？' : restore
        ? '将恢复到最近一次拉取前的本机配置、插件和用户数据，替换此后的本机改动。VPS 副本不会改变。本次恢复副本使用后将不再保留。是否继续？' : push
        ? '将以本机已保存的内容更新 VPS 同步副本，VPS 原有的共享数据可能被替换。是否继续？'
        : '将以 VPS 同步副本更新本机，覆盖本机的共享配置、插件和用户数据。应用前会保留一次恢复副本。是否继续？';
    directionDialog.querySelector('.ts-accept').textContent = resume ? '继续上传' : restore ? '确认恢复' : push ? '确认推送' : '确认拉取';
    if (scope) {
        directionDialog.querySelector('h3').textContent = push ? '确认分类推送' : '确认分类拉取';
        directionDialog.querySelector('.ts-detail').textContent = `仅同步${scopeText(scope)}，以${push ? '本机' : 'VPS'}为准，包含修改和删除。其他类别、配置及插件保持不变。下一步会显示实际文件差异，确认后继续。`;
    }
    if (['push', 'pull'].includes(direction)) directionDialog.querySelector('.ts-detail').textContent += '\n实际传输前会显示待上传或待下载文件总大小，再次确认后开始传输。';
    if (restore && status.recovery?.scope) directionDialog.querySelector('.ts-detail').textContent = `将恢复${scopeText(status.recovery.scope)}到最近一次分类拉取前的状态，替换此后这些类别的改动。其他类别、配置及插件保持不变。是否继续？`;
    return new Promise(resolve => {
        const finish = result => { directionDialog.close(); resolve(result); };
        directionDialog.querySelector('.ts-accept').onclick = () => finish(true);
        directionDialog.querySelector('.ts-decline').onclick = () => finish(false);
        directionDialog.oncancel = event => { event.preventDefault(); finish(false); };
        directionDialog.showModal(); directionDialog.querySelector('.ts-decline').focus();
    });
}
const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
if (target) target.append(root);
const form = root.querySelector('.ts-config');
const field = name => form.elements.namedItem(name);
function text(selector, value) { for (const parent of [root, dialog]) { const element = parent.querySelector(selector); if (element) element.textContent = value; } }
function render() {
    text('.ts-device', `${status.deviceName ?? ''}${status.host ? ` · ${status.host}` : ' · 尚未配置 VPS'}`);
    text('.ts-phase', localError ? '本次操作未开始，请处理提示' : status.transferConfirmation ? '请核对待传输文件大小' : status.phase === 'SUCCEEDED' && status.direction === 'restore' ? '恢复完成' : labels[status.phase] ?? status.phase);
    let detail = localError || status.error?.message || (status.phase === 'AWAITING_CONFIRMATION' ? status.reason : '') || status.note || '';
    if (status.summary) detail += `\n新增 ${status.summary.added}，修改 ${status.summary.changed}，删除 ${status.summary.deleted} 个文件。`;
    if (status.scope) detail += `\n范围：${scopeText(status.scope)}（包含删除）。`;
    const progressText = progressDetail(status);
    if (progressText) detail += `\n${progressText}`;
    text('.ts-detail', detail);
    const when = value => value ? new Date(value).toLocaleString() : '尚无';
    text('.ts-history', `最近推送：${when(status.history?.push)}\n最近拉取：${when(status.history?.pull)}\n最近恢复：${when(status.history?.restore)}`);
    text('.ts-recovery', status.recovery?.available ? `可恢复到 ${when(status.recovery.created)} 拉取前的本机数据。`
        : status.recovery?.reason || '暂无可用恢复副本；完成一次拉取更新后保留一版。');
    dialog.querySelector('.ts-confirm').hidden = status.phase !== 'AWAITING_CONFIRMATION';
    dialog.querySelector('.ts-confirm').textContent = status.transferConfirmation ? status.direction === 'push' ? '开始上传' : '开始下载' : '确认覆盖并继续';
    dialog.querySelector('.ts-cancel').hidden = !['AWAITING_CONFIRMATION', 'AWAITING_SAVE', 'WAITING_PAGE'].includes(status.phase);
    const terminal = ['IDLE', 'SUCCEEDED', 'PREVIEW', 'FAILED', 'PENDING_APPLY', 'RECOVERY_REQUIRED'].includes(status.phase);
    for (const button of root.querySelectorAll('button')) button.disabled = !terminal || starting || setupBusy;
    for (const checkbox of root.querySelectorAll('.ts-scope input')) checkbox.disabled = !terminal || starting || setupBusy;
    root.querySelector('.ts-resume-upload').hidden = !(status.phase === 'FAILED' && !status.commit && status.direction === 'push' && status.snapshotReady === true);
    root.querySelector('.ts-resume-upload').disabled ||= !status.managed;
    root.querySelector('.ts-reconcile').hidden = !(status.maintenancePending || (status.phase === 'FAILED' && status.direction === 'push' && status.snapshotReady));
    root.querySelector('.ts-reconcile').disabled ||= !status.managed;
    form.querySelector('fieldset').disabled = !configLoaded || !terminal || starting || setupBusy;
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
        const scope = scoped ? [...root.querySelectorAll('.ts-scope input:checked')].map(input => input.value) : null;
        if (scoped && !scope.length) throw Error('请至少选择聊天记录、角色卡或世界书中的一项。');
        render();
        if (!preview && !await confirmDirection(direction, scope)) { starting = false; render(); return; }
        if (!preview && status.managed) { if (!dialog.open) dialog.showModal(); text('.ts-phase', '正在保存并核对内容'); text('.ts-detail', ''); await flush(); }
        const started = await api('start', { direction, preview, tab, ...(scope ? { scope } : {}) });
        status = { ...status, ...started, scope, reason: '', note: '', error: null, stats: null, summary: null, progress: null }; starting = false; render();
    } catch (error) { showError(error); }
}
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
        if (!await confirmDirection('resume')) { starting = false; render(); return; }
        const started = await api('resume-upload', { id: status.id, tab });
        status = { ...status, ...started, error: null, progress: null }; starting = false; render();
    } catch (error) { showError(error); }
};
async function resumePending() {
    if (starting || setupBusy || status.phase !== 'PENDING_APPLY' || !status.managed) return;
    resumed = true; starting = true; localError = ''; render();
    try {
        await flush();
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
    for (const name of ['host', 'user']) field(name).value = config[name];
    passwordSaved = config.passwordSaved; savedTarget = `${config.host}\n${config.user}`;
    field('password').value = ''; updatePasswordField();
    text('.ts-dataset', config.dataset ? `已连接的数据集：${config.dataset}` : '首次连接成功后自动读取数据集。');
    text('.ts-config-result', !config.runtimeReady ? '尚未准备同步运行库，请按安装说明安装后重启酒馆。'
        : config.configured ? '账号密码已保存，可以检查连接。' : '请填写 VPS 地址、账号和密码。');
    configLoaded = true;
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
        showConfiguration(config); status.host = config.host; status.configured = config.configured;
        localError = ''; text('.ts-check-result', ''); text('.ts-config-result', '配置已保存并立即生效。点击「检查连接」验证账号密码。');
    } catch (error) { text('.ts-config-result', error.message); }
    finally { setupBusy = false; render(); }
}
form.onsubmit = event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    setupAction(Object.fromEntries(['host', 'user', 'password'].map(name => [name, field(name).value])));
};
for (const name of ['host', 'user']) field(name).addEventListener('input', updatePasswordField);
root.querySelector('.ts-settings').addEventListener('toggle', () => {
    if (root.querySelector('.ts-settings').open && !configLoaded) loadConfiguration();
});
root.querySelector('.ts-check').onclick = async () => {
    if (setupBusy) return; setupBusy = true; render(); text('.ts-check-result', '正在检查已保存的 VPS 连接……');
    try { const result = await api('check', {}); text('.ts-dataset', `已连接的数据集：${result.dataset}`); text('.ts-check-result', '连接成功，账号密码有效，数据集已自动识别。'); }
    catch (error) { text('.ts-check-result', error.message); }
    finally { setupBusy = false; render(); }
};
dialog.querySelector('.ts-confirm').onclick = async () => {
    const button = dialog.querySelector('.ts-confirm'); button.disabled = true;
    try {
        await api('confirm', { id: status.id, token: status.confirmationToken, tab });
        localError = ''; status = await api('status'); render();
    } catch (error) { showError(error); }
    finally { button.disabled = false; }
};
dialog.querySelector('.ts-cancel').onclick = async () => {
    try { await api('cancel', { id: status.id }); } catch (error) { showError(error); }
};
async function poll() {
    try {
        status = await api('status'); if (!starting) render();
        if (!status.configured && !configLoaded) { root.querySelector('.ts-settings').open = true; loadConfiguration(); }
        if (status.phase === 'PENDING_APPLY' && status.managed && !resumed) {
            await resumePending();
        }
        if (status.phase === 'AWAITING_SAVE' && status.tab === tab && !handlingSave) {
            handlingSave = true;
            try {
                const receipt = await flush();
                const ready = await api('ready', { id: status.id, receipt, tab });
                location.assign(`${BASE}wait?${new URLSearchParams({ id: ready.id, tab, ticket: ready.ticket })}`);
                return;
            } catch (error) { await api('cancel', { id: status.id }).catch(() => {}); handlingSave = false; showError(error); }
        }
    } catch (error) { if (!starting) text('.ts-phase', error.message); }
    setTimeout(poll, 1200);
}
setInterval(() => api('tabs', { tab }).catch(() => {}), 5000);
await api('tabs', { tab }).catch(() => {});
poll();
