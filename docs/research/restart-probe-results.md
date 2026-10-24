# Windows 隔离重启技术探针：实际结果

日期：2026-10-23。结果：**通过**。这是第一阶段的技术可行性探针，不是已经可安装的同步插件，也不代表跨设备同步验收通过。

## 环境和隔离方式

- 平台：Windows / `win32`，Node `v25.8.2`。
- 研究对象：SillyTavern `release` / `1.19.0`，commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。
- 通过 `git archive` 创建完全独立的源码副本；原安装的 `node_modules` 通过本机 junction 复用，仅作依赖读取。
- 全部用户数据由隔离副本自己初始化，额外文件仅有模拟的 `probe-user.json` 等；没有复制真实聊天、设置、密钥或扩展数据。
- 测试地址为临时选择的 `127.0.0.1:62141`；真实酒馆的 8000 端口未用于本探针。
- 副本：`tavernSyn/.tmp/restart-probe-nJ7CIH/SillyTavern`。
- 原始结果：`.tmp/restart-probe-nJ7CIH/results.json`；日志：同目录 `server-0.log` 和 `server-11.log`。这些文件属于临时测试产物，不应发布到 Git 仓库。
- [可随项目保留的结果 JSON](../test-results/windows-restart-2026-10-23.json)去掉了临时副本的绝对路径，保留实际环境、端口、断言和未测试项。

## 已真实运行的检查

| 检查 | 实际观察 |
| --- | --- |
| 原生插件机制 | 副本加载测试 `info/init/exit`；API 位于 `/api/plugins/sync-probe/` |
| 未登录认证 | 插件 GET 返回 **403** |
| 继承 CSRF | 登录后，缺少 token 的插件 POST 返回 **403**；有效 session/token 返回 **200** |
| 插件管理员权限 | 通过真实账户管理 API 新建普通测试用户；该用户登录后访问插件返回 **403** |
| IPC 实例绑定 | 错误 nonce 的消息返回 `denied` |
| 未受控分支 | 模拟未托管身份，插件重启请求返回 **409**，没有发送终止命令 |
| 新请求门控 | 启动 500ms 测试请求后进入维护模式；新请求返回 **503** |
| 正常请求排空 | 既有请求返回 **200** 后，父进程才收到 `drained` ACK |
| 排空超时 | 500ms 请求配 30ms 排空期限，返回 `drain-timeout`；继续请求关机返回 `refused`，子进程仍然存活且保持维护模式；显式 resume 后继续运行 |
| 真正退出 | 父进程发送经 nonce 验证的 shutdown IPC；子进程内部 emit SIGTERM；ST 等待带 20ms 延迟的测试插件 exit hook 写入标记；父进程观察到 **exit code 0** |
| 退出后应用 | 确认前一个 child exit 后，才把模拟文件从 revision 1 改为 revision 2 |
| 同实例配置重启 | 使用同一 fixture、config、dataRoot 和端口重新启动；健康 API 返回本次新的 boot nonce，并读到 revision 2 |
| 测试清理 | 第二个子进程也完成 exit hook 并以 **0** 退出；独立本机端口检查显示 **62141 无监听** |

“未受控分支”只检查了模拟身份被拒绝，没有测试真实的手工启动实例自动接管；设计明确不采用自动接管/按端口杀进程。

## 可复现入口

在项目目录运行（命令只应针对当前固定研究版本）：

```powershell
node probes/restart-probe.mjs 'D:\SillyTavern'
```

脚本使用随机闲置端口和新的 `.tmp/restart-probe-*` 副本；源 commit 不匹配时直接拒绝运行。需要已有 Git、系统 tar、Node，以及源安装已装好的依赖。测试会占用约数十 MB 源码空间并生成自己的前端缓存；不进行联网安装、不访问 VPS。

相关脚本：

- [`restart-probe.mjs`](../../probes/restart-probe.mjs)：创建隔离副本、驱动 HTTP/IPC、断言结果和记录实际输出。
- [`managed-bootstrap.mjs`](../../probes/managed-bootstrap.mjs)：捕获本版本 HTTP/HTTPS 创建入口，维护请求门控，接受父进程消息并触发酒馆已有退出监听器。
- [`fixture-plugin.mjs`](../../probes/fixture-plugin.mjs)：仅供探针的原生 server plugin，提供健康/延时接口和异步退出标记。

本机工具的受限网络环境不用于代表正常用户网络；实际本地 HTTP 测试在允许 loopback 的正常本机执行环境中完成。

## 不能由本探针推导的结论

- 没有真实浏览器按钮、页面恢复或移动端浏览器操作；实际通过 Node HTTP 客户端驱动。
- 没有验证 Android Termux、Android 省电/后台进程回收。
- 没有使用 rsync、SSH、Tailscale 或 VPS，不能声明双向增量同步可用。
- 没有验证聊天/世界书/图片/API 密钥的完整迁移、Git/CDN/服务端插件恢复、原生依赖恢复。
- 没有验证崩溃 journal、Windows 重命名故障、磁盘不足、回滚和权限失败。
- 只验证正常结束的 HTTP 请求。探针的 `finish/close` 计数不能直接作为生产严格写入屏障：中途断连及响应后仍写入的异步 handler 尚未覆盖。
- 没有载入真实第三方插件；后台写入及不合作的退出 hook 仍可能破坏保存完整性。
- `process.emit('SIGTERM')` 和 HTTP 创建回调包装是本项目的版本绑定适配，不是官方公开重启 API。要在生产启用，需增加支持版本检查、失败关闭和更完整故障测试。

本阶段结论仅为：**在当前 Windows + SillyTavern release 版本中，独立 launcher 持有控制权时，可以保留后台进程、在子进程内部触发现有清理链路、等待真实退出后应用模拟数据，再于同配置和端口启动一个可识别的新实例。**
