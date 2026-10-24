# 同步范围与设备差异

## 默认包含

完整绑定用户目录的持久文件：聊天/群聊与元数据、角色 PNG 和资源、世界书、预设、正则、Quick Replies、人格、头像、图片、附件、主题、自定义 CSS、模板、连接配置、`settings.json`、`secrets.json`，以及 `vertex-paygo` 等未知插件持久化子目录。CDN 脚本的 URL、启用状态和参数只要已保存在这些文件中，也随之同步。

另外包含全局前端第三方扩展、服务端插件的工作文件、全局 `_css` 与 `_errors`。自己的 `tavernsyn` 扩展/后端入口、`plugins/package.json` 加载格式不取自远端。

## 默认排除

- 账户数据库、Cookie/CSRF/登录身份、其他用户目录。
- `thumbnails`、用户聊天备份、已知缓存/临时上传和 `node_modules`。
- SSH/Tailscale 身份目录、标准 SSH 私钥文件名、`tailscaled.state`。
- 同步程序、设备配置、任务锁/日志、下载暂存与恢复目录。
- 酒馆核心程序和根 `node_modules`。本机 `config.yaml` 只共享明确白名单中的备份数量/聊天备份与完整性配置。

镜像含酒馆 API 密钥。基础设施私钥必须放在控制目录或其他排除范围；配置的 SSH key 不得位于任何镜像根。插件若将非标准名称的基础设施密钥写入用户目录，应先迁出，不能只依赖文件名猜测。

## 精确保留本机字段

默认 JSON Pointer：

```text
/extension_settings/tavernsyn
/power_user/movingUI
/power_user/movingUIState
/power_user/movingUIPreset
/power_user/chat_width
/power_user/font_scale
```

其余未知设置仍共享，不整块排除 `settings.json` 或 `accountStorage`。编辑控制目录的 `device.json` 可以增加精确路径和额外数据目录，保留其他原有配置字段：

```json
{
  "preserveSettings": ["/extension_settings/某插件/localPath"],
  "preserveJson": [
    { "path": "server-plugins/某插件/config.json", "pointers": ["/port", "/localPath"] }
  ],
  "extraRoots": [{ "id": "shared-assets", "path": "D:/TavernAssets" }]
}
```

两端额外根 `id` 相同，路径分别设置；缺少目标映射会拒绝应用。根必须独立、同卷，不得是系统/个人根、SSH目录、链接、控制区或相互重叠目录。保留字段若本机没有值，则删除远端该字段，让插件使用本机默认值。

发现 settings 中常见绝对路径会要求核对，不做文本替换。其他任意插件文件中的路径无法全面判断，需明确配置。根目录 Vertex bridge 端口文件不在默认镜像内，留本机生成。

## 插件恢复

Git 插件生成固定 commit 的浅对象副本，独立同步工作文件，保留修改和未跟踪资源。目标重建 `.git`、本机文件模式/大小写选项、原分支及 index；不 checkout 覆盖工作修改，不联网猜测最新版本。

发现运行依赖时在候选目录执行本机 npm `ci --omit=dev`（无 lockfile 时用 `install`）。npm 安装脚本属于可信插件代码，会在设备执行；只允许可信设备写入数据集。不跨平台复制 `node_modules`。安装失败不替换 live 数据；离线时需已有包缓存。

工作树内独立 `.exe/.dll/.node/.so/.dylib` 若平台或架构不同，会阻止应用，需先处理对应平台资源。WebAssembly 和普通资源正常同步。

启动健康检查包括本机实例身份及原生插件加载器错误。可在设备配置增加固定本机服务检查，例如：

```json
{ "healthChecks": [{ "port": 18443, "path": "/health", "status": 200 }] }
```

应先确认插件确实提供该地址。默认检查不能替每个第三方插件验证所有业务功能。

## 明确边界

不复制浏览器 localStorage/IndexedDB、未发送草稿、未提交编辑或未知脚本内存。设置和当前聊天有落盘回执；其他内容以已保存文件为准。同步前先保存并退出世界书/角色/脚本编辑器，关闭其他客户端。后台独立写入进程、非标准外部程序和不遵守退出保存合同的插件需额外适配，不能把强制结束当作已保存。
