# 服务端接口、保存一致性与重启核验

核验日期：2026-10-23（北京时间）。源码固定于 SillyTavern `release` / `1.19.0`，commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。本文件区分源码事实、Windows 隔离实测和待验证设计；不代表生产同步程序已经实现。

## 1. 已核对的插件合同

| 事实 | 当前源码证据 |
| --- | --- |
| 服务端插件需要显式启用，默认关闭；启动时加载 | [`src/plugin-loader.js:10–11,40–46`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L40) |
| 需要 `info.id/name/description` 字符串和 `init` 函数；可导出 `exit` | [`src/plugin-loader.js:179–227`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L179) |
| `init(router)` 只收到本插件的 Express Router；路由挂到 `/api/plugins/{id}` | [`src/plugin-loader.js:213–222`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L213) |
| 插件的异步 `exit()` 会被等待；多个插件同时执行清理 | [`src/plugin-loader.js:84–85`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L84) |
| 自动更新默认开启；固定插件版本时要在本机关闭这一行为 | [`src/plugin-loader.js:11,237–250`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/plugin-loader.js#L237) |

官方说明与上述实际加载器相符：[Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)、[配置文件中的插件开关](https://docs.sillytavern.app/administration/config-yaml/)。目录插件可使用 `package.json.main`，因此单仓库可以保留根目录 UI 扩展入口，并把服务端入口放在包的 `main` 路径，安装器再选择正确的落位方式。具体安装策略由主设计定义。

**没有发现官方的“保存所有数据”“阻止全部写入”“重启当前实例”接口。** `src/server-events.js:20` 只定义了 `SERVER_STARTED`；它的事件数据只有 URL，不能充当实例身份。不能编造 `context.restart()`、`server.saveAll()` 等接口。

## 2. 身份认证和 CSRF 挂载顺序

当前服务端的实际先后顺序为：

1. Basic Auth（特定配置下）、IP 白名单、Host 白名单：`src/server-main.js:141–150`。
2. Cookie session：`156–162`。
3. `setUserDataMiddleware`：`164`。
4. CSRF session/token 校验：`167–202`，请求头为 `x-csrf-token`。
5. 公开账户接口；随后 `requireLoginMiddleware`：`245–248`。
6. 核心私有接口：`278`。
7. 启动任务中加载插件并挂接插件路由：`312–313`。

证据：[服务端入口](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/server-main.js#L141)。由此可知，插件路由继承前置认证/CSRF；但“已登录”**不等于管理员**，插件应另外要求 `request.user.profile.admin === true`。SillyTavern 自己的管理员判断也采用该字段：[`src/users.js:1129–1139`](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/users.js#L1129)。

账户关闭时，`src/users.js:955–964` 为所有请求设置默认用户；默认用户的 `admin` 为 true（`src/constants.js:54–60`）。这不是另一个可以依赖的密码登录边界。高权限同步 API 还应默认只允许真实 loopback 来源，核对同源请求，禁止通过 `GET` 修改状态，采用严格 JSON schema；不能信任客户端自报的管理员、设备路径或进程 PID。账户启用时，应拒绝普通用户操作整个安装目录和其他用户密钥。第一版的同步账号/配置档选择必须显式绑定，避免把整个 `data` 无条件暴露给任意登录者。

如全局使用 `--disableCsrf`，原生前置保护会失效。生产插件应阻止高权限操作并给出明确修复提示，或实现经过验证的独立 session CSRF 校验；不能只是检查请求头非空。

Windows 真实隔离实测已经确认：未登录 403；已登录无 token 的 POST 403；有效 token/session 的 POST 200；添加插件自身 admin 检查后普通账户 403。见 [探针结果](restart-probe-results.md)。

## 3. 数据落盘事实与不完整的保存保证

| 数据 | 当前落盘语义 | 边界 |
| --- | --- | --- |
| 单聊 | `/api/chats/save` 等待 `trySaveChat`；后者原子同步写入后才返回成功，`src/endpoints/chats.js:532–558`；实际原子写入在 `src/util.js:1514–1520` | 只覆盖此次提交的聊天；不能保存其他浏览器标签页中的未提交内容 |
| 群组信息 | `/api/groups/edit` 原子同步写入后响应，`src/endpoints/groups.js:190–200` | 群聊消息另有保存路径，不能把群组元数据当全部群聊 |
| 设置 | `/api/settings/save` 原子同步写入请求内容，然后返回，`src/endpoints/settings.js:206–214` | 错误 catch 使用 `response.send(err)`，因此只看 HTTP 200 不足以证明 `{result:'ok'}` |
| 世界书 | `/api/worldinfo/edit` 校验后原子同步写入，`src/endpoints/worldinfo.js:134–156` | 浏览器中尚未提交的编辑不在磁盘里 |
| 角色 | `/api/characters/edit` 等待 `writeCharacterData` 后响应，`src/endpoints/characters.js:1101–1138` | 前端防抖和异步图片操作需要额外等待 |
| 密钥 | `src/endpoints/secrets.js:150` 原子同步写入 | 酒馆 API 密钥可以共享；SSH/Tailscale 凭据不纳入镜像 |
| 统计 | 定时每 5 分钟异步保存；退出钩子另作一次等待，`src/endpoints/stats.js:183–218` | 运行中扫描可能跨过内存/磁盘版本 |
| 聊天备份 | `src/endpoints/chats.js:83–99` 使用按用户/聊天划分的节流函数 | 等待当前聊天保存并不代表所有尾随备份回调已经完成 |

前端 `saveSettings()` 在设置未就绪或临时响应长度覆盖时只重新排队然后返回（`public/script.js:8051–8066`）；真正保存的异常被 catch 后提示而不向调用者抛出（`8096–8114`）。因此一次 `await saveSettings()` 或 `await saveSettingsDebounced()` 不能声明完整快照成功。还需要实际保存响应/`SETTINGS_UPDATED` 的匹配确认，并核对相应磁盘结果；不能把无关的其他保存事件当作本次 ACK。

## 4. 当前退出机制

`src/server-main.js:317–331` 的退出处理依次等待统计保存、插件清理，然后释放缓存并 `process.exit()`。它监听 `SIGINT` 和 `SIGTERM`；函数本身不导出，也没有关闭 HTTP listener 和排空在途请求的步骤。

Windows 上不能用 `child.kill('SIGTERM')` 代替优雅停机：Node 官方说明这会强制终止目标进程。见 [Node process 信号说明](https://nodejs.org/api/process.html#signal-events)、[ChildProcess.kill](https://nodejs.org/api/child_process.html#subprocesskillsignal)。Termux/Linux 上正常 SIGTERM 可以触发监听器，但仍要保证信号发给确切实例，且先完成保存与排空。

## 5. 推荐的受控 launcher/helper 方案

这是本项目的兼容适配设计，不是 SillyTavern 官方重启 API：

1. 安装器生成 Windows 启动快捷方式、Termux 启动脚本/可选 Widget。它们启动 launcher；launcher 按实例存活，不注册新的系统常驻服务。
2. launcher 使用 `child_process.fork()` 直接启动 Node bootstrap，保留父子 IPC 与 ChildProcess 对象；避免通过 `Start.bat` 再套 `cmd` 导致所有权和退出状态不清楚。参考 [官方 fork/IPC](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options)。
3. 每次启动生成随机 boot nonce，绑定已解析真实安装路径、数据根、端口和配置路径。后端/launcher 完成握手；健康检查核对 nonce 和配置，而不只是“端口有响应”或 PID 存在。
4. 当前 API 没有全局门控能力。受控 bootstrap 可在导入酒馆前包装 `http.createServer`/`https.createServer` 的请求回调；`src/server-startup.js:283,306` 在本版本使用这些入口。进入维护模式后拒绝新请求，记录在途请求并等待完成。独立插件的 `router.use()` 只能保护自己，不能阻止先前挂载的核心 API。
5. 保存确认、请求排空、活动生成/导入等业务检查均成功后，父进程发带实例身份的 IPC。子进程内部 `process.emit('SIGTERM')` 调用本版本已有的退出监听器；launcher 等真实 exit，不以“IPC 已送达”充当已退出。
6. 退出后才允许快照/替换；阶段和恢复位置写入本机持久日志。push 可先制作真正独立的本地快照，重启酒馆后再上传快照；不要让 live 数据与快照共享可被原地写入的硬链接。
7. pull 已下载且验证的候选先保留到本机独立暂存区；在受控停机后恢复设备字段、保留一次旧数据，再应用候选。新子进程健康失败时，先确认新子进程退出，再恢复旧数据和旧插件版本；不能对仍在运行的新实例回滚文件。
8. 启动后由扩展轮询受保护状态接口，确认预期 job/revision/boot nonce，重新获取 CSRF token 并刷新。浏览器恢复流程尚未实测。

**重要的生产限制：**探针仅用 `response.finish/close` 做轻量请求计数。客户端提前断连时 `close` 可能早于异步 handler 写入结束；生产版必须将未正常 finish 的连接标记为不确定并取消自动停机/应用，或使用可证明的业务保存完成机制。即使 HTTP 正常 finish，第三方插件仍可能在自己的定时器、后台进程里写文件。核心退出钩子也不能保证不合作插件的内存状态。因此“严格停机快照”只保证退出后磁盘目录稳定，并要求相关插件遵守退出保存合同；不能承诺恢复未提交的任意编辑或任意插件内存。

bootstrap 依赖当前源码创建 HTTP server 和信号清理方式。应记录受支持版本/源码指纹，在不认识的版本上关闭自动应用并进入待应用状态，不应猜测或持续猴子补丁适配。健康检查和请求门控的诊断可以帮助定位，但不等于绕过版本检查。

## 6. 降级、超时与 Termux 边界

- **非 launcher 启动的实例：**只允许下载/校验/保存 `pending-apply`；不按端口找 PID 再杀进程。UI 给出使用受控启动入口的步骤。下次启动前先确认目标实例不在运行，再恢复任务。
- **排空超时、活跃生成、保存无 ACK、插件退出不完成：**停止本次自动应用，保留旧 live 数据及待应用候选；不得超时后默认强杀。维护模式是否恢复由任务状态明确决定。
- **launcher 意外退出：**新 launcher 不能仅凭持久 PID 接管旧子进程；要确认创建时间、安装路径及实例身份。无法建立可信控制时进入人工恢复，不覆盖目录。
- **应用中断：**启动前读取持久 journal，完成或撤销同一任务；无法判断时禁止对不完整数据启动。文件恢复、依赖安装失败都必须形成明确失败/待处理状态。
- **Android：**Node IPC、独立 helper 和 POSIX 信号有合理可行性，但没有 Android 真机实测。[Termux 官方仓库](https://github.com/termux/termux-app#termux-application) 明确说明 Android 12+ 可能回收过多或高 CPU 子进程。wakelock 不能被承诺为绝对存活保障；保持 Termux 前台、按系统要求调整电池限制，并在被系统杀掉后依持久任务状态恢复。不能宣称 Termux 已达到 Windows 实测程度。

## 7. 第一阶段实测范围

详见 [restart-probe-results.md](restart-probe-results.md) 和 [`../../probes/restart-probe.mjs`](../../probes/restart-probe.mjs)。Windows 实测已验证当前 release 的实际插件鉴权以及一次停机、应用模拟数据、同端口重启链路。尚未验证真实 UI 按钮、浏览器重连、真实第三方插件、Termux、rsync/VPS、依赖恢复和崩溃回滚。完整产品需要在后续阶段补齐这些验收项。
