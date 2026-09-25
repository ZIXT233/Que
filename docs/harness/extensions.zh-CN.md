# Que Harness 扩展（API v1）

[English](extensions.md) | **简体中文**

将一个目录放在 `~/.que/extensions/<id>/`，入口为 `index.mjs`。开发版使用
`~/.que-dev/extensions/`；`QUE_DATA_DIR` 可覆盖根目录。目录名必须与注册的 `id`
相同。扩展是用户信任的 Node.js 代码，Que 不从网络自动安装。目标机器需要 Node.js。
可参考[Qwen Code 扩展示例](../../examples/harness-extensions/qwen-code/README.zh-CN.md)，其中包含图标、卡片 hook 和外部会话 hook。
当前上传器复制扩展目录中的 UTF-8 文本文件；请将入口和所需脚本放在该目录内，
不要依赖符号链接或二进制附件。远端所需的其他依赖由扩展自行安装或预先配置。

Que 启动时加载扩展；运行中可调用 `POST /api/extensions/harnesses` 重新加载。
`GET /api/extensions/harnesses` 返回已注册扩展及加载错误，并刷新目录。
注册成功的 harness 会出现在新会话选择器中。扩展目录与 Que 自动生成的
`harness-plugins/` 分开，后者不要手工编辑。
可选 `icon` 指向 `index.mjs` 同目录下最大 64 KiB 的普通 `.svg` 文件；
Que 随扩展复制它，并在选择器、卡片和外部会话设置中显示。省略时使用默认图标。

扩展也可以通过 `externalHooks` 接入本机 Que 外启动的会话。外部通知默认关闭；
注册扩展后，需要在 Que 现有的“外部会话”设置中启用。

```js
// ~/.que/extensions/example/index.mjs
import fs from 'node:fs';
import path from 'node:path';

export default function activate(que) {
  que.register({
    type: 'harness',
    apiVersion: 1,
    id: 'example',
    name: 'Example Agent',
    description: 'Example Agent CLI',
    // icon: 'icon.svg', // 可选；与 index.mjs 同目录，最大 64 KiB。

    launch({ pluginDir }) {
      return { command: 'example-agent', args: [] };
    },

    async installHooks(ctx) {
      // 可反复执行；保留用户配置中不属于此扩展的条目。
      const stopCommand = ctx.hookCommand('Stop');
      const config = path.join(ctx.home, '.example-agent', 'config.json');
      const current = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
      current.hooks ??= {};
      current.hooks.Stop = [
        ...(current.hooks.Stop || []).filter(item => item.queOwner !== 'example'),
        { queOwner: 'example', command: stopCommand },
      ];
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, JSON.stringify(current, null, 2));
    },

    onHook({ event, input }, ctx) {
      ctx.emit({ event, sessionId: input.session_id });
      // 需要 stdout 应答的 agent 可以返回字符串或 { stdout: string }。
    },

    resume({ sessionId }) {
      return { command: 'example-agent', args: ['--resume', sessionId] };
    },
  });
}
```

## 回调

- `launch(ctx)` 返回 `{ command, args }`；Que 设置工作目录、终端与信号环境变量。
  `ctx` 有 `cwd`、`remote`、`pluginDir`。使用 `pluginDir` 引用扩展附件，避免硬编码本机路径。
- `installHooks(ctx)` 在目标机器上、终端启动前运行。`ctx` 有 `home`、`remote`、
  `pluginDir`、`hookCommand(event)`。它可编辑目标 agent 配置或安装 Pi 式扩展。
  同一机器的每次启动都可能再次调用，所以必须幂等，不覆盖用户自己的 hook。
- 命令式 hook 使用 `ctx.hookCommand(event)` 得到完整命令。agent 调用后，Que 将其
  stdin JSON 传给 `onHook({event,input},ctx)`；`ctx.emit(signal)` 上报信号。
  不需要 stdout 应答时返回 `undefined`。只有目标 agent 明确要求时才返回应答；
  Que 只观察，不替用户做授权决定。
- Pi 一类进程内扩展可在 `installHooks` 中安装附件，并在 `launch` 中用
  `pluginDir` 增加加载参数。附件若需自行发信，可通过其上级目录中的
  `extension-host.cjs` 导出函数 `emit(kind, signal)`。Que 为会话设置
  `QUE_HARNESS_KIND`、`QUE_HARNESS_SIGNAL_DIR`（本机）、`QUE_HARNESS_CHANNEL` 和
  `QUE_HARNESS_TTY`（远程）。
- `resume({sessionId,cwd,remote,pluginDir})` 返回恢复命令。Que 保存 hook 报告的
  `sessionId`，恢复时原样传入；由目标 CLI 判定会话是否还存在。需要更复杂的恢复
  可从 `resume` 返回 `node` 和扩展目录内的通用脚本路径。若目标 CLI 没有恢复能力，
  可省略此回调，但已记录会话的恢复操作会明确报错。

## 外部会话 Hook

目标 agent 支持用户级 hook 时，在同一个 `type: 'harness'` 注册中加入
`externalHooks`，并同时提供安装和撤销回调：

```js
externalHooks: {
  install(ctx) {
    const command = ctx.hookCommand('Stop');
    // 在 agent 的用户级配置中加入由此扩展拥有的 hook。
    // 保留用户原有条目，重复安装也不应产生重复项。
  },
  uninstall(ctx) {
    // 只移除此扩展写入的用户级 hook 条目。
  },
},
onHook({ event, input, scope }, ctx) {
  ctx.emit({ event, sessionId: input.session_id, workspaceRoot: input.cwd });
},
```

`install(ctx)` 和 `uninstall(ctx)` 在本机运行；`ctx` 提供 `home`、`pluginDir`、
`externalSignalDir`、`hookCommand(event)`。Que 将扩展复制到
`harness-plugins/<id>/global/`。启用外部通知和该 Harness 时执行安装，关闭任一开关
或移除扩展时执行撤销。`POST /api/extensions/harnesses` 会重新加载扩展并同步外部
hook；安装错误在其 `errors` 中返回，设置更新则返回 `extensionErrors`。

同一台机器可能同时运行多个 Que 数据目录，例如 `.que` 和 `.que-dev`。扩展在用户级
配置中注册 hook 时，应以 `ctx.pluginDir` 区分实例；`install` 只替换当前实例的条目，
`uninstall` 也只移除当前实例的条目。目标 agent 以名称或文件名作为唯一键时，名称或
文件名也要包含从 `ctx.pluginDir` 派生的稳定实例标识，避免两个实例互相覆盖。

全局 `hookCommand` 在没有 Que 卡片信号环境时向外部通知目录投递。生成的全局 hook
会跳过 Que 启动的会话；这类卡片仍须通过 `installHooks` 或 `launch` 注册自己的 hook。
`onHook` 会收到 `scope: 'card' | 'external'`。外部信号应提供稳定的 `sessionId` 或
`workspaceRoot`，供 Que 识别会话；外部通知设置仍控制信号是否生效。进程内适配器
可在没有卡片环境时显式调用导出的
`emit(kind, signal, { externalSignalDir: ctx.externalSignalDir })`。

`command` 和 `args` 必须是字符串，不经过用户 shell 拼接。`id` 只能含小写字母、
数字和连字符并以字母开头，最长 64 字符，不得与内置 harness 冲突。

## 信号

`ctx.emit` 接收现有 `HookSignal` 字段。Que 填写 `kind` 和时间；插件至少填写
`event`，并应尽早提供 `sessionId`。会话 ID 须以字母或数字开头，其余字符只接受
字母、数字、下划线、连字符，最长 128 字符。常用事件：

| 事件 | 卡片效果 |
| --- | --- |
| `SessionStart` | 启动完成，等待用户 |
| `UserPromptSubmit` | 开始工作 |
| `PreToolUse` / `PostToolUse` | 工作中 |
| `PermissionRequest` | 目标 agent 明确在等用户处理 |
| `Stop` | 本轮结束，等待用户 |

还可传 `prompt`、`replyPreview`、`title`、`turns`、`tool`、`agentId`。
`turns` 是按时间顺序排列的 `{ role: "user" | "assistant", text: string }[]`，
供外部会话通知显示双方对话；插件可从目标 harness 的会话记录读取。
带 `agentId` 的子 agent
事件不会改变主卡片状态。不要把普通工具启动当作 `PermissionRequest`。
参见 [完整信号契约](hook-api.zh-CN.md)。

## 远程与诊断

SSH 会话启动前，Que 上传扩展文件，在远端执行 `installHooks`。远端通过
`QUE_HARNESS_TTY` 的 OSC 通道发回信号；若目标 agent 的 hook 无法写 TTY，
当前接口不能保证远端送达，需要在真实远端会话中检查。

启动后查看 `GET /api/harness/<terminal-id>/debug`：分别确认 hook 事件已到达、
`sessionId` 已绑定、卡片状态已变化。文件存在或安装命令成功都不是接入成功的证明。
只有注册 `externalHooks` 且启用外部通知，扩展才会捕获 Que 外启动的本机会话。
目前外部 hook 只安装在本机，不捕获 Que 外启动的 SSH 会话。
