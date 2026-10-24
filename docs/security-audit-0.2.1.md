# 0.2.1 发布检查

日期：2026-10-24。

使用已有的 Gitleaks 8.30.1 默认规则扫描发布候选文件和本地完整 Git 提交历史；报告中的匹配值全部脱敏，原始扫描产物留在忽略的 `.local/security/`。扫描未发现真实凭据。

待发布文件包含代码、文档及脱敏测试报告，不包含设备配置、账号密码、SSH 身份、运行日志、同步载荷、附件、`.local/`、`.tmp/` 或依赖目录。真机任务编号已脱敏；测试使用的合成密码和示例地址保留以便复现。

前端 manifest、Node 包及锁文件、VPS dispatcher 与更新器的版本标识均为 `0.2.1`，SSH 协议版本保持为 1。Windows 57 项测试全部通过，另有 8 项真实 rsync 检查及 22 项真实酒馆隔离集成检查。VPS Python 测试在 Windows 通过 17 项、跳过 5 项需要 Linux 的锁与文件描述符检查。[发布验证汇总](test-results/release-0.2.1-windows.json)保留这些边界。

此前已在 Android 真机验证完整快照应用、健康重启、浏览器交接与 Termux Exit；详见[真机报告](test-results/termux-sync-session-android.json)。本次发布更新 GitHub 源代码及版本标识；运行中的设备和 VPS 仍各自通过安装与更新流程部署。

本次延续现有提交历史，提交作者使用 GitHub 的 `noreply` 地址。历史清理背景及扫描局限见 [0.2.0 检查说明](security-audit-0.2.0.md)。
