# 0.2.0 敏感信息扫描

日期：2026-10-24。

使用 Gitleaks 8.30.1 默认规则扫描本次发布文件及完整 Git 提交历史；扫描前已补全浅克隆历史。工具取自官方 GitHub Release，并核对官方 SHA-256 清单。扫描没有配置凭据忽略名单，报告中的匹配值全部脱敏，原始报告留在不发布的 `.local/security/`。

## 结果

- 未匹配到真实账号密码、API 密钥、访问令牌或私钥内容。
- 检查待发布文件清单，未包含设备配置、密码文件、私钥、运行日志、同步载荷、`.local/`、`.tmp/` 或 `node_modules/`。
- 已将当前界面和测试中的实际 VPS 地址改成示例地址；公开测试报告的本机路径、任务编号及载荷摘要已脱敏。历史测试的版本、日期和断言保留。
- 测试中的合成密码和拒绝带密码 URL 的测试值均为模拟输入。
- `.gitignore` 增加设备状态、密码目录、主机记录、证书容器和桌面快捷方式的排除规则。

## 历史清理

2026-10-24 将仓库历史重建为单独的 0.2.0 提交，保留当前已脱敏的代码和测试记录，移除引用旧地址、本机目录及私人作者邮箱的历史。新提交使用 GitHub 的 `noreply` 地址，本仓库后续提交也使用该地址。

已有旧克隆应重新克隆再更新，不要把旧分支合并或重新推送到仓库。重新运行设备安装器仍按原安装文档保留本机状态。

GitHub 可能继续缓存旧 SHA 页面，其他人已克隆的副本也不会随强制推送消失。服务端缓存需要 GitHub 后台清理，见[GitHub 历史清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository#fully-removing-the-data-from-github)。

## 复查方式与范围

可在完整克隆后使用同版本工具复查历史：

```sh
gitleaks git --log-opts="--all --full-history" --redact=100 --ignore-gitleaks-allow
```

发布前检查本次文件，推送后再按远端提交复查。结果表示所用规则及人工复核未发现真实凭据，未涵盖 GitHub 的私有设置、Actions secrets、其他仓库或规则无法识别的密钥格式；它不代替程序安全审计。
