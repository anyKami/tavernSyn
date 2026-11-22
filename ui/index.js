import { progressDetail } from './progress.js';

const BASE = '/api/plugins/tavernsyn/';
const tab = crypto.randomUUID();
const labels = { IDLE: '就绪', PREFLIGHT: '正在检查环境', DOWNLOADING: '正在下载', VERIFYING: '正在校验文件', PREPARING: '正在准备插件', AWAITING_SAVE: '正在核对保存', WAITING_PAGE: '正在交接重启任务', QUIESCING: '正在安全停止酒馆', SNAPSHOT: '正在创建快照', UPLOADING: '正在上传', APPLYING: '正在应用更新', RESTORING: '正在恢复上一版数据', STARTING: '正在重新启动', ROLLING_BACK: '正在恢复旧数据', SUCCEEDED: '同步完成', PREVIEW: '预览完成', PENDING_APPLY: '已下载，等待受控启动后应用', FAILED: '同步未完成', RECOVERY_REQUIRED: '需要恢复处理' };
let status = { phase: 'IDLE' }, handlingSave = false, starting = false, resumed = false, localError = '';
let setupBusy = false, configLoaded = false, configLoading = false, savedTarget = '', passwordSaved = false;
let driveConfig = {}, authorizationPending = false, authorizationDeadline = 0;
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
<button type="button" class="menu_button ts-resume-download" hidden>继续上次下载</button><button type="button" class="menu_button ts-resume-upload" hidden>继续上次上传</button><button type="button" class="menu_button ts-resume-apply" hidden>继续应用已下载文件</button></div>
<button type="button" class="menu_button ts-reconcile" hidden>核对同步结果</button>
<fieldset class="ts-scope"><legend>仅同步所选内容（增量传输，包含删除）</legend>
<div class="ts-scope-options"><label><input type="checkbox" name="scope" value="chats" checked>聊天记录（含群聊）</label><label><input type="checkbox" name="scope" value="characters" checked>角色卡</label><label><input type="checkbox" name="scope" value="worlds" checked>世界书</label></div>
<div class="ts-actions"><button type="button" class="menu_button ts-scoped-push">仅推送所选内容</button><button type="button" class="menu_button ts-scoped-pull">仅拉取所选内容</button></div>
<div class="ts-scope-previews"><button type="button" class="menu_button ts-preview-scoped-push">预览分类推送</button><button type="button" class="menu_button ts-preview-scoped-pull">预览分类拉取</button></div>
<small>所选类别以来源为准，接收端多出的文件会删除；其他类别、配置和插件保持不变。首次使用需先在 VPS 建立一次完整副本。</small></fieldset>
<button type="button" class="menu_button ts-restore" disabled>恢复上一版</button><small class="ts-recovery"></small>
<details class="ts-usb"><summary>USB 数据线完整同步</summary>
<p>两端更新后重新运行安装器。先保存并正常关闭两端酒馆及启动器，手机通过 USB 连接电脑并允许 USB 调试；手机运行酒馆目录中的 usb-tavernsyn.sh，电脑运行 USB-TavernSyn.cmd。</p>
<p>电脑输入 ADB 路径、手机本次配对码和覆盖方向，核对双方设备名称后输入 YES。目标完整镜像来源，包含删除；不需要 VPS。目标保留一份最新的覆盖前备份，完成后使用平时入口启动酒馆。</p>
<p>电脑需安装 Android SDK Platform-Tools。USB 传输完整快照；插件依赖恢复可能仍需 npm 缓存或网络。</p>
<a href="https://github.com/anyKami/tavernSyn/blob/main/docs/usb-sync.md" target="_blank" rel="noopener noreferrer">查看 USB 使用指南</a></details>
<p class="ts-detail"></p><small class="ts-history"></small><details class="ts-settings"><summary>设置与检查 · 同步仓库</summary>
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
<p>同步前请保存编辑并关闭其他酒馆标签页。浏览器数据库和未知脚本尚未提交的内存不在同步范围内。</p>
<button type="button" class="menu_button ts-preview-push">预览推送</button><button type="button" class="menu_button ts-preview-pull">预览拉取</button>
</details></div></div>`;
const dialog = document.createElement('dialog'); dialog.className = 'ts-dialog';
dialog.innerHTML = '<h3>同步酒馆</h3><p class="ts-phase"></p><p class="ts-detail"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-cancel" hidden>取消</button></div>';
dialog.addEventListener('cancel', event => event.preventDefault());
dialog.addEventListener('click', event => event.stopPropagation());
document.body.append(dialog);
const directionDialog = document.createElement('dialog'); directionDialog.className = 'ts-dialog ts-direction-dialog';
directionDialog.innerHTML = '<h3></h3><p class="ts-detail"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-decline">取消</button><button type="button" class="menu_button ts-accept"></button></div>';
document.body.append(directionDialog);
directionDialog.addEventListener('click', event => event.stopPropagation());
const pairingDialog = document.createElement('dialog'); pairingDialog.className = 'ts-dialog ts-pairing-dialog';
pairingDialog.innerHTML = '<h3>Google 云盘仓库配对码</h3><p>在另一台设备授权同一个 Google 账号后，粘贴此配对码加入仓库。它包含解密密钥，请保存到你自己的密码管理器；不要发到公开位置。</p><textarea class="text_pole ts-pairing-code" readonly rows="5" aria-label="仓库配对码" spellcheck="false"></textarea><p class="ts-pairing-result" role="status"></p><div class="ts-dialog-actions"><button type="button" class="menu_button ts-pairing-copy">复制配对码</button><button type="button" class="menu_button ts-pairing-close">关闭并隐藏</button></div>';
document.body.append(pairingDialog);
pairingDialog.addEventListener('click', event => event.stopPropagation());
pairingDialog.addEventListener('close', () => { pairingDialog.querySelector('.ts-pairing-code').value = ''; pairingDialog.querySelector('.ts-pairing-result').textContent = ''; });
pairingDialog.querySelector('.ts-pairing-close').onclick = () => pairingDialog.close();
pairingDialog.querySelector('.ts-pairing-copy').onclick = async () => {
    const input = pairingDialog.querySelector('.ts-pairing-code');
    try { await navigator.clipboard.writeText(input.value); pairingDialog.querySelector('.ts-pairing-result').textContent = '已复制。'; }
    catch { input.focus(); input.select(); pairingDialog.querySelector('.ts-pairing-result').textContent = '请复制已选中的配对码。'; }
};
for (const modal of [dialog, directionDialog, pairingDialog]) for (const event of ['mousedown', 'touchstart']) {
    modal.addEventListener(event, interaction => interaction.stopPropagation());
}
const scopeNames = { chats: '聊天记录（含群聊）', characters: '角色卡', worlds: '世界书' };
const scopeText = scope => scope.map(name => scopeNames[name]).join('、');
function confirmDirection(direction, scope = null) {
    const push = direction === 'push', restore = direction === 'restore', resume = direction === 'resume';
    const remote = status.provider === 'google-drive' ? 'Google 云盘' : 'VPS';
    directionDialog.querySelector('h3').textContent = resume ? '继续上次上传' : restore ? '确认恢复上一版' : push ? `确认推送到 ${remote}` : `确认从 ${remote} 拉取`;
    directionDialog.querySelector('.ts-detail').textContent = resume
        ? `将继续向 ${remote} 上传上次已保存的快照。快照之后的新聊天和修改留待下次推送。是否继续？` : restore
        ? '将恢复到最近一次覆盖前的本机配置、插件和用户数据，替换此后的本机改动。另一台设备和远端副本不会改变。本次恢复副本使用后将不再保留。是否继续？' : push
        ? `将以本机已保存的内容更新 ${remote} 同步副本，远端原有的共享数据可能被替换。是否继续？`
        : `将以 ${remote} 同步副本更新本机，覆盖本机的共享配置、插件和用户数据。应用前替换旧备份，成功后保留一份本次覆盖前的恢复备份。是否继续？`;
    directionDialog.querySelector('.ts-accept').textContent = resume ? '继续上传' : restore ? '确认恢复' : push ? '确认推送' : '确认拉取';
    if (scope) {
        directionDialog.querySelector('h3').textContent = push ? '确认分类推送' : '确认分类拉取';
        directionDialog.querySelector('.ts-detail').textContent = `仅同步${scopeText(scope)}，以${push ? '本机' : remote}为准，包含修改和删除。其他类别、配置及插件保持不变。是否继续？`;
    }
    if (['push', 'pull'].includes(direction)) directionDialog.querySelector('.ts-detail').textContent += '\n确认后自动完成传输、覆盖及删除，不再逐步询问；待上传或待下载文件总大小会在进度中显示。';
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
    const google = status.provider === 'google-drive', remote = google ? 'Google 云盘' : 'VPS';
    text('.ts-device', `${status.deviceName ?? ''} · ${google ? (status.configured ? remote : `${remote} 尚未配置完成`) : status.host || '尚未配置 VPS'}`);
    const phase = status.phase === 'DOWNLOADING' ? `正在从 ${remote} 下载` : status.phase === 'UPLOADING' ? `正在上传到 ${remote}` : labels[status.phase] ?? status.phase;
    text('.ts-phase', localError ? '本次操作未开始，请处理提示' : status.phase === 'SUCCEEDED' && status.direction === 'restore' ? '恢复完成' : phase);
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
    for (const button of root.querySelectorAll('button')) button.disabled = !terminal || starting || setupBusy;
    for (const checkbox of root.querySelectorAll('.ts-scope input')) checkbox.disabled = !terminal || starting || setupBusy;
    root.querySelector('.ts-resume-download').hidden = !status.canResumeDownload;
    root.querySelector('.ts-resume-upload').hidden = !(status.phase === 'FAILED' && !status.commit && status.direction === 'push' && status.snapshotReady === true);
    root.querySelector('.ts-resume-upload').disabled ||= !status.managed;
    root.querySelector('.ts-reconcile').hidden = !(status.maintenancePending || (status.phase === 'FAILED' && status.direction === 'push' && status.snapshotReady));
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
    if (pairingDialog.open) pairingDialog.close();
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
        status = await api('status'); if (!starting) render();
        if (!status.configured && !configLoaded) { root.querySelector('.ts-settings').open = true; loadConfiguration(); }
        if (status.phase === 'PENDING_APPLY' && status.managed && !resumed) {
            await resumePending();
        }
        if (status.phase === 'AWAITING_SAVE' && !handlingSave) {
            handlingSave = true;
            try {
                const receipt = await flush();
                const ready = await api('ready', { id: status.id, receipt, tab });
                location.assign(`${BASE}wait?${new URLSearchParams({ id: ready.id, tab, ticket: ready.ticket })}`);
                return;
            } catch (error) {
                handlingSave = false;
                if (error.code === 'OTHER_TABS') text('.ts-phase', error.message);
                else { await api('cancel', { id: status.id }).catch(() => {}); showError(error); }
            }
        }
    } catch (error) { if (!starting) text('.ts-phase', error.message); }
    setTimeout(poll, 1200);
}
setInterval(() => api('tabs', { tab }).catch(() => {}), 5000);
await api('tabs', { tab }).catch(() => {});
poll();
