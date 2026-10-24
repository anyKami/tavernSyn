# 安装与首次配置

## 前提与目录

首版支持固定的 SillyTavern **1.19.0**、Node 20 或更高版本和本机 HTTP 访问（`listen: false`）。默认同步一个管理员用户 `default-user`；其他用户用 `--profile 用户目录名` 明确绑定，不镜像账户数据库。程序核对生命周期源码指纹，版本不匹配就拒绝自动应用。

完整 TavernSyn 仓库统一安装到酒馆的 `plugins/tavernsyn`，与其他服务端插件放在一起；前端界面安装到 `public/scripts/extensions/third-party/tavernsyn`，与其他前端扩展放在一起。设备控制目录独立于酒馆，保存任务、暂存、一次恢复和 SSH 身份，必须与酒馆数据处于同一文件系统，并留足空间。Termux 使用私有 HOME，不放入 `/sdcard`。

安装前正常启动过一次酒馆，确保用户目录存在，然后关闭它。初始安装需要终端，日常同步通过界面操作。

## Windows

Windows 需要已有 Node.js 20+ 和 Git for Windows，酒馆已完成首次启动并停止。在拉取的项目目录打开 PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SillyTavernPath "D:\SillyTavern"
```

省略 `-SillyTavernPath` 会提示输入目录。脚本自动安装前后端、准备配套的 SSH/rsync，并显示启动入口。无需生成设备密钥，不需要管理员 PowerShell。

也可以只下载入口脚本再运行；找不到仓库时，会从 `anyKami/tavernSyn` 的 `main` 分支克隆到所选酒馆的 `plugins\tavernsyn`：

```powershell
$installer = Join-Path $env:TEMP 'tavernsyn-install.ps1'
Invoke-WebRequest 'https://raw.githubusercontent.com/anyKami/tavernSyn/main/install.ps1' -OutFile $installer
powershell -NoProfile -ExecutionPolicy Bypass -File $installer -SillyTavernPath "D:\SillyTavern"
```

已有目标仓库会复用，不自动覆盖或拉取代码；更新时先关闭酒馆、对仓库执行 `git pull --ff-only`，再运行安装脚本。私有仓库请先用自己的 Git 凭据克隆，再运行仓库内脚本。

从其他目录运行完整仓库的安装脚本时，安装器也会将发布代码复制到酒馆的 `plugins\tavernsyn`，生成的启动入口使用这份代码。已有旧版服务端入口会迁移，原代码备份放在酒馆根目录的 `.tavernsyn-code-backup-*` 中，避免被酒馆当成额外插件加载。TavernSyn 自身代码不进入同步镜像，拉取和恢复保留本机安装。

设备控制目录默认在酒馆同级的 `.tavernsyn-酒馆目录名`，运行库在同级 `.tavernsyn-runtime-酒馆目录名`。需要复用原自定义路径时增加 `-StatePath "D:\TavernSyn-device"`；已有官方 MSYS2 可用 `-RuntimePath "C:\msys64"`，也可用 `-Profile 用户目录名`。原先的 `node bin/install.mjs` 和 `node bin/windows-runtime.mjs` 命令仍可用于手动安装。

安装器备份 `config.yaml`，只启用服务端插件并安装自己的前后端入口，生成 `Start-TavernSyn.cmd`，保留原启动脚本。设备控制目录 ACL 仅允许当前用户、SYSTEM 和管理员访问。重新运行保留设备 ID、账号密码和 VPS 配置；发现运行中的实例、端口占用或待处理同步任务会停止安装。

双击 `Start-TavernSyn.cmd` 后，会先等待所属酒馆通过启动检查，再自动用默认浏览器打开本机地址；同步过程中酒馆重启不会重复打开网页。启动窗口同时显示酒馆输出和推送/拉取日志，包括阶段、文件变更、传输统计、SHA-256 校验与错误原因。酒馆原始输出保存在控制目录 `server.log`，同步详细日志保存在同目录 `sync.log`（时间为北京时间）；日志不记录密码或同步文件正文。

可右键启动脚本「发送到 → 桌面快捷方式」，也可在酒馆目录运行下面命令生成或更新带酒馆图标的桌面入口。快捷方式绑定原启动脚本及酒馆工作目录，双击后保留日志窗口。

```powershell
.\Start-TavernSyn.cmd --desktop-shortcut
```

运行库安装器从 MSYS2 官方 HTTPS 仓库取得元数据，逐包核对 SHA-256，只提取运行文件和许可证，不执行包安装钩子、不修改 PATH。它使用 HTTPS 元数据与包摘要，**没有独立 PGP 签名验证**。需要签名包管理验证时，使用[官方 MSYS2](https://www.msys2.org/)安装 `rsync openssh`，将设备配置 `tools.rsync`、`tools.ssh` 指向同一 `usr/bin`；不要混用 Git SSH、系统 SSH 或 WSL。

同步密码以明文 JSON 单独保存在控制目录的 `credentials/ssh-password.json`，继承受限目录权限；不会进入同步载荷、配置接口响应或命令行参数。旧设备密钥文件保留在原位置，但密码模式不再读取它们。

## Android Termux

从 [Termux 官方渠道](https://github.com/termux/termux-app#installation)安装，准备 Tailscale，正常安装并首次启动本机酒馆，然后关闭酒馆：

```sh
cd "$HOME/SillyTavern/plugins/tavernsyn"
bash install.sh "$HOME/SillyTavern"
```

脚本通过 Termux 的 `pkg` 安装 Git、rsync、OpenSSH；缺少 Node 或版本低于 20 时安装 `nodejs-lts`，已有满足要求的 Node 会保留。默认控制目录是 `$HOME/.tavernsyn-SillyTavern`；第二个参数可指定原控制目录，第三个参数可指定用户：

```sh
bash install.sh "$HOME/SillyTavern" "$HOME/.tavernsyn-device" default-user
```

没有克隆仓库时，也可以先下载入口脚本。它会自动克隆到 `$HOME/SillyTavern/plugins/tavernsyn`：

```sh
pkg install -y curl
curl -fL https://raw.githubusercontent.com/anyKami/tavernSyn/main/install.sh -o "$TMPDIR/tavernsyn-install.sh"
bash "$TMPDIR/tavernsyn-install.sh" "$HOME/SillyTavern"
```

安装结束后运行显示的 `start-tavernsyn.sh`，浏览器继续打开原本机地址。可将该入口用于 Termux:Widget。保持 Termux 前台并按系统设置允许后台运行；Android 可能回收进程，任务依靠日志恢复，唤醒锁不构成存活保证。**尚无 Android 真机验收；脚本仅完成语法与共享安装逻辑验证。**

安装器会寻找系统 npm 的 JS 入口；若依赖恢复提示缺少 npm，在设备配置设置 `npmCli`，Termux 通常是 `$PREFIX/lib/node_modules/npm/bin/npm-cli.js`。

## 新建 VPS 同步存储

VPS 已接入同一 Tailscale 网络。在 VPS 的项目目录执行：

```sh
sudo apt-get update
sudo apt-get install python3 rsync openssh-server coreutils
sudo bash vps/init.sh tavernsyn /srv/tavernsyn-sync
```

脚本自动创建数据集 UUID、专用账号和独立存储目录，随后提示设置 `tavernsyn` 的密码。记住这个密码即可，无需复制公钥或填写数据集编号。第三个参数仍可用于指定预先生成的 UUID。

脚本拒绝已存在的目录和账号，不覆盖旧酒馆。不要把旧 Docker 酒馆挂载目录当存储根。`python3 vps/discover.py` 可只读列出可能的挂载，不执行迁移。

## 旧版 VPS 切换到密码

已初始化的 VPS 更新项目代码后执行下面一条命令，存储路径替换为原先的路径：

```sh
sudo bash vps/enable-password.sh tavernsyn /srv/tavernsyn-sync
```

按提示设置账号密码。脚本保留原数据集和已发布数据，安装密码版固定入口，只为该同步账号启用密码认证；先校验有效 SSH 配置，再重载服务。配置失败会恢复修改前的 SSH 配置。原设备公钥授权不再参与此账号的登录。

已有可用账号密码时，可在命令末尾增加 `--keep-password` 保留原密码；锁定账号或未设置密码时会拒绝此选项。

SSH 配置和入口由 root 持有。同步账号没有 sudo、交互式 shell、普通 SCP/SFTP 或转发能力，只接受 Tailscale 来源的固定同步命令。持有同一账号密码的设备拥有相同同步权限；设备 UUID 用于区分任务与恢复，不再是独立的认证身份。

Tailscale ACL/grants 中也应仅允许目标设备访问 VPS SSH。本版 SSH 端口固定 22，不开同步 HTTP 或 rsync 873 服务。

## 已有密码 VPS 升级

已使用密码登录的 VPS 升级到 0.2.1 时，在新代码目录运行下面命令（数据集 UUID 可从原 `FORMAT.json` 查看）。更新器先以同步账号运行 Linux 失败恢复测试，再取得独占维护锁，备份并更新 dispatcher 与该账号的 SSH 存活检查，暂停旧任务并保留全部上传内容。密码、已发布代次和发布指针保留。

```bash
sudo python3 vps/update.py --root /srv/tavernsyn-sync --account tavernsyn --dataset 数据集UUID
```

出现 BUSY 表示仍有实际连接或传输，结束后再运行更新。客户端也需更新并重新启动，才能使用绑定任务的传输与面板续传按钮。

## 在酒馆中配置 VPS

从 `Start-TavernSyn.cmd` / `start-tavernsyn.sh` 启动酒馆，进入 **扩展设置 → TavernSyn 跨设备同步 → 设置与检查 · VPS 配置**。

1. 填写 VPS 的 Tailscale 地址、账号（默认 `tavernsyn`）和密码。
2. 点击「保存配置」，再点击「检查连接」。首次连接会自动识别数据集并保存。

密码不回显，之后留空保存会保留同一地址、同一账号的原密码；更换地址或账号必须重新输入密码。首次连接自动记住服务器身份，后续身份改变会中止连接，无需手工登记公钥。SSH 的 `accept-new` 行为见 [OpenSSH 配置手册](https://man.openbsd.org/ssh_config#StrictHostKeyChecking)。

面板不接收任意路径或命令。同步进行中、有待应用数据或需要恢复时禁止修改连接；更换 VPS 或数据集会重新建立覆盖确认基准。支持 Tailscale IPv4 或完整 MagicDNS `*.ts.net` 名称。

只安装前端扩展不足以启动同步助手，还需要运行本页的 `install.ps1` / `install.sh`。命令行也可配置，程序会隐藏密码输入，无需 `--dataset`：

```text
node bin/configure.mjs --state "D:/TavernSyn-device" --host 100.100.100.100 --user tavernsyn
```

## 第一次同步

从生成的 TavernSyn 入口启动，在扩展设置中检查连接。先用保留完整内容的设备推送，再到另一设备拉取。首次拉取会确认覆盖，保留一次恢复副本。

启动终端会实时显示酒馆和服务端插件的标准输出、错误与启动日志；受控重启后继续显示。同时保留设备控制目录中的 `server.log`，供排查历史错误。Windows 启动失败时窗口会暂停，便于读取报错。

推送和拉取均先显示方向与覆盖范围，点击确认后才保存和开始任务，取消不会启动同步；预览不需要此确认。生成中、消息编辑、未发送输入、其他活跃标签页和未确认覆盖会阻止替换。推送短暂停机创建快照，然后恢复使用并继续上传；快照之后新增内容留待下次推送。世界书、角色和脚本编辑器应先保存并关闭。

「恢复上一版」恢复到最近一次拉取前的本机数据，不修改 VPS。按钮显示可用副本的时间，没有副本或未受控启动时禁用。恢复也需要确认、保存与受控停机，启动失败时尝试回到恢复操作前的数据；成功后该次恢复副本失效。详见[恢复说明](recovery.md)。

## 更新与卸载

关闭 `Start-TavernSyn.cmd` 所在终端窗口，或按 Ctrl+C，即可停止它启动的酒馆。启动器异常退出时，酒馆也会在失去连接后退出；再次启动会检查端口和旧进程，只自动清理已死进程的锁。同步时关闭终端会中断任务，恢复记录保留，见[故障与恢复](recovery.md)。

关闭酒馆和助手，更新仓库后重新运行同一条 `install.ps1` / `install.sh`。账号密码、同步基准和恢复数据保留。助手不热更新。受控进程通过环境关闭前后端插件自动更新以固定同步版本，不改全局更新偏好。

卸载前正常关闭并备份控制目录，移除前端 `third-party/tavernsyn`、后端 `plugins/tavernsyn` 和生成的启动入口，再用原启动方式。关闭服务端插件开关前确认其他插件是否依赖它，不要把安装前整个配置覆盖回近期修改过的配置。
