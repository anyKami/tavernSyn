# TavernSyn

SillyTavern 跨设备手动同步插件，面向 Windows 和 Android Termux。设备各自运行酒馆，独立 VPS 只保存同步数据；日常使用「推送到 VPS」「从 VPS 拉取」两个按钮。

## 当前版本

**0.2.7，适配 SillyTavern 1.19.0。** 包含 0.2.6 新增的聊天记录、角色卡、世界书分类增量推送和拉取，并修正 Linux 增量测试的同秒时间戳依赖。可单选或组合，包含删除；其他配置、插件及用户数据保持不变。需要同步更新本机前后端与 VPS。[分类同步说明](docs/scoped-sync.md)、[更新记录](CHANGELOG.md)、[增量实测](docs/incremental-sync.md)与[审查修复及限制](docs/review-fixes.md)。

本版本已清理旧 Git 历史，已有旧克隆请重新克隆后更新，见[历史清理说明](docs/security-audit-0.2.0.md#历史清理)。

## 已实现

- 原生前端扩展、管理员服务端接口和独立受控启动器，同一个仓库安装。
- 分类增量推送/拉取聊天记录（含群聊）、角色卡和世界书，支持组合选择、差异预览、删除确认、无变化快速结束和仅恢复本次范围。
- 酒馆内填写 VPS 地址、专用账号和密码，保存后立即生效；自动识别数据集和记住首次连接的服务器身份。
- 推送和拉取均先确认方向；「恢复上一版」恢复最近一次拉取前的本机数据，并检查重启结果。
- 完整用户目录和自定义持久化子目录，包含聊天、角色资源、世界书、预设、API 配置与密钥。
- 插件工作文件、固定版本、分支及精简 Git 对象；保留本地修改，目标分别恢复 Node 依赖。
- 精确保留本机设置字段；网络、端口、账户和基础设施凭据留本机。
- 推送前核对设置和当前聊天落盘，优雅退出制作独立快照，重启后上传。
- 拉取暂存、SHA-256 校验、未推送修改确认、替换日志、一次恢复及健康失败回滚。
- 重启后拒绝旧页面写入，等待页重连并返回酒馆。
- rsync 增量、删除镜像、等长等时间戳文件校验补传，以及实际协议字节统计。
- VPS 专用账号、密码登录与固定 SSH 命令、独立存储根、锁、只读下载代次和原子发布。
- 传输中断后保留暂存并释放任务占用，支持继续上次上传；迟到的旧连接不能接入新任务。
- Windows / Termux 启动成功后自动打开默认浏览器，控制台显示酒馆和推送/拉取详细日志；Windows 可创建桌面快捷方式。
- 新安装生成的 Windows / Termux 入口在启动前检查 TavernSyn 稳定版本并更新后端与配套前端；Termux 安装器可将此流程接入兼容管理工具的选项 4。
- 未受控启动时只下载待应用；下次受控启动并打开酒馆后继续保存、确认和应用。

## 开始使用

先完成酒馆首次启动，再关闭它。拉取本仓库后，只需运行本机安装脚本。

Windows（需要已有 Node.js 20+ 和 Git）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

安卓 Termux：

```sh
bash install.sh "$HOME/SillyTavern"
```

脚本将完整代码安装到酒馆的 `plugins/tavernsyn`，前端界面安装到 `public/scripts/extensions/third-party/tavernsyn`，与其他插件放在一起。启动入口实时显示酒馆和插件日志，并保存一份到设备控制目录的 `server.log`。自动准备 SSH/rsync，无需生成设备密钥。重新运行保留设备 ID、账号密码和 VPS 配置；使用过自定义控制目录时，通过 `-StatePath` 或安卓脚本的第二个参数传入原目录。也支持只下载入口脚本、自动克隆仓库，见[安装指南](docs/installation.md)。

然后按[安装指南](docs/installation.md)新建 VPS 存储并设置 `tavernsyn` 账号密码。使用生成的 `Start-TavernSyn.cmd`（Android 为 `start-tavernsyn.sh`）启动，在「扩展设置 → TavernSyn → 设置与检查 · VPS 配置」填写 VPS 地址、账号和密码，保存后检查连接。旧版 VPS 运行 `sudo bash vps/enable-password.sh tavernsyn /srv/tavernsyn-sync` 切换到密码登录。

正常使用无需额外 npm 包，配置解析使用已安装酒馆的 `yaml`；开发测试用 `npm ci` 安装 `ssh2` 测试服务器。Windows 便携工具安装到独立目录，已有可用工具会复用；不改系统 PATH 或 Git。也可用官方 MSYS2 的 `pacman -S rsync openssh bash`，指向同一套工具。[MSYS2 包管理说明](https://www.msys2.org/docs/package-management/)

## 文档

- [Windows / Termux / VPS 安装与更新](docs/installation.md)
- [版本更新记录](CHANGELOG.md)
- [同步范围、设备字段与插件恢复](docs/scope.md)
- [分类增量同步：聊天、角色卡和世界书](docs/scoped-sync.md)
- [断线重试、故障处理与手动恢复](docs/recovery.md)
- [实现说明、实测结果与限制](docs/implementation.md)
- [0.2.5 增量优化实测](docs/incremental-sync.md)
- [0.2.5 审查修复与故障注入](docs/review-fixes.md)
- [0.2.1 发布检查](docs/security-audit-0.2.1.md)
- [0.2.2 启动更新检查](docs/security-audit-0.2.2.md)
- [0.2.0 敏感信息扫描](docs/security-audit-0.2.0.md)
- [设备配置示例](device.example.json)
- [原始需求](docs/requirements-v2.md)与[第一阶段设计](docs/technical-design.md)

## 验证

测试使用独立目录和模拟数据。先运行 `npm ci`，准备固定版本酒馆及依赖，将 `SILLYTAVERN_SOURCE` 指向它；Windows 可用 `TAVERNSYN_TEST_RUNTIME` 指定 MSYS2 运行库根目录。

```text
node --test tests/*.test.mjs
python -m unittest discover -s tests -p "test_vps*.py" -v
node tests/rsync.mjs
node tests/integration.mjs
```

集成测试运行真实酒馆副本，远端由内存适配器模拟。`password-ssh.test.mjs` 另用真实 OpenSSH、rsync 和本机 SSH 测试服务器验证密码登录、双向传输、错误密码及服务器身份变化。它不代替真实 Tailscale 和 Linux dispatcher/flock 验收。GitHub Actions 提供 Linux 检查入口；本地验证范围与平台跳过项见实测记录。

镜像含明文聊天和酒馆 API 密钥，仅供可信设备使用。同步账号密码单独保存在设备受限控制目录，不进入镜像、不在接口中回显；不要将设备状态或密码文件提交到 Git。
