# Qwen Code Harness 扩展示例

[English](README.md) | **简体中文**

这是 Que 随发布包提供的 Harness 扩展。发布包把此目录作为应用资源打包，启动时
自动加载；开发版直接读取这里的源码。无需复制到 `~/.que/extensions/`。
该目录仍保留给用户扩展；已有的同名 Qwen 副本不会被删除，但随包版本优先。
运行中可通过 `POST /api/extensions/harnesses` 重新加载。目标机器需要 Node.js，
运行 Qwen Code 会话还需要安装 `qwen` CLI。`qwen-color.svg` 随扩展一起打包。

启用 Que 的“外部会话”通知后，扩展在 `~/.qwen/settings.json` 中加入自己命名的
命令式 hook，捕获 Que 外启动的 Qwen Code 会话。关闭通知或移除扩展时，只删除
这些 hook，保留用户的其他设置。hook 覆盖会话开始、提交提示词、工具使用、
权限请求、回合结束、失败和会话退出。Que 启动的卡片不会使用这组全局 hook。
插件会读取 Qwen hook 提供的 `transcript_path`，把会话标题和最近的用户、助手消息
送进 Que 的外部卡片；提交事件只把 `submitted_prompt` 当作新的用户消息，避免把
工具结果续跑误显示成用户提问。无法读取会话记录时，退回 hook 能提供的当前信息。

Qwen Code 在启动会话时加载 hook。若会话已经打开，可在其中打开 `/hooks`
菜单重新加载；`disableAllHooks`、`--safe-mode` 和 `--bare` 会禁用 hook。

Que 卡片在 macOS/Linux 和 SSH 远端通过 `launch.sh` 启动 `qwen`；Windows 本机通过
`launch.cjs` 启动。启动器会在该进程的系统默认设置中加载
`card-hooks.json`；扩展通过 `installHooks` 生成每张卡片自己的命令，事件只进入
对应卡片的信号目录。恢复会话使用 `qwen --resume <session-id>`。现有的 Qwen
系统默认设置会合并保留，不修改全局系统设置文件。

官方协议：[Qwen Code Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)。
