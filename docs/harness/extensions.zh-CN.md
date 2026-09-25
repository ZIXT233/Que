# Que Harness 扩展（API v1）

[English](extensions.md) | **简体中文**

随包提供的 [Qwen Code 扩展](../../examples/harness-extensions/qwen-code/index.mjs)是完整的 API v1 示例。本文沿着它的源码，依次讲解注册、Que 卡片和外部会话。[示例 README](../../examples/harness-extensions/qwen-code/README.zh-CN.md)说明 Qwen 专用的安装和配置。

## 扩展文件放在哪里

用户扩展放在 `~/.que/extensions/<id>/index.mjs`。开发版使用 `~/.que-dev/extensions/`；`QUE_DATA_DIR` 可以覆盖数据目录。目录名必须与注册的 `id` 相同。Que 自带的扩展作为应用资源随包发布：安装 Que 后即可使用 Qwen；与用户扩展同名时，随包版本优先，但不会删除用户副本。修改扩展文件后重启 Que。

扩展是受信任的 Node.js 代码，Que 不从网络下载。运行扩展的机器需要另行安装 Node.js 和目标 CLI（例如 `qwen`）。Que 会为每张卡片复制扩展目录内的 UTF-8 文本文件；不支持符号链接和二进制文件。入口与所需脚本应放在同一扩展目录。Que 自动生成的 `harness-plugins/` 副本与源码目录分开，不要手工修改。

## 注册 Harness

`index.mjs` 必须默认导出一个函数，并在其中恰好调用一次 `que.register(...)`。Qwen 的注册结构如下；辅助函数定义在[源码](../../examples/harness-extensions/qwen-code/index.mjs)中：

```js
export default function activate(que) {
  que.register({
    type: 'harness',
    apiVersion: 1,
    id: 'qwen-code',
    name: 'Qwen Code',
    description: 'Qwen Code CLI and external sessions',
    icon: 'qwen-color.svg',
    launch({ pluginDir, remote }) {
      return launchCommand(pluginDir, remote);
    },
    resume({ pluginDir, remote, sessionId }) {
      return launchCommand(pluginDir, remote, ['--resume', sessionId]);
    },
    installHooks: installCard,
    externalHooks: { install: installExternal, uninstall: uninstallExternal },
    onHook({ event, input, scope }, ctx) {
      // 解析 CLI 事件，然后调用 ctx.emit(signal)。
    },
  });
}
```

`type`、`apiVersion`、`id`、`name` 和 `launch` 必填；其余字段按功能选用，但填写 `externalHooks` 时必须同时提供 `install` 和 `uninstall`。`id` 须以小写字母开头，只能包含小写字母、数字和连字符，最长 64 字符，且不能与内置 Harness 重名。`icon` 指向 `index.mjs` 同目录下最大 64 KiB 的普通 SVG 文件；Que 会在选择器、卡片和外部会话设置中显示它。

宿主在发现扩展和执行各项操作时都会导入 `index.mjs` 并调用默认导出函数。不要依赖模块全局变量在不同回调之间保存状态。[宿主实现](../../src-tauri/resources/bin/extension-host.cjs)定义并校验这套 API。

## 启动与恢复 Que 卡片

`launch(ctx)` 返回 `{ command, args }`。`command` 和 `args` 中每项都必须是字符串；Que 将它们作为进程参数传入，并提供卡片的工作目录、终端和信号环境。`ctx` 含 `cwd`、`remote` 和 `pluginDir`；`pluginDir` 是目标机器上这张卡片的扩展文件副本路径。引用文件时用它，不要硬编码开发机器的路径。

Qwen 的 `launchCommand` 在 Windows 本机返回 `node <pluginDir>/launch.cjs`，在 macOS、Linux 和 SSH 主机返回 `sh <pluginDir>/launch.sh`。启动器运行 `card-settings.cjs`，将现有 Qwen 系统默认设置与卡片 hook 合并，再用 `QWEN_CODE_SYSTEM_DEFAULTS_PATH` 指向合并后的文件。这样卡片 hook 不会覆盖用户全局设置。Windows 启动器会隐藏子进程窗口。

`resume(ctx)` 还会收到 `sessionId`，同样返回 `{ command, args }`。Qwen 校验 ID 后添加 `--resume <sessionId>`。Que 传入此前由 hook 上报的 ID；目标 CLI 自行判断会话是否还存在。省略 `resume` 后，尝试恢复已记录会话会返回错误。

## 给 Que 卡片安装 hook

`installHooks(ctx)` 在每次卡片启动前于目标机器运行，也适用于 SSH 主机。此时 Que 已复制扩展文件。`ctx` 含 `home`、`remote`、`pluginDir` 和 `hookCommand(event)`。回调可异步执行；由于可能反复调用，写配置时应保留用户内容并保证幂等。

Qwen 的 `installCard` 写入 `<pluginDir>/card-hooks.json`。其 `eventHooks` 辅助函数为每个 Qwen 事件登记 `ctx.hookCommand(event)`。Que 会生成包含 Windows 引号处理在内的平台专用完整命令，扩展无需自行拼接宿主命令。随后 Qwen 启动器让 CLI 加载这份卡片专用文件。如果目标 CLI 要在自己的进程内加载扩展文件，也可以在 `installHooks` 中安装文件，并由 `launch` 使用 `pluginDir` 添加加载参数。

```js
function installCard(ctx) {
  const file = path.join(ctx.pluginDir, 'card-hooks.json');
  const hooks = eventHooks(
    event => ctx.hookCommand(event),
    event => `que-qwen-code-card-${event}`,
  );
  writeSettings(file, { hooks });
}
```

## 接收 hook 输入并上报信号

生成的 hook 命令会调用 `onHook({ event, input, scope }, ctx)`。`input` 是目标 CLI 写入 stdin 的 JSON，字段由该 CLI 定义。`scope` 为 `'card'` 或 `'external'`。`ctx` 含 `pluginDir` 和 `emit(signal)`；`ctx.emit` 会填入作为 `kind` 的 Harness ID 与作为 `at` 的时间戳，扩展至少提供 `event`。CLI 不需要 stdout 应答时无需返回；需要时返回字符串或 `{ stdout: string }`。控制台日志会转到 stderr，stdout 留给 hook 应答。

Qwen 校验事件与 scope，把 `session_id` 和 `cwd` 转成 `sessionId`、`workspaceRoot`，然后调用 `ctx.emit(signal)`。它把 Qwen 的 `SessionEnd` 转成 Que 的 `sessionEnd`。会话开始、提交提示词和回合结束时，它会尽量读取 Qwen 的 JSONL 会话记录，补充 `title`、`firstPrompt` 和最近的 `turns`；新用户消息取自 `submitted_prompt`，回复预览取自 `last_assistant_message`。`tool_name` 和 `agent_id` 分别成为 `tool`、`agentId`。读取会话记录是 [index.mjs](../../examples/harness-extensions/qwen-code/index.mjs) 中的 Qwen 专用逻辑，并非 Que 提供的 API。

Qwen 的 `onHook` 上报信号时，核心步骤如下：

```js
const signal = { event: event === 'SessionEnd' ? 'sessionEnd' : event };
if (typeof input?.session_id === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.session_id)) {
  signal.sessionId = input.session_id;
}
if (typeof input?.cwd === 'string' && input.cwd) signal.workspaceRoot = input.cwd;
if (!signal.sessionId && !signal.workspaceRoot) return;
// Qwen 还会在可用时从会话记录补充信号字段。
ctx.emit(signal);
```

| 信号事件 | 卡片效果 |
| --- | --- |
| `SessionStart` | 启动完成，等待用户 |
| `UserPromptSubmit` | 工作中 |
| `PreToolUse` / `PostToolUse` | 工作中 |
| `PermissionRequest` | 明确等待用户处理 |
| `Stop` / `StopFailure` | 本轮结束，等待用户 |
| `sessionEnd` | 按本轮结束处理 |

其他信号字段包括 `prompt`、`replyPreview`、`firstPrompt`、`title`、`turns`、`tool`、`agentId` 和 `workspaceRoot`。`turns` 是按时间顺序排列的 `{ role: 'user' | 'assistant', text: string }` 数组。外部通知需要稳定的 `sessionId` 或 `workspaceRoot`，以便 Que 识别会话。会话 ID 须以字母或数字开头，其余字符可以是字母、数字、下划线或连字符，最长 128 字符。带 `agentId` 的子 Agent 事件不会改变主卡片状态。仅在 CLI 确实需要用户操作时上报 `PermissionRequest`。参见[完整信号契约](hook-api.zh-CN.md)。

直接加载到目标 CLI 进程的扩展文件，也可从 `pluginDir` 上级目录的 `extension-host.cjs` 导入 `emit(kind, signal)`。Que 在本机设置 `QUE_HARNESS_KIND` 和 `QUE_HARNESS_SIGNAL_DIR`，在远端设置 `QUE_HARNESS_CHANNEL` 和 `QUE_HARNESS_TTY`。Qwen 则使用命令式 hook 和 `ctx.emit`。

## 捕获 Que 外启动的会话

`externalHooks` 可选，但使用时必须同时实现 `install(ctx)` 与 `uninstall(ctx)`。它负责本机 Que 外启动的会话。外部通知默认关闭，需要在 Que 的外部会话设置中同时启用通知和该 Harness。两个回调都在本机运行；`ctx` 含 `home`、`pluginDir`、`externalSignalDir` 和 `hookCommand(event)`。

Qwen 的 `installExternal` 将命令式 hook 合并到 `~/.qwen/settings.json`。hook 名称包含由 `ctx.pluginDir` 派生的稳定哈希，因此 `.que` 和 `.que-dev` 可以共存。`uninstallExternal` 只移除同一 Que 实例拥有的条目，保留其他设置和 hook。Que 在启用时安装、关闭或移除扩展时撤销。生成的外部 hook 会跳过 Que 启动的会话，所以卡片仍需自行安装 hook。Que 外的事件以 `scope: 'external'` 进入 `onHook`；是否投递外部通知仍由 Que 设置控制。

两种作用范围共用 `eventHooks` 辅助函数。`installExternal` 为每个事件提供 `ctx.hookCommand(event)` 和带实例标识的名称；`uninstallExternal` 则通过 `removeOwned(settings, ctx)` 仅移除这些条目。具体实现见 [Qwen 源码](../../examples/harness-extensions/qwen-code/index.mjs)。

外部 hook 目前只安装在本机，不捕获在 SSH 主机上由 Que 外启动的会话。若扩展文件直接加载到 CLI 进程，也可在没有卡片信号环境时调用 `emit(kind, signal, { externalSignalDir: ctx.externalSignalDir })` 投递到外部通知目录。

## SSH 与诊断

SSH 卡片启动前，Que 上传 UTF-8 扩展文件并在远端运行 `installHooks`。信号通过 `QUE_HARNESS_TTY` 上的 OSC 通道送回；若 hook 无法写入该 TTY，当前接口无法保证送达。开发远端适配时需检查真实会话。

诊断时可在 Que 设置中开启“详细调试日志”并查看 `~/.que/logs`，或点击卡片的“日志”保存并打开报告。确认 hook 事件已经到达、`sessionId` 已绑定、卡片状态已变化。仅有文件安装成功不足以证明 hook 已工作。
