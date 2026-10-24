# 前端兼容性、保存确认与设置迁移调查

核查日期：2026-10-23。基线：本机 SillyTavern `release`，版本 `1.19.0`，提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。源码根目录为 `D:\SillyTavern`。

本文中的“已核实”指官方文档及本机源码核对；没有启动用户酒馆、提交保存请求、修改用户数据或完成浏览器端运行测试。下述回执协议是本项目的设计，不是 SillyTavern 已有 API。

## 1. 已核实的前端接入方式

官方建议通过 `SillyTavern.getContext()` 使用扩展能力，内部模块导入更容易随版本变化。扩展面板使用异步模板渲染和 `#extensions_settings2` 容器；持久设置使用独立的 `extensionSettings` 命名空间。参见 [UI Extensions 官方文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。

| 能力 | 1.19.0 实际接口/位置 | 设计使用方式 |
| --- | --- | --- |
| 稳定入口 | `public/script.js:292–296`，全局对象包含 `getContext` | 每次操作重新取得 context，避免长期保存聊天相关引用 |
| 请求头 | `public/scripts/st-context.js:129`、`public/script.js:647–657` | `getRequestHeaders()` 返回 JSON Content-Type 和 `X-CSRF-Token`；后端仍须自行检查用户/管理员权限 |
| 设置与聊天保存 | `st-context.js:132,155,158` | `saveSettingsDebounced`、`saveChat`、`saveMetadata`，完成语义见下节 |
| 模板和对话框 | `st-context.js:191,195,224–226` | `renderExtensionTemplateAsync`、`callGenericPopup`/`Popup`，只在异常覆盖/重启风险时确认 |
| 持久设置及状态读取 | `st-context.js:201,227–229` | `extensionSettings`、`chatCompletionSettings`、`textCompletionSettings`、`powerUserSettings` |
| 世界书/预设 | `st-context.js:278–288` | `loadWorldInfo`、`saveWorldInfo`、`getPresetManager`；不是全局“保存全部编辑器”接口 |
| 生命周期 | `public/scripts/events.js:4–5,23–25` | `APP_READY` 后挂载面板；订阅生成开始/结束事件，但不能仅靠事件推断扩展加载前已开始的生成 |
| 扩展脚本加载 | `public/scripts/extensions.js:813–835` | 从 manifest 指定路径创建 `type="module"` 的脚本；根 manifest 可令 `js` 指向 `ui/index.js` |

源码永久链接：[context](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/st-context.js#L115)、[事件枚举](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/events.js#L3)、[扩展加载](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/extensions.js#L813)。

`getContext()` 没有立即执行的 `saveSettings`、全局 `flushAll`、`restart` 或 `isGenerating`。当前 `public/script.js:603–604` 导出 `is_send_press` 和 `isGenerating()`，其中 `isGenerating()` 同时检查单聊/群聊；直接导入它属于 **1.19.0 版本绑定适配**，不能称为稳定 context API。自动保存/重启应有版本检查，未知版本停止自动流程并说明原因。

## 2. 保存操作的真实完成语义

| 操作 | 已核实行为 | 不能据此推断的结论 |
| --- | --- | --- |
| `saveSettingsDebounced()` | `public/script.js:470` 使用 `utils.js:574–583` 的 `debounce`；它只安排定时器，不返回保存 Promise。默认编辑延迟见 `script.js:466`、`constants.js:14`，为 1000 ms | `await saveSettingsDebounced()` 不会等待磁盘保存；等待固定一秒也不是可靠屏障 |
| 内部 `saveSettings()` | `script.js:8051–8066` 在设置未准备好/临时生成长度覆盖时可再次排队后返回；`8096–8114` 发起 HTTP 请求并吞掉错误 | 即使导入内部函数并 await，也不能把正常返回等同于成功 |
| `SETTINGS_UPDATED` | `events.js:30`，实际发送位置 `script.js:8110`；**无参数、无保存编号、无文件摘要** | 同一事件可能属于其他保存；它不能证明某次任务的期望值已经落盘 |
| `/api/settings/save` | `src/endpoints/settings.js:206–215` 使用 `writeFileAtomicSync` 后返回 `{result:'ok'}`；catch 分支使用 `response.send(err)`，没有明确设为错误 HTTP 状态 | 只检查 HTTP 200 不足，前端原生事件也可能不足；应检查回执和服务端磁盘读取结果 |
| `context.saveChat()` / `saveMetadata()` | 映射到 `saveChatConditional()`；`script.js:9408–9438` 等待另一次保存结束，超时会返回；保存异常也会被 catch 吞掉。内部 `saveChat()` 的 catch 位于 `7476–7478` | await 正常返回不能作为聊天已保存证明 |
| 单聊/群聊后端保存 | `src/endpoints/chats.js:532–542,545–568,922–945`；JSONL 写入前检查 integrity，写入后返回 `{ok:true}`。实际写入使用 `src/util.js:1514–1520` 的原子写文件 | 这只证明被提交的请求已处理，不证明其他编辑器、标签页或插件都已提交 |
| `context.saveWorldInfo(name,data)` | `world-info.js:4177–4189` 默认只安排防抖；第三参 `true` 才 await `_save`。`_save:4151–4160` 没有检查 `response.ok` 就发出 `WORLDINFO_UPDATED(name,data)` | 世界书事件带 name/data，但也不构成保存成功回执 |
| 角色编辑 | `script.js:471` 的 `saveCharacterDebounced` 通过触发现有按钮保存 | 不存在已核实的“提交当前所有未完成表单”的统一官方接口 |

源码：[设置保存](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L8051)、[聊天保存](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/script.js#L9412)、[防抖实现](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/utils.js#L574)、[设置后端](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/endpoints/settings.js#L206)、[世界书保存](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/world-info.js#L4151)。

事件枚举中没有 `CHAT_SAVED`、`SETTINGS_SAVED` 或“全部保存完成”事件。`ITEMIZED_PROMPTS_SAVED` 是提示信息浏览器缓存事件，不能替代聊天落盘确认。`MESSAGE_RECEIVED`、`CHAT_CHANGED`、`CHARACTER_EDITED`、`WORLDINFO_UPDATED` 也不是目录快照屏障。

## 3. 推荐的保存确认流程（待实现、待运行验证）

默认采用“确认已保存 → 受控停机 → 文件快照”。运行中 rsync 只可提供明确标记的较弱模式，不能声称得到整目录一致性快照。

### 3.1 设置保存回执

1. 本插件后端创建任务，固定当前已认证用户、当前实例、任务 nonce 和超时时间。nonce 是随机一次性值，不是凭据。任务状态放在普通镜像以外。
2. UI 进入维护状态：停止接收新编辑，检查生成/流式输出和正在提交的编辑器；已打开且有未提交内容的角色/世界书/预设编辑器先按其原生方式完成保存，无法确认则阻止开始。单纯 blur 不保证所有编辑器已提交。
3. 在调用保存前订阅 `SETTINGS_UPDATED`。把 nonce 写入本插件独立的 `extensionSettings.tavernsyn.flushReceipt` 字段，取得本次要核对的设置投影，然后调用 `saveSettingsDebounced()`。该事件仅用于唤醒检查；同时允许有界轮询，不能无限等事件。
4. 本插件的受保护 API **自行从当前用户 settings.json 回读**，检查 nonce 和可访问的期望设置投影。nonce 使其他标签页的旧保存不能冒充本次保存完成。未读到预期值、JSON 无法解析或超时均失败，不能据事件或 HTTP 200 放行。
5. 后端仅在本机受限任务状态中保存回执及文件摘要。响应只返回任务状态、摘要匹配与错误类别；不把完整设置、API 密钥或回读内容写入日志。该检查接口不是任意路径读取接口。
6. Helper 停止实例后再次核对 settings.json 与回执中的摘要。期间发生写入则重新确认或终止任务；不能把旧回执直接用于新的文件内容。
7. 普通镜像中的 settings.json 通过结构化转换移除 `extension_settings.tavernsyn`；拉取时保留本机此命名空间。这样同步插件连接配置、回执和任务状态不会混入共享数据。成功/失败后均按本机流程清理临时回执。

该方案利用官方的持久设置命名空间，但 **nonce 协议、磁盘验证 API、超时和任务锁属于本插件**。完整设置 payload 在 `script.js:8069–8094` 生成，并未通过一个稳定 context 方法完整暴露；只能验证 context 可取得的期望投影，不能由此担保未知扩展尚在独立内存中的数据。

### 3.2 聊天保存确认

1. 保存前固定 `chatId`、角色 avatar/群组标识、`chat` 和 `chatMetadata` 的结构化副本，生成本次期望 JSONL 内容的规范化摘要。包含全部消息及 metadata，不能仅检查条数、最后一条文本或修改时间。
2. 调用 `context.saveChat()`，之后由本插件后端映射已认证用户的受限目录、解析实际目标 JSONL，并与期望内容核对。单聊后端路径规则见 `chats.js:548–552`；群聊规则见 `928–934`。不得让浏览器直接指定任意文件路径。
3. 1.19.0 的 `trySaveChat` 使用传入对象逐行 `JSON.stringify`，见 `532–541`；前端保存 header 格式见 `script.js:7427–7444` 和 `group-chats.js:631–640`。规范化应显式适配这些字段，保留 integrity 元数据，禁止通过 `force:true` 绕过酒馆完整性检查。
4. `context.saveChat()` 超时、无当前角色临时聊天、聊天切换、integrity 弹窗、HTTP 失败、文件不一致，都不得进入停机同步；聊天标识必须在任务内保持稳定。
5. 停机后再次核对文件摘要，之后才允许从稳定文件树创建快照。

### 3.3 必须公开的限制

- 固定等待窗口或文件连续若干秒未变化是辅助信号，不能证明未知扩展没有更长的定时器。
- 其他标签页、另一浏览器、网络客户端都可能继续写入。单页遮罩不等于实例写锁。实施前必须确定所有活动客户端的处理策略；无法确认时阻断严格模式，或明确让用户关闭其他客户端。
- 未知前端扩展可以在独立内存中持有尚未保存的状态；未知服务端插件也可能后台写文件。仅调用官方保存函数不能覆盖这些状态。没有适配器/可确认停机契约的插件必须列出限制。
- 停机保证的是已落盘目录在复制期间稳定，不会自动提交浏览器表单。重启后旧页面也可能重放陈旧请求；维护标识、页面刷新和请求恢复顺序需要单独验证。
- 严格模式的诚实承诺是“已确认保存并冻结的受支持状态，加停机后的文件快照”，而非“任意第三方脚本的一切内存均已保存”。

### 3.4 轻量等待页对旧页面写回的保护（设计审查，未实测）

建议在所有已登记标签页完成保存后，让它们执行真正的文档导航，进入本插件提供的受保护等待页。该页面不加载酒馆应用脚本；等待页加载后显式向后端确认自己已进入等待状态。收到这些确认、完成后端请求排空后才交由 Helper 停机。停机期间等待页显示“正在应用或重启”，只轮询同源酒馆；重启健康后读取持久化任务阶段，再导航回原来的已验证同源页面。该设计不需要 Helper 增加常驻 HTTP 服务，比单纯禁用按钮更能减少旧状态重放。

但以下限制必须保留：

- `beforeunload`/`unload`/`pagehide` 不是可靠的保存确认；移动端进程可直接被系统终止。必须依据**新等待文档实际加载并上报的确认**，超时不能伪造成功。`history.replaceState` 只改 URL，不会卸载旧脚本；应执行文档导航。
- 浏览器可能通过 BFCache 冻结旧文档，而不是销毁其 JavaScript 状态。用户返回旧历史项时，旧定时器/状态可能恢复。`location.replace` 可减少当前历史项返回风险，不能消除所有旧历史项；也不能把 `Cache-Control: no-store` 当作所有浏览器永久禁用 BFCache 的保证。
- `pageshow` 且 `event.persisted` 时应核对实例 epoch 并重新加载，但前端扩展比核心应用或其他扩展更晚初始化，不能保证旧写请求在检查前完全不发生。若要给出强保证，需要对所有相关写请求施加服务端 epoch/维护屏障；这是待实现且需浏览器测试的适配，**不是已核实的官方 API**。
- BroadcastChannel/心跳只能协调同一存储分区和相应 origin 内已经登记的标签页。`localhost` 与 `127.0.0.1`、不同浏览器/配置文件、隐私窗口、未安装扩展页面、休眠或失联页面，都可能不在登记范围内。无法确认的活动客户端必须阻断严格操作或明确要求关闭。
- 等待页不能依赖停机期间可访问服务端，也不能用前端内存推断成功。状态查询需继续受认证保护；任务编号不得充当无认证的管理凭证，恢复 URL 必须限制为已验证同源相对地址。

验收应覆盖正常导航、导航确认丢失、手机切到后台、浏览器杀进程、返回历史/BFCache、其他 hostname、重复标签页、未登记浏览器，以及重启后核心脚本先于扩展开始写入的情形。目前只完成设计审查，未做实际浏览器验证。

## 4. settings.json 的设备差异

不整体排除 settings.json，也不对未知 JSON 做字符串替换。采用受版本管理的 **JSON Pointer 保留表**，拉取前从本机读取这些精确路径，合并到已验证的新文件，再原子应用。只处理列出的字段；未知字段默认共享。保留“本机不存在该字段”与“值为 null”的区别，避免从远端意外补回本机已删除的设备字段；类型异常时终止或要求人工处理。合并器必须拒绝危险原型键。

| 精确路径候选 | 推荐默认 | 源码依据/理由 |
| --- | --- | --- |
| `/extension_settings/tavernsyn` | 保留本机且从共享镜像剥离 | 本插件专属配置、回执，属于设备层 |
| `/power_user/movingUI` | 保留本机 | `power-user.js:173`，窗口布局模式 |
| `/power_user/movingUIState` | 保留本机 | `power-user.js:174,1007–1015`，窗口位置/尺寸 |
| `/power_user/movingUIPreset` | 保留本机 | `power-user.js:175,1445–1451`，当前设备布局预设选择；预设资源文件本身仍可共享 |
| `/power_user/chat_width` | 保留本机 | `power-user.js:144,1087–1101`，屏幕相关宽度 |
| `/power_user/font_scale` | 保留本机 | `power-user.js:155,1175–1184`，设备显示尺度 |
| `/power_user/fast_ui_mode`、`/power_user/blur_strength` | 高级选项，默认共享 | `power-user.js:140,156,960–967`；性能差异确有依据，但也属于用户主题偏好，不扩大默认保留范围 |
| `/accountStorage/LNavLockOn`、`/accountStorage/LNavOpened`、`/accountStorage/NavLockOn`、`/accountStorage/NavOpened`、`/accountStorage/SelectedNavTab`、`/accountStorage/WINavOpened` | 高级选项，默认共享 | `util/AccountStorage.js:16–20,29,32`；侧栏状态可选择本机保留 |
| `/accountStorage/Characters_PerPage`、`/accountStorage/GroupMembers_PerPage`、`/accountStorage/Personas_PerPage`、`/accountStorage/WI_PerPage` | 高级选项，默认共享 | `AccountStorage.js:8,14,21,33`；分页可能随屏幕变化，但不是强制设备字段 |

网络监听、服务端端口、`dataRoot`、服务器路径等位于 config.yaml，建议整个 config.yaml 保留本机；不能通过上述表把整份服务器配置混入共享设置。模型 API 连接地址和 API 密钥按需求共享；`localhost` 模型服务地址是否适用另一设备，需要显式可选覆盖表，不能把全部 API 地址自动判为设备字段。

`accountStorage` 并非纯浏览器状态：`script.js:8071` 将 `accountStorage.getState()` 写入 settings.json；`AccountStorage.js:51–77` 会迁移一组旧 localStorage 键。因此不能整体排除 `accountStorage`，也不能声称所有原 localStorage 设置都不会迁移。

源码：[设备显示设置](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/power-user.js#L116)、[AccountStorage](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/public/scripts/util/AccountStorage.js#L4)。

## 5. Git 前端扩展的恢复

官方用户文档提供 Git URL 安装、启用/禁用和更新入口，参见 [Extensions 官方说明](https://docs.sillytavern.app/extensions/)。本机源码进一步确定：

- `/api/extensions/install` 接受 `{url,global,branch}`，仅 HTTP/HTTPS URL，以 depth=1 克隆；全局安装要求管理员。依据 `src/endpoints/extensions.js:92–138`。
- `/api/extensions/version` 返回 `currentBranchName/currentCommitHash/isUpToDate/remoteUrl`，见 `387–427`。
- `/api/extensions/switch` 接受已知本地分支或 `origin/*` 分支，见 `266–319`；**不是任意 SHA checkout API**。
- 启用状态来自 `extension_settings.disabledExtensions`，见 `public/scripts/extensions.js:475,492,626`，随 settings.json 迁移；必须保持 `third-party/<目录名>` 标识一致。

建议清单包含安装范围、目录名、仓库 URL、实际 commit、branch、manifest 版本、启用状态、本地修改标志。Helper 在自己的暂存区恢复各设备自己的 Git 工作区与 `.git`，再把可移植未跟踪资源/本地改动按受限覆盖表纳入，不镜像另一个平台的 `.git`、`node_modules` 或原生构建产物。精确 SHA checkout 属于 Helper 的项目实现，不能包装成官方原生能力。无法从仓库取得该版本或存在未覆盖的本地修改时明确失败/待处理。

固定版本与原有更新能力应同时保留：恢复本次清单所指定 commit，保留 origin；用户以后仍可更新，但更新后两端版本可能不同，下一次清单应记录新的实际状态。自动更新须在恢复事务内暂停，否则启动时可能立即偏离指定版本；暂停与恢复策略需测试，不能偷偷改写扩展源码。

## 6. 当前两个扩展的迁移调查

以下为本机核查时的代码版本；没有输出用户脚本、聊天、设置值或密钥。

| 扩展 | 本机代码 | 已核实的持久化位置 |
| --- | --- | --- |
| [JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) | manifest `4.11.3`；main；commit `cee1fb4503679efeaba0def4d42d19eaf87bd29c` | `src/type/settings.ts:3` 的命名空间为 `tavern_helper`；`store/settings/global.ts:59–65` 写入 `extension_settings` 后调用 `saveSettingsDebounced`；`store/settings/chat.ts:33–42` 写入 chat metadata 后防抖保存；`store/settings/character.ts:45–48` 写入角色扩展字段；`store/settings/preset.ts:18–36` 同时更新当前 OAI 设置和预设文件，预设文件保存另有 1000 ms 防抖 |
| [ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template) | manifest `1.17.9`；main；commit `d6f520d149aba146305b0b781ddd691d449c28d2` | `src/modules/ui.ts:60–80,137–156` 使用 `extension_settings.EjsTemplate`；`src/function/variables.ts:54–56,310–324` 使用全局 variables 和 chat metadata variables；模板/世界书/正则等还依赖相应用户文件 |

这说明仅同步 extension_settings 会遗漏角色、聊天 metadata 和预设中的脚本/变量。应共享完整的用户可移植文件树，并在恢复后按清单确认两个扩展版本和目录名。

JS-Slash-Runner 的脚本结构 `src/type/scripts.ts:18–32` 包含 `enabled/content/data/button`；脚本通常是任意 JavaScript 内容，不是一个统一的 CDN URL 字段。URL、参数和版本可能藏在脚本内容、角色卡、预设或世界书中。完整保留原始持久文件优先；URL 静态提取只作清单提示，不能作为唯一恢复来源，也不能对任意脚本做文本改写。

此外，JS-Slash-Runner 自身的 `src/iframe/third_party_script.html:1–2` 引入未固定版本的 Vue/Vue Router CDN，`src/panel/script/iframe.ts:14` 引入未固定 commit 的远程脚本。即使扩展 Git commit 相同，也不能声称全部远程依赖已可复现；应显示“远程脚本版本未固定”限制，不能擅自替换第三方资源。

### 浏览器存储限制

- ST-Prompt-Template 的代码编辑器 `src/modules/code-editor.ts:827,864,908` 在 localStorage 中使用 `st_monaco_editor_settings`。普通文件同步不能搬运它；第一版记录为本机编辑器偏好，不声称已同步。
- 酒馆自身 `public/scripts/tokenizers.js:157,174,184` 的 tokenCache 和 `public/scripts/itemized-prompts.js:15,29,52` 的提示信息通过 localforage 存储在浏览器，普通目录镜像无法搬运；这些缓存可重建，不等于聊天丢失。
- CDN 脚本可能自行使用任意 localStorage/IndexedDB 或跨源 iframe 存储。本次未运行这些用户脚本，因此无法确定其全部浏览器数据，必须标为未核实。第一版不复制浏览器数据库，不导出浏览器 cookie、SSH 或 Tailscale 身份。

## 7. 后续必须完成的运行测试

1. 从同一仓库安装 UI，验证面板、模板、CSRF 请求和首次配置反馈；本调查仅确认源码接点。
2. 设置保存成功、磁盘写入失败、HTTP 200 但错误 body、保存防抖重排队、事件未触发、其他标签页保存等场景下，验证 nonce 回执不会误报。
3. 单聊、群聊、聊天切换、无当前聊天、生成中、integrity 冲突、保存超时，验证期望内容与 JSONL 回读匹配。
4. 未提交的角色/世界书/预设编辑器、JS-Slash-Runner 预设防抖、未知定时写入插件，验证无法确认时严格模式停止。
5. 拉取后验证设备字段的存在/缺失/null/类型异常以及未知字段保持策略；恢复回退时本机覆盖表仍正确。
6. 固定版本恢复、不可访问仓库、浅克隆的历史 commit、扩展自动更新、本地修改、无 Git 元数据扩展等恢复路径。
7. Windows 与 Android 的真实浏览器验证页面维护、重连、刷新及旧请求不会覆盖新数据；目前均未完成该端到端验证。
