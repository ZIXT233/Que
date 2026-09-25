# Qwen Code Harness 扩展示例

[English](README.md) | **简体中文**

这是独立安装的示例扩展。仓库中的副本不会被 Que 自动加载，也不需要放进 Que
本体的运行目录。

在仓库根目录执行 `mkdir -p ~/.que/extensions && cp -R examples/harness-extensions/qwen-code ~/.que/extensions/`；
Que 开发版将目标路径改为 `~/.que-dev/extensions/`。复制后启动 Que，或通过
`POST /api/extensions/harnesses` 重新加载。目标机器需要 Node.js，运行 Qwen Code 会话
还需要安装 `qwen` CLI。
`qwen-color.svg` 是扩展自己提供的图标，随扩展复制，不放入 Que 本体目录。

启用 Que 的“外部会话”通知后，扩展在 `~/.qwen/settings.json` 中加入自己命名的
命令式 hook，捕获 Que 外启动的 Qwen Code 会话。关闭通知或移除扩展时，只删除
这些 hook，保留用户的其他设置。hook 覆盖会话开始、提交提示词、工具使用、
权限请求、回合结束、失败和会话退出。Que 启动的卡片不会使用这组全局 hook。
插件会读取 Qwen hook 提供的 `transcript_path`，把会话标题和最近的用户、助手消息
送进 Que 的外部卡片；提交事件只把 `submitted_prompt` 当作新的用户消息，避免把
工具结果续跑误显示成用户提问。无法读取会话记录时，退回 hook 能提供的当前信息。

Qwen Code 在启动会话时加载 hook。若会话已经打开，可在其中打开 `/hooks`
菜单重新加载；`disableAllHooks`、`--safe-mode` 和 `--bare` 会禁用 hook。

Que 卡片会通过 `launch.sh` 启动 `qwen`，在该进程的系统默认设置中加载
`card-hooks.json`；扩展通过 `installHooks` 生成每张卡片自己的命令，事件只进入
对应卡片的信号目录。恢复会话使用 `qwen --resume <session-id>`。现有的 Qwen
系统默认设置会合并保留，不修改全局系统设置文件。此启动脚本面向 macOS/Linux。

官方协议：[Qwen Code Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)。
