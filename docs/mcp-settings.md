# 通过 QueACP MCP 配置 QueACP

你在卡片上打开了“修改设置”的运行中 Agent，可以读取和修改下列设置。复用设置界面的服务、校验和存储；不会另起一套设置界面。只有用户要求的字段才应修改，有这个权限不代表可以自行调整用户偏好。

先调用 `list_settings` 获取字段、合法值和生效时机，再用 `read_settings` 读取当前值，最后用 `update_settings` 提交 `patch`。省略的字段保持不变。UI 设置可以传入 `expected`，旧值已经变化时拒绝整次修改。

| scope | 可配置内容 | 生效时机 |
| --- | --- | --- |
| ui | 主题、语言、专注模式、发送后收起行为、声音、完成通知、聊天字号、终端背景/配色/字体 | 界面通常在 1.5 秒内同步 |
| app | 调试日志、PowerShell 开关 | 按现有服务生效；PowerShell 影响后续启动 |
| speech | 听写语言、MiMo API Key | 后续听写请求 |
| queue | 排序、插入位置、回合标签开关和定义 | 现有队列同步 |
| workspace | 名称、默认会话权重；target 为 workspaceId | 工作区元数据更新 |
| machine | terminalRc、sessionEnv；target 为 local 或 ssh:主机 | 新会话／新终端 |

`terminalAppearance` 和 `sessionEnv` 是完整对象替换，不是对象内部字段合并。排序模式变更沿用界面行为，插入位置会回到底部；需要其他位置时在同一 patch 指定。读取机器设置只返回是否配置 RC 和环境变量名称，不返回脚本或变量值。听写密钥只写入，读取只显示是否配置；省略密钥保留现值，空字符串清除。

示例：

```json
{"scope":"ui","patch":{"theme":"dark","fontSize":16,"soundEnabled":false}}
```

## 工作区与远程主机

- `create_workspace({name, kind, cwd, sshHost?})`：将本机或 SSH 上的已有目录加入工作区。相同位置返回已有工作区，不改名、不重置权重、不自动建卡片。需要卡片时继续调用既有 `create_card`。
- `list_remote_hosts()`：列出 QueACP 已保存和 SSH config 中的主机。
- `configure_remote_host({operation:"save", host:{name,hostname,user?,port?,id?}})`：新增或修改保存的主机；修改时传 id。新增时若主机、用户名和端口已存在则返回已有项。
- `configure_remote_host({operation:"set-visibility",hostId,visible})`：调整 SSH config 主机在界面中的可见性。保存的主机不使用此开关。

这些工具不授予 macOS 麦克风／通知权限，不接受 SSH 主机信任提示，也不替用户批准 MCP 权限。会话模型和权限模式继续使用会话控制，不混入全局设置。

## 验证范围

`tests/acp/settings-service.test.mjs` 通过隔离 headless 服务和 fixture Agent 检查权限边界、设置读写、凭据隐藏、工作区去重、主机配置和错误时不部分提交。运行时设置 `QUEACP_SETTINGS_TEST_BINARY` 指向 headless 可执行文件；未设置时跳过。

`tests/acp/settings-sync.test.mjs` 检查界面双向同步、旧响应隔离、后端重启后的初始化重试及无效本地值处理。远程 SSH 实机和原生 WebView 视觉验收尚未覆盖。
