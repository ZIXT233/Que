# Harness Hook API

[English](hook-api.md) | **简体中文**

Que 通过各 CLI Harness 本就提供的生命周期钩子来了解它在做什么。这里是共享契约：Harness 上报什么、上报如何抵达 Que、Que 从中推导出什么。`src-tauri/resources/bin/harness-hook.cjs` 指向的就是本文件。

实现主体是 `src-tauri/src/harness/signals.rs`；`src-tauri/protocol-ref/harness/` 有一份 TypeScript 镜像作为参考。下文描述的行为以两侧保持一致为前提。

## 1. Ingress

三种文件为所有受支持的 Harness 上报。三者都**只做观察**：绝不阻断 CLI、不篡改其输入、不写入模型可见的文本。唯一的例外是 Cursor——它要求 stdout 返回 JSON 裁决（见 §2.3）。

| 入口 | 服务对象 | 投递方式 |
| --- | --- | --- |
| `src-tauri/resources/bin/harness-hook.cjs` | `cursor`、`codex`、`antigravity`、`gemini`、`grok`、`claude`、`codebuddy`、`devin` | 命令式 hook，stdin JSON |
| `src-tauri/resources/bin/harness-opencode.mjs` | `opencode` | 插件回调 |
| `src-tauri/resources/bin/harness-pi.mjs` | `pi`、`omp` | 扩展回调 |

### 1.1 环境变量

| 变量 | 由谁设置 | 含义 |
| --- | --- | --- |
| `QUE_HARNESS_KIND` | 启动器 / ingress | Harness id。缺失时从插件路径（`…/harness-plugins/<kind>/`）推断，或从事件名推断（Cursor）。 |
| `QUE_HARNESS_CHANNEL` | 启动器 | OSC 通道的 token。仅 Que 启动的会话有。 |
| `QUE_HARNESS_SIGNAL_DIR` | 启动器 | 该卡片的文件 sink。仅 Que 启动的会话有。 |
| `QUE_HARNESS_TTY` | 启动器 | OSC 帧写入的 TTY。默认 `/dev/tty`；SSH 会话导出 `$(tty)`。 |
| `QUE_HARNESS_WATCHDOG_MS` | 启动器 | ingress 自我了结的截止时间。默认 8000；启动器注入 `(hook 超时 − 2s)`，下限 1s，这样即便 stdin 卡住也能把信号发出去，而不是死在 CLI 自己的 "hook timed out" 上。 |
| `QUE_HARNESS_SESSION_ID` | 启动器 | 正在续接的会话，供插件在首个事件之前就绑定身份。 |
| `QUE_HARNESS_DEBUG` | 启动器 | 置 `1` 时往 sink 写 `hook-trace.jsonl` 与 `last-stop-diagnostic.json`。 |
| `QUE_EXTERNAL_SIGNAL_DIR` | 用户 | 覆盖外部 sink 的位置。 |

当 `QUE_HARNESS_SIGNAL_DIR`、`QUE_HARNESS_CHANNEL`、legacy `active.json` 都不存在，且 `QUE_HARNESS_KIND` 不是已知 Harness 时，ingress 静默退出。已知 kind：`cursor`、`codex`、`antigravity`、`gemini`、`grok`、`claude`、`opencode`、`codebuddy`、`pi`、`omp`、`devin`。

### 1.2 载荷

ingress 读取所有 Harness 字段名的并集，统一输出一种结构（`HookSignal`，camelCase JSON）：

| 字段 | 说明 |
| --- | --- |
| `kind` | Harness id。 |
| `at` | Epoch 毫秒。由 ingress 写入；OSC 路径会在接收时重新打戳。 |
| `event` | Harness 自己的事件名，原样透传——见 §3。 |
| `sessionId` | 取自 `conversationId` / `conversation_id` / `session_id` / `sessionId`；需通过 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$` 校验后才会被采信。 |
| `agentId` | 子 Agent id。带此字段的信号会被状态机**丢弃**：子 Agent 不是卡片。 |
| `tool` | 取自 `toolCall.name` / `tool_name` / `toolName` / `name`。 |
| `prompt` | 仅出现在提交形态的事件上。 |
| `firstPrompt`、`title` | 会话命名线索。 |
| `turns` | 扩展可选提供的会话记录快照：按时间顺序排列的 `{ role: "user" | "assistant", text: string }[]`。外部通知用它显示双方对话。 |
| `replyPreview` | 回合结束的回复摘要。卡片保留 160 字符；外部 sink 最多 2000 字符。 |
| `notification` | 取自 `notification_type` / `notificationType` / `type`。 |
| `fullyIdle` | 仅 Antigravity：这次 `Stop` 是否真的结束了回合。契约里没有对应事件名的事实，以字段上报，而不是改写成另一个事件。 |
| `workspaceRoot` | 仅外部会话，让冷启动也能给卡片命名。 |
| `external` | 当发出信号的进程没有携带 Que 通道时，由 ingress 置位。 |

## 2. 投递

### 2.1 OSC

```
ESC ] 777 ; que ; <base64 of {"token":…,"signal":{…}}> BEL
```

写入 `QUE_HARNESS_TTY`。`src-tauri/src/harness/osc.rs` 会跨 PTY 分片重组帧、要求 token 与该终端的启动 token 匹配，并用接收时刻重写 `at`——hook 进程自己的时钟不被信任。

这条路径让卡片获得亚秒级延迟；文件 sink 则是那些 hook runner 写不了 TTY 的 Harness 的兜底。

### 2.2 文件 sink

两个 sink 都是"一事件一文件"，以 `<at>-<uuid>.json` 命名，通过 `.tmp` + rename 落盘，权限 `0600`；消费方读完即删。

| Sink | 目录 | 归属 |
| --- | --- | --- |
| 卡片 | `<data>/harness-signals/<terminal_id>/` | `paths.rs::signal_dir`，启动时预建 |
| 外部 | `<data>/external-signals/` | `paths.rs::external_signal_dir`，由 ingress 创建，并顺手清理超过 5 分钟的文件 |

`<data>` 为 `QUE_DATA_DIR` 或 `~/.que`。

外部信号来自 **Que 从未启动的会话**——Cursor 的用户级 `hooks.json` 是全局的，IDE 聊天和普通终端也会上报到这里。它们成为转瞬即逝的外部提示而非队列卡片，且每种 kind 都能在设置里单独关闭。

### 2.3 Cursor 的应答

Cursor 的 hook 会阻塞等待裁决，所以 ingress 总是应答：`beforeSubmitPrompt` 返回 `{"continue":true}`，`preToolUse` / `beforeShellExecution` / `beforeMCPExecution` 返回 `{"permission":"allow"}`，其余返回 `{}`。Que 对自己只在旁观的会话从不设闸——这正是那三个事件不能读作"用户正在被询问"的原因，见 §4.4。

## 3. 从事件到结论

同一个边界，各家 Harness 叫法不同。Harness 自己的词汇只在一个地方被读取——`signals.rs` 的共享词汇表（`default_meaning`），经注册表里各家的 `meaning` 到达——并直接变成卡片要做的事。中间**刻意不设**"规范事件"这一层词汇：那层只会产出还需要再翻译一次的名字，并且诱使人把某个事件归到它并不具备的含义之下。

状态本身只有两个。这套词汇补上的是信号路径还需要知道的其余部分：回合的起止边界，以及"CLI 自己应答的门禁"这种如实的"分不清"。

| 结论 | 事件 | 卡片 |
| --- | --- | --- |
| `SessionStart` | `SessionStart`、`sessionStart` | 仍处于 `starting` 的卡片翻为 `attention`（§4） |
| `TurnStart` | `beforeSubmitPrompt`、`UserPromptSubmit`、`BeforeAgent`、`PreInvocation` | `working` |
| `Working` | `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`BeforeTool`、`AfterTool`、`PostInvocation`、`preToolUse`、`postToolUse`、`postToolUseFailure` | `working` |
| `MaybeAttention` | Antigravity 的 `PreToolUse`；Cursor 的 `preToolUse`、`beforeShellExecution`、`beforeMCPExecution` | 先 `working`，窗口走完仍无下文则 `attention`（§4.4） |
| `Attention` | `PermissionRequest`；`Notification` 且类型为 `permission_prompt` / `ToolPermission` / `idle_prompt`；询问形态工具的工具启动事件 | `attention` |
| `TurnEnd` | `stop`、`Stop`、`StopFailure`、`StopCancelled`、`sessionEnd`、`AfterAgent`、`afterAgentResponse` | `attention` |
| `Nothing` | 其他一切，以及所有子 Agent 事件 | 不变 |

查表之前先适用两条规则：

- 询问形态的工具（`request_user_input`、`ask_user_question`、`ask_user`、`ask_question`、`AskUserQuestion`）**本身就是询问**：它一次调用一次，与 Harness 的门禁无关。
- `fullyIdle` 为 `false` 的 `Stop` 是 Antigravity 中途暂停，读作 `Working` 而非 `TurnEnd`（§1.2）。

ingress 只做名字映射，从不做语义改写：Harness 的词汇原样传递，契约里没有对应事件名的事实用字段承载（`fullyIdle`，§1.2），而不是把某个事件改名成另一个。因此同一个名字对所有 Harness 含义一致——`PermissionRequest` 永远是"提示已经在屏幕上"，Antigravity 也不例外。

## 4. 状态机

`hook_state` 把结论变成状态，整个映射就这一张表：

| 结论 | 卡片 |
| --- | --- |
| `Working`、`TurnStart`、`MaybeAttention` | `working` |
| `Attention`、`TurnEnd` | `attention` |
| `Nothing`、`SessionStart` | 不变 |

`SessionStart` 落在该表之外：卡片仍在 `starting` 时它会把状态提升为 `attention`。

### 4.1 明确上报的 attention

这些是 CLI 在直接告诉 Que"屏幕上有一个提示"，立即生效：

- `Notification(permission_prompt)`、`Notification(ToolPermission)`、`Notification(idle_prompt)`
- `PermissionRequest`——Harness 自己上报的门禁
- `Stop` / `sessionEnd` / `AfterAgent`——回合结束，下一个该动的是用户。Antigravity 的暂停式 `Stop` 不在其列，见 §3
- 询问形态工具自身的工具启动事件

### 4.2 观察得到的 attention

并非每种等待都走 hook 协议。另有两个探针在观察字节流：

- **Kitty 通知**（`OSC 99`，以及传统的 `OSC 777;notify` / iTerm `OSC 9`）——Cursor 就是这样播报 "Cursor is waiting for you" 的。这才是 Cursor 真正的询问信号。任何通知都会把状态置为 `attention`，正文作为预览。
- **标题 / action-required 探针**——Codex 的 TUI 标题，以及 `OSC 9` 的 "action required" 行。两者都按"CLI 自己的上报"处理。

`observe_title` 与 `observe_notify` 遵循"最后写入者胜出"：标题 spinner 不会覆盖更新的 hook，但丢失的 hook 也永远不会让卡片卡死。

### 4.3 working

`UserPromptSubmit`——用户提交了提示，或工具正在运行。`working` 会清空 `replyPreview`，并重置任何挂起的猜测。

### 4.4 挂起的询问

Antigravity 与 Cursor 在**用户是否被询问**这点上发出的是同一个工具 hook：hook 跑在它们的门禁之前，载荷里没有任何字段说明门禁最后是怎么走的。把这些事件读成 `attention`，就会在每一次读文件、每一次 `grep` 时抬高卡片、重排队列并弹出通知——这是结构性的告警疲劳。

因此它们被当作猜测处理：

- `guesses_attention` 匹配 Antigravity 的 `PreToolUse`，以及 Cursor 的 `preToolUse` / `beforeShellExecution` / `beforeMCPExecution`。
- 这类信号把 `state` 置为 `working`，并打上 `held_attention_at`（首个猜测盖戳，后续猜测不会推移截止时间）与 `held_tool`。
- 自己会跑完的工具在毫秒级就会回报，它的后续事件（`PostToolUse`、标题、通知、回合结束）会清掉挂起，于是什么都不会显示。
- 真正在等人的工具保持沉默。`HELD_ATTENTION_MS`（5 秒）之后，挂起被**升级**为 `attention`。

升级需要同时满足两个条件：窗口已过，**且**卡片仍是 `working`。第二条很关键：如果 CLI 已经明确说过什么（通知、标题、回合结束），就没有猜测可升级了，再抬一次只会把用户刚处理的结果推翻。

升级没有任何 hook 会来触发，所以靠轮询：

| 路径 | 轮询 | 函数 |
| --- | --- | --- |
| 卡片 + OSC | 250ms | `mod.rs::promote_held` |
| 外部会话 | 500ms | `external.rs::promote_held_asks` |
| 参考实现 | 每次 snapshot | `runtime.ts` 的 `settleHeld` |

外部路径会把升级后的询问重新走一遍正常 ingress，因此提示的构建方式与其它提示完全一致。

**已知代价。** 单次工具调用一旦跑过窗口，会抬出一次迟到的询问，随后被该工具自己的完成事件收回。选 5 秒，是为了高于自动放行工具的往返耗时（几十到几百毫秒）、低于人的耐性；调小它意味着用更多迟到询问换更快的真实询问。若这个取舍需要再动，下一步就是把纯只读工具从猜测里整体剔除。

## 5. Harness 能力矩阵

| Kind | 注册的 hook 事件 | 真正的询问来源 | 猜测（挂起） |
| --- | --- | --- | --- |
| `claude`、`codebuddy` | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`Notification`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure` | `PermissionRequest`、`Notification(permission_prompt)` | — |
| `codex` | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop` | `PermissionRequest`、OSC 9 action-required | — |
| `cursor` | `sessionStart`、`beforeSubmitPrompt`、`preToolUse`、`postToolUse`、`postToolUseFailure`、`beforeShellExecution`、`beforeMCPExecution`、`afterAgentResponse`、`stop`、`sessionEnd` | OSC 99 通知、`stop` | `preToolUse`、`beforeShellExecution`、`beforeMCPExecution` |
| `antigravity` | `PreInvocation`、`PostInvocation`、`PreToolUse`、`PostToolUse`、`Stop` | 无（本身没有权限事件） | `PreToolUse` |
| `gemini` | `SessionStart`、`BeforeAgent`、`AfterAgent`、`BeforeTool`、`AfterTool`、`Notification` | `Notification` | — |
| `grok` | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`Stop`、`StopFailure`、`StopCancelled`、`Notification` | `Notification` | — |
| `opencode` | 插件：`session.*`、`permission.asked`、`question.asked`、`permission.replied`、`session.idle` | `permission.asked`、`question.asked` | — |
| `pi`、`omp` | 扩展：`session_start`、`before_agent_start`、`agent_start`、`agent_end` / `agent_settled`、`ui_prompt_start`、`ui_prompt_end` | `ui_prompt_start` | — |
| `devin` | `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`Stop`、`SessionEnd`、`PostCompaction` | — | `PermissionRequest` |
| `shell` | 无——改为探测 PTY 字节流 | 命令执行结束 | — |

所有 kind 都会丢弃子 Agent 事件（带 `agentId`）。

## 6. 诊断

开启 `QUE_HARNESS_DEBUG=1` 后，ingress 会追加 `hook-trace.jsonl`（事件、会话 id、以及各条投递链路是否成功）；对 Codex 的 `Stop` 还会写 `last-stop-diagnostic.json`（`replyFieldPresent`、`replyLength`、`previewLength`——只有字段元信息，绝不含文本）。

Rust 侧会把每个接入的信号按终端记录，附带 `source`：`hook` / `file` / `osc` / `notify-osc` / `title` / `probe`。一次被升级的挂起会记下自己的 `HeldAsk` 事件，包含挂起时长与它记录的工具名，因此事后能把"迟到询问"与真实询问区分开。同一份日志通过 `HarnessDebugSnapshot` 暴露出来。

## 7. 归属

事件映射沿用 Orca 的 Codex 适配器（MIT），镜像源码中亦有标注。

## 8. 文件地图

每家 Harness 拥有一个文件 `src-tauri/src/harness/kinds/<kind>.rs`，实现 `registry.rs` 声明的
`Harness` trait。注册表（`ALL`、`find`）是唯一分发点：启动、hook 安装、会话存取、事件词汇与
各家 quirk 全部从注册表读取，设置键的别名归并（`gemini` → `antigravity`、`omp` → `pi`）也以
`ingress_key` 的形式住在那里。新增一家 Harness = 新增一个文件 + `ALL` 加一行（前端在
`src/lib/harness/catalog.ts` 加一项）。

| 关注点 | 文件 |
| --- | --- |
| 注册表：`Harness` trait、分发、别名 | `src-tauri/src/harness/registry.rs` |
| 单家 Harness（启动、安装、会话存取、quirk） | `src-tauri/src/harness/kinds/<kind>.rs` |
| 状态机、共享词汇、挂起/升级 | `src-tauri/src/harness/signals.rs` |
| OSC 帧解码 | `src-tauri/src/harness/osc.rs` |
| 卡片指示（标题、通知） | `src-tauri/src/harness/notify_osc.rs`、`kinds/codex.rs` |
| 外部会话与提示 | `src-tauri/src/harness/external.rs` |
| 卡片接入、升级轮询 | `src-tauri/src/harness/mod.rs` |
| 安装机制（落盘、SSH、命令构造、环境变量） | `src-tauri/src/harness/install.rs` |
| 会话存取守卫与回退 | `src-tauri/src/harness/session_label.rs` |
| 入口：prepare / realign / 外部部署 | `src-tauri/src/harness/hooks.rs` |
| 前端注册表（选择器、外部开关、quirk） | `src/lib/harness/catalog.ts` |
| Ingress | `src-tauri/resources/bin/harness-hook.cjs`、`src-tauri/resources/bin/harness-opencode.mjs`、`src-tauri/resources/bin/harness-pi.mjs` |
| TypeScript 镜像 | `src-tauri/protocol-ref/harness/` |
