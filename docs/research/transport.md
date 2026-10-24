# 传输、VPS 发布与完整性调查

核对日期：2026-10-23。本文以第一阶段技术设计为基础，认证部分已按 0.1.2 的密码登录更新。当前测试覆盖真实 MSYS2/OpenSSH 密码登录和本机 rsync 双向传输；没有连接用户 VPS 或使用 Android 真机。完整进度见[实现报告](../implementation.md)。

## 1. V1 推荐结论

采用本机 Node Helper、系统 rsync/OpenSSH、VPS 专用低权限账户和一个按 SSH 会话启动的 Python 3 控制程序。VPS 不运行酒馆，不增加 HTTP 服务，也不监听 rsync 的 873 端口。

文件传输选择 rsync 官方的 **daemon-over-SSH**：通过显式 `--rsh` 启动一次性、使用受限模块的 rsync 进程。模块根目录由 VPS 控制程序生成，浏览器不能提交远端绝对路径、命令或 rsync 参数。该方式由官方支持，但其在本项目中的组合仍需第二阶段验证。[rsync 官方：通过远程 shell 使用 daemon 功能](https://download.samba.org/pub/rsync/rsync.1)

V1 只允许一个远端同步任务，拉取也占用同一个任务锁。默认使用独立暂存副本，不使用硬链接。每次源快照生成一次完整 SHA-256 清单，新接收的暂存树再做一次完整校验；rsync 不额外使用全树 `--checksum`。这两次扫描分别建立源内容身份和证明接收结果，属于明确的数据保护成本。增量节省的是网络流量，不能承诺完全没有本地读盘。

## 2. 远端目录与初始化边界

以下是逻辑布局，根目录可由管理员在初始化时自定义：

```text
<sync-root>/
  FORMAT.json                 数据集 UUID、协议版本；初始化标识
  current.json                仅指向最新有效 generation
  previous.json               最低限度恢复指针
  incoming/<job-id>/
    payload/                  唯一允许上传的内容目录
    manifest.json             通过控制协议提交，经大小和结构限制
  generations/<generation-id>/
    payload/
    manifest.json
    COMPLETE.json
  private/
    operation.lock            控制会话独占锁
    transfer.lock             传输共享锁 / 发布与清理独占锁
    active.json               当前任务与控制进程身份
    active-rsyncd.conf        仅暴露当前任务的一个模块
    journal.json              可恢复的发布状态
```

`incoming`、`generations` 和指针必须位于同一文件系统。根目录是初始化时选定的空专用目录；不接受 `/`、系统目录、账户家目录本身、已有酒馆目录、其他数据集目录或它们的祖先。初始化不得复用、清空或移动 VPS 以前酒馆的文件。

创建根目录后写入不可混淆的数据集 UUID；所有后续请求均核对 UUID、版本和真实根路径。日常 API 只能引用受验证的随机任务 ID / generation ID，不能更换根目录。目录与私有文件分别使用 0700 / 0600；程序和强制命令配置由管理员安装，不能放进上传模块中。

## 3. SSH 固定入口与受限传输

### 3.1 认证和网络

安装时设置同步专用账号密码，禁用该账号的公钥认证、sudo、终端、转发和用户 rc。管理员通过账号专属 Match/ForceCommand 绑定固定 dispatcher；脚本校验有效配置后重载 SSH。共享密码设备具有相同权限，设备 UUID 只区分任务，不是独立认证身份。入口严格解析 `SSH_ORIGINAL_COMMAND`，不将其交给 shell 执行。[OpenSSH 服务端配置](https://man.openbsd.org/sshd_config)

客户端使用固定 Host 别名、密码认证、`BatchMode no`、`StrictHostKeyChecking accept-new`、独立 `UserKnownHostsFile`、连接超时及保活。ASKPASS 从受限文件读取密码，SSH/rsync 的参数和环境中仅传文件路径。首次自动记录身份，身份改变拒绝连接，不要求手工登记公钥。[OpenSSH 客户端配置](https://man.openbsd.org/ssh_config.5)

地址解析后必须匹配首次登记的 Tailscale 节点地址；不能只因字符串为 `100.*` 就判为可信。支持登记 Tailscale IPv4、IPv6 或 MagicDNS 名称，实际连接地址仍须符合登记策略。100.64.0.0/10 是 CGNAT 范围，不是独立的身份证明。[Tailscale 地址说明](https://tailscale.com/kb/1015/100.x-addresses)

VPS 防火墙和 tailnet grants/ACL 只允许选定设备到专用 SSH 端口。现有 tailnet 可能仍是默认全互通，不能把“安装了 Tailscale”当作已经限制访问。[Tailscale 访问控制](https://tailscale.com/kb/1018/acls)

### 3.2 两种、且只有两种允许的远程命令

| 入口收到的固定命令 | 行为 |
| --- | --- |
| `tavernsyn-control-v1 <设备UUID>` | 运行固定 Python 控制程序，stdin/stdout 传输有长度上限的逐行 JSON |
| `tavernsyn-rsync-v1 <设备UUID> --server --daemon .` | 运行固定 `/usr/bin/rsync`，强制使用服务端生成的配置；传输期间持有共享传输锁 |

其他命令全部拒绝。SSH 远程 shell 仍会处理命令字符串，因此只发送上述固定文本；地址、任务 ID、清单等放在受校验的参数结构或 stdin JSON 内。Node 调用本机程序时用参数数组和 `shell:false`，不接受 UI 的任意程序路径/参数。自定义运行时路径是安装级配置，必须校验真实可执行文件，不是每个任务的输入。

控制消息建议限定为 `hello`、`beginPush`、`beginPull`、`status`、`commitPush`、`finishPull`、`abort`、`heartbeat`。应校验协议版本、数据集 UUID、设备 ID、任务 ID、预期 generation、manifest 摘要、请求体大小和枚举值。使用持久控制连接持锁；不能用“发出一条 SSH 命令创建锁目录后即退出”替代完整生命周期。

### 3.3 模块而非任意文件系统路径

`beginPush` 生成 `upload-<job-id>` 模块，其 `path` 只能是当前 `incoming/<job-id>/payload`，`read only = no`、`write only = yes`；`beginPull` 生成 `download-<job-id>` 模块，其根固定为选中的 `generations/<id>/payload`，`read only = yes`。控制文件、清单、锁和其他 generation 不在模块根内。`list = no` 仅减少枚举，不替代身份认证。

模块使用 `use chroot = no`（低权限进程不能假定有 chroot 权限）、`munge symlinks = yes`，并拒绝 links、copy-links、copy-dirlinks、keep-dirlinks、hard-links、devices、specials、inplace、append、append-verify、remove-source-files、backup/backup-dir、chmod/chown、owner/group/perms 及相关映射等不需要的能力。下载模块还拒绝所有删除选项，不能把 read-only 简化理解为任意源端修改命令都安全。最终选项名单要以实际安装版本的接受/拒绝测试固定下来；不能原样复制最新手册的新选项到较旧发行版。服务端 `refuse options`、模块只读属性和路径限制由官方提供。[rsyncd.conf 官方说明](https://download.samba.org/pub/rsync/rsyncd.conf.5)

V1 不让前端指定 `--rsync-path`；该参数可经远程 shell 执行命令，不能当作安全的普通路径字段。

**不采用自写 rsync `--server` 参数解析器。** 官方 `rrsync` 是合理备选，但会拒绝 `--protect-args/-s`，且仅限制单个根目录，不能直接表达“上传 staging、发布树只读、独立控制事务”。V1 选择受限模块可减少自制安全解析逻辑。不能同时推荐 forced `rrsync` 和 `-s` 并声称它们兼容。[rrsync 官方限制](https://download.samba.org/pub/rsync/rrsync.1)

## 4. rsync 参数基线

下列是待实现的参数规格，不是已经可运行的安装命令。上传/下载目标只能由 Helper 生成；必须显式带 `--rsh`，仅设置 `RSYNC_RSH` 环境变量不能启用 daemon-over-SSH。省略 `--rsh` 的 `host::module` 会尝试直接连接 daemon，安装器和测试必须阻止这种退化。

```text
rsync -rt --omit-dir-times --no-whole-file
  --delete-delay --partial-dir=.tavernsyn-partial
  --fsync --info=progress2,stats2 --stats --itemize-changes
  --outbuf=L --timeout=120 --modify-window=0
  --rsh=<Helper生成的固定ssh调用>
  -- <源目录/> <固定模块或本机暂存目录/>
```

| 选择 | 用途与边界 |
| --- | --- |
| `-rt` 而不是 `-a` | 递归复制普通文件并保留时间；不跨平台保存 owner、group、设备节点、Unix 权限或符号链接。不能误写成 `-rlt`，其中 `l` 会启用符号链接 |
| `--no-whole-file` | 保留块级差异算法；有修改的聊天文件不默认整文件重传 |
| `--delete-delay` | 删除只作用于独立 stage；失败不会删除当前已发布镜像或正在使用的用户目录 |
| 相对 `--partial-dir` | 断线数据留在私有 stage 中用于安全重试；其保留名不允许出现在业务载荷中，发布前清理 |
| `--fsync` | 接收端完成写入后刷盘；最终指针和目录的刷盘仍由控制程序负责 |
| `--modify-window=0` | 按整数秒进行快速比较；不为 FAT 默认放宽时间窗口，不将此判断当内容完整性证明 |
| 无全树 `-c` | 避免 rsync 在 manifest 扫描之外再次完整读盘；内容以 SHA-256 清单验证 |
| 无 `--inplace`、`--append*` | 不直接改变已存在内容；也不假设聊天文件只能尾部追加 |
| 默认无 `--delay-updates` | 已有独立 stage 和 generation 发布，避免额外内存/空间；该选项本身也不是整个目录的原子事务 |
| 无 `--ignore-errors`、`--trust-sender` | 不放松删除和接收文件列表的保护 |

以上具体语义以 [rsync 官方选项手册](https://download.samba.org/pub/rsync/rsync.1) 为依据。文件数量和百分比来自当前 rsync 阶段；扫描完成前不显示虚构的确定总进度。

默认不压缩，先保证较低的手机 CPU 和实现复杂度。当前官方手册明确指出 `--skip-compress` 暂时没有按文件生效的压缩方式，不能依靠它宣称媒体不会被重复压缩。需要优化时再按 manifest 分离文本/已压缩资源列表：文本批次协商低等级压缩，媒体批次不压缩，全树删除对账只执行一次；必须额外验证过滤和删除不会互相误删。[压缩选项与限制](https://download.samba.org/pub/rsync/rsync.1)

## 5. 清单、快速比较陷阱与实际传输指标

源端必须先得到停机后独立且不再变化的快照。manifest 包含协议版本、数据集/快照 ID、ST 版本、插件清单版本、规范化相对路径、类型、文件字节数、SHA-256、mtime（仅作辅助）以及总文件数/字节数；不包含文件内容或密钥值。对清单本身使用固定序列化规则计算摘要，完成标记绑定这个摘要。

严格默认每个源快照和接收 stage 各流式读取一次全部载荷；没有配置数据库，也不把整个文件读入内存。接收端除摘要外还要核对**实际路径集合与清单完全相同**：缺文件、额外文件、空文件夹策略错误、非法类型都应报错。未知 JSON 资源不强行解析，但 settings、插件清单等已知结构要验证；业务格式检查不等于自动修复聊天内容。

rsync 的默认快速判断可能漏掉“大小相同、修改时间处于同一秒、内容改变”的文件。源 manifest 与基准 manifest 的摘要差异会找出这些条目；对 rsync 可能跳过的条目生成 NUL 分隔的受控 `--files-from` 列表，再使用 `--from0 --ignore-times` 做定向补传。只补传这部分，不再次对整树开启 `--ignore-times`，也不把定向列表用于全树删除。完成补传后再校验整个接收 stage。剩余任何不一致均失败，不发布、不应用。[rsync 快速检查与 checksum 的区别](https://download.samba.org/pub/rsync/rsync.1)

同理，`rsync exit 0` 只满足“传输进程成功退出”条件；完成标记必须在清单、范围、完整性、空间和任务所有权都通过以后才生成。24（源文件消失）也不能当作本项目的成功状态，源快照本来就应静止。

UI 区分三组数字：

- **处理文件大小**：已重建/扫描文件的逻辑大小，不是网络流量。
- **Literal data**：未命中基准块的原始数据量，不代表压缩后的传输量。
- **rsync 协议发送/接收字节**：`Total bytes sent/received`，作为“传输量”的主要指标；多次传输须汇总，失败重试也单列累计。

SSH/Tailscale 的加密、包头、保活、重传和中继开销不包含在上述 rsync 数字中。界面应标注“rsync 协议字节，不含 SSH/Tailscale 开销”，不能称为网卡实际线速字节。预览 dry-run 不传内容，不能提供可靠的实际传输字节预测。[rsync 统计字段](https://download.samba.org/pub/rsync/rsync.1)

## 6. 排他锁、固定版本和发布事务

### 6.1 简化为串行任务，但锁必须覆盖子传输

远端控制会话从 `begin` 到完成一直持有 `operation.lock` 独占锁，第二个同步请求立即返回忙。读写控制通过 Python `fcntl.flock` 实现，不能仅依赖状态 JSON 中的 `busy=true`。[Python flock](https://docs.python.org/3/library/fcntl.html#fcntl.flock)

每个按需 rsync 包装进程持有 `transfer.lock` 共享锁直到它的 rsync 子进程完全退出。包装进程核对 active 任务、允许阶段、配置摘要和控制进程身份（VPS boot ID、PID 与 `/proc` starttime；不能只检查 PID 是否存在）。请求异常断开后，旧传输可能仍存活；新控制会话在改 active 配置、重用 stage、发布或清理之前，必须取得 transfer 独占锁。取不到就报告旧传输尚未结束，不按超时直接强杀。

提交时先将阶段设为 `FINALIZING`，新传输在取得共享锁后读取到该阶段就拒绝；控制程序随后等待共享锁全部释放并取得独占锁。这样不能在“刚判断 rsync 已结束”后又接入一个写 stage 的传输。

全局锁加 transfer 锁也保护读取：拉取开始时，在持锁状态下读取 current、核对 COMPLETE，再把模块绑定到该 generation 的真实固定目录；整个下载不再经过 `current`。即使控制连接丢失，仍在工作的读取进程持有 transfer 锁；后续任务和 GC 不能删除它正在读取的版本。V1 为此接受一台设备的大下载暂时阻塞另一台设备推送。

### 6.2 推送事务

1. `beginPush(expectedCurrentId, manifestDigest)` 检查数据集、基准版本、非空载荷、允许范围、空间与排他锁，产生不可预测的任务 ID。
2. 在 incoming 建立独立副本；已有有效镜像用 `cp --reflink=auto --recursive --preserve=timestamps --no-dereference` 复制后作为增量基准，不支持 COW 时自动普通复制。复制前源树已验证没有特殊文件/符号链接，复制后仍由严格清单校验兜底。[GNU cp 的 COW 与 fallback](https://www.gnu.org/s/coreutils/manual/html_node/cp-invocation.html)
3. 上传到唯一可写模块，完成必要的同 size/mtime 补传。
4. 进入 FINALIZING，关闭新传输，取得 transfer 独占锁；清理保留的 partial 目录，然后验证路径集合与全部文件摘要。
5. 写 COMPLETE、清单、事务 journal 并刷盘；将该 incoming generation 移入 `generations/<id>`，刷盘目录。移入与指针位于同文件系统。
6. 记录旧 current 为 previous；先写临时 current JSON，刷盘后 `os.replace` 替换 current，再刷盘父目录。成功响应包含 generation ID 和清单摘要。[Python 原子替换](https://docs.python.org/3/library/os.html#os.replace)、[fsync](https://docs.python.org/3.13/library/os.html#os.fsync)
7. 只在指针提交后清理无用 generation；保留当前、一个前任和任何尚被传输锁保护的内容。

`os.replace` 的原子性不等于整个文件系统在断电时自动持久化；清单、数据、COMPLETE、journal 和指针都要检查刷盘结果。底层硬件谎报刷盘或故障不在软件绝对保证范围内。COW 副本也不是异盘备份，共享底层数据块可能同时受存储损坏影响。

**默认不使用硬链接 / `--link-dest`。** 即使禁止 `--inplace`，后续 chmod/chown/utime 等元数据修改仍可能影响共享 inode 的旧镜像。硬链接只能作为未来经过不可变性验证的优化；不能在硬链接 stage 上先递归 chmod 再声称旧镜像不变。

### 6.3 恢复与幂等

| 中断位置 | 恢复规则 |
| --- | --- |
| 传输/校验过程中 | current 原样保留；stage 不能被拉取；不完整文件不应用 |
| generation 已移入但 current 未替换 | 新 generation 是未发布孤儿；旧 current 仍有效，按 journal 清理或继续完成 |
| current 已替换但响应丢失 | 客户端查询提交 ID 与清单摘要；匹配就确认已经发布，不能盲目重推 |
| 锁持有进程死亡但 rsync 仍在 | 等待 transfer 锁；禁止立刻清理/重用目录 |
| 完成标记/manifest/current 不一致 | 拒绝拉取；在持锁状态按 journal/previous 验证恢复，不能默认选择时间最新的目录 |

允许显式 resume 旧 job，但必须先确认无旧 transfer，且任务 ID、源快照摘要、数据集、基准 generation 全部相符；否则新建 job。只保留一次必要恢复能力，不建立复杂历史仓库。

## 7. Windows 与 Termux 适配限制

Windows 推荐固定一套 **MSYS2 的 rsync、OpenSSH、cygpath**；Node 继续使用原生 Windows。不要混用 Cygwin 路径、Git Bash 的 ssh、系统 OpenSSH 和 WSL 文件命名空间。用所选运行时的 cygpath 显式转换安装路径、暂存目录、密钥和 known_hosts 路径；构造 `--rsh` 时使用 rsync 自己支持的引号规则，参数不是 shell 字符串。中文、空格、引号和盘符必须在安装自测中覆盖。[MSYS2 路径规则](https://www.msys2.org/docs/filesystem-paths/)、[官方 rsync 包](https://packages.msys2.org/packages/rsync)

不能因为发现 `wsl.exe` 就声称 WSL 已配置，也不能假设安装 Git 已包含 rsync。本次环境调查没有发现可用 rsync；上述 Windows 链路未测试。MSYS2 对符号链接默认可能进行目标深复制，进一步说明跨设备数据不能依赖 Unix 链接语义。[MSYS2 symlinks](https://www.msys2.org/docs/symlinks/)

Termux 使用其原生包管理安装 Node、rsync、OpenSSH；当前官方 rsync 包定义存在，不能据此推断用户手机已安装。酒馆、插件、暂存区和密钥放 Termux 私有 HOME，不放 `~/storage`、`/sdcard` 或共享外置存储。[Termux rsync 包定义](https://github.com/termux/termux-packages/blob/master/packages/rsync/build.sh)、[Termux 执行环境](https://github.com/termux/termux-packages/wiki/Termux-execution-environment)

依赖检查记录实际版本和功能，并使用仍获维护、安全补丁完整的发行版包；不能只按一个裸版本号推断所有发行版是否包含补丁。协议功能以 rsync 3.2+ 为基线，正式支持版本需在第二阶段测试后固定。

## 8. 路径与跨平台文件预检

完整路径检查在源快照生成和接收应用前各执行一次，不用“字符串以根目录开头”代替真正的目录包含关系。拒绝绝对载荷路径、`..`、UNC/盘符/设备命名空间、NUL/控制字符、越界路径、符号链接、Windows junction/reparse point、特殊文件，以及同一载荷中的异常硬链接。读取时使用 lstat，禁止默默跟随链接读出同步范围外文件。

跨 Windows/Android 的默认配置按两端交集检查：Windows 保留名（含扩展名变体）、非法字符、尾部空格/点、大小写冲突、Unicode 归一化后冲突、组件长度和暂存/应用/恢复路径的总长度。遇到问题列出文件并阻止应用，不能自动重命名导致角色/聊天引用失效。[Microsoft 文件命名约束](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)

大小写折叠存在平台差异；字符串预检之外还要在受控测试目录验证目标文件系统行为。没有运行时实测，就不能承诺 `\\?\` 长路径在 Node、MSYS2、rsync、Git 和浏览器引用中全部兼容。V1 优先使用短 stage 路径并提前拒绝不兼容项。

同步不迁移 Windows ACL、Unix owner/group/可执行位、NTFS ADS 或设备身份。服务器执行依赖需要的权限由本机安装器恢复，不能通过跨平台 `-a` 盲目镜像。私钥始终在设备层；酒馆 API 密钥属于用户数据，可进入受 SSH 保护的 payload，但不能写入调试日志。

## 9. 第二阶段必须实际验证

本报告完成的是官方文档核对和协议设计，以下均未实测：MSYS2 参数/中文路径互操作、双向 rsync 块增量、daemon-over-SSH 的实际原命令形态及 refuse-options 白名单、真实 VPS 锁/断线/断电窗口、reflink fallback、Android 进程与存储行为、低空间与超长路径，以及 Tailscale 真实连通性。

先用临时目录和模拟秘密值验证：同 size/同秒 mtime 改写会被定向修复；删除只影响 stage；任意路径/链接不能越界；重试和响应丢失不错误发布；控制连接消失而传输仍在时 GC 被阻止；任何清单不匹配都保留旧 current。再接入真实 VPS 和手机。不能以 mock 协议测试替代端到端验证结论。
