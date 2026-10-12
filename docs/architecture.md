# QueACP 架构

QueACP 是 Que 的 ACP 版本：卡片里的 Agent 通过 ACP（经由 acpx）运行，Que 拿到结构化的回合、工具调用和权限请求，而不是终端画面。卡片排队的哲学不变：需要你的会话排到你面前，你回复后它去工作，需要你时再回来。

## 三层，各管一样东西

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| **Que**（Rust，`src-tauri`） | 卡片与队列（`queue.json`）、卡片设置（用哪个 Agent、主机访问）、卡片之间的信道、MCP 鉴权、卡片的收件箱、管家的汇总、把会话事件转给界面 | 对话内容、Agent 进程 |
| **owner**（Node，`runtime/acp-owner.mjs`） | 调用 acpx；本次运行中提交的回合；等人回答的请求；由这些推导出的卡片状态 | 卡片排序、卡片设置、保存对话 |
| **acpx** | Agent 进程、ACP 会话、对话记录（`~/.acpx/sessions`）、回合排队、恢复会话 | 一切 Que 概念 |

每样状态只有一个主人。owner 不另存对话；Que 不缓存对话之外的结论；acpx 不知道卡片。

## 映射

```
工作区的 Agent 环境（目录 + 环境变量 + 启动脚本）  =  一个 AcpRuntime
卡片                                             =  一个 acpx 会话，sessionKey = 卡片编号
卡片的对话                                         =  这个会话的 acpx 记录
历史对话里的一条记录                               =  一张卡片（记录编号就是卡片编号）
```

## 规则

1. **一张卡就是一段对话。** 卡片不换绑 Agent 或目录；会话坏了就归档，再新建一张。
2. **空会话不恢复。** 还没有任何对话的会话，重连时直接新开（acpx `prepareFreshSession`）；有过对话的会话照常恢复，恢复失败如实报错。
3. **对话只在 acpx 记录里。** 进行中的回合只在 owner 内存里；Que 或 owner 退出时，没进入 acpx 记录的东西就没有了，从不重放。唯一的附加是卡片之间的消息：acpx 不记工具输出，owner 把它们存成附注，挂在 acpx 的回合编号上，加载时放回原处（见 [agent-interaction.md](agent-interaction.md)）。
4. **消息的来源写在消息里。** 来自其他卡片或 Que 通知的消息带一行固定格式的说明（`runtime/session-history.mjs`），Agent 读得到，记录里也就有，不另存。
5. **卡片设置归 Que。** 用哪个 Agent、是否允许访问本机，存在卡片上，每次连接时交给 owner。
6. **卡片状态由 acpx 的活动推导。** 有人要回答的请求 → 等你；有回合在跑 → 工作中；已连接且空闲 → 等你；否则未运行或出错。牌堆和侧栏只看这个。
7. **待确认的请求只属于人。** 权限和表单只能在卡片里由人回答；MCP 没有回答它们的工具，管家和其他卡片的消息也不能代答。
8. **本机进程随 Que 结束；远程会话在 tmux 里常驻。** 本机 owner 是 Que 的子进程，Que 退出、崩溃、被杀，它都会关掉所有 Agent。远程 owner 以 `--serve` 跑在 tmux 会话 `que-acp` 里，断网、关掉 Que 都继续工作；Que 再连上时通过 `--connect` 接回（`resources/remote-owner.sh`）。远程没有 tmux 就不保活。
9. **Que 只用完整快照做判断。** owner 在每次状态变化时发完整快照；流式文字和工具进度是增量，Que 原样转给界面，不解析。

## 进程

```
Que（Rust）
├─ 本机 owner（node，stdio 子进程）
│    └─ AcpRuntime × 工作区环境 ── Agent 进程 × 卡片
└─ SSH ── remote-owner.sh ── --connect ⇄ tmux: que-acp ── 远程 owner --serve
                                                         └─ AcpRuntime × 工作区环境 ── Agent 进程 × 卡片
```

- 同一份数据目录只允许一个 owner（`owner.pid`）。
- owner 退出时：拒绝所有待确认请求、取消进行中的回合、给 acpx 2 秒关停 Agent，仍未退出的由 owner 记录的进程表直接结束。owner 被强杀时，下一个 owner 启动会清理上一个留下的 Agent（仅 Linux 能确认进程身份）。
- 新版本连到远程旧版 owner：旧版空闲就退出让位，正在工作就继续服务，下次重连再换。

## 管家

管家就是管家工作区（`~/.queacp/butler`）里的一张卡，遵守同样的规则：可以有多个管家会话，旧的归档，按钮打开现有的或新建一张；按钮自己从不启动 Agent。管家的延续靠工作区里的文件（`AGENTS.md` 让 Agent 先读 `ROLE.md`、`USER.md`、`MEMORY.md`、`STATE.md`），不靠某一段会话。

- **不被逐个事件唤醒**：其他卡片的完成、失败只被收集，到设置里的汇总时间（下拉预设，底层为 cron）一次交给管家；汇总后管家卡排进队列。
- **信道**：两张卡有信道才能互相发消息、读会话；你在卡片上连接，或者在 Agent 请求时允许。管家和所有卡连通。
- **消息**：卡片之间用 `send_message` 发消息（一张、几张或全部），放进对方的收件箱，只交付一次：对方空闲时成为它的下一轮；正忙时随它下一次 QueACP 工具结果或 `wait_messages` 交给它。回复也是消息，没有自动回传；防循环靠限速和去重。见 [agent-interaction.md](agent-interaction.md)。
- **精简读取**：`read_session` 默认只给最近几轮的消息和最终回复摘录。

## 平铺模式

工作模式之一（`src/components/CardCanvas.tsx`）：没有侧边栏和牌堆，所有卡固定在一张画布上，位置不随状态变化，需要你的卡亮起边框，没有飞入动画和横幅。画布只有一种布局，每格都是完整卡片的大小；总览是整张画布缩小，点一张卡就把整张画布放大到它，四周仍看得到相邻的卡，拖动画布或 Alt+方向键切换，Esc 回到总览。只把大的缩小、从不把小的放大，所以打开的卡是原尺寸、清晰的。每格的封面显示状态、当前工具和最近几行回复，来自合并的事件流。

## 协议

owner 与 Que 之间是按行 JSON：请求带 `rpc`，响应带同一个 `rpc`；会话变化以 `snapshot` / `delta` 事件推送，见 [acp-sync-protocol.md](acp-sync-protocol.md)。

| 动作 | 作用 |
| --- | --- |
| `ensure` | 连接卡片的会话（新建或恢复） |
| `send` / `cancel` / `answer` | 发消息（含通知）、取消或撤回排队、回答待确认请求 |
| `config` / `model` / `mode` / `host_access` / `close` | 会话控制 |
| `read` | 取完整快照 |
| `catalog` / `health` | 可用 Agent（已安装的在前）、连接状态 |
| `history` / `history_native` / `attach` | 历史对话、Agent 自己的会话、接回为卡片 |

## 刻意不做

- **历史回合里的工具输出内容**：acpx 记录不保存 ACP 工具调用的完整内容（如 diff）。重启后历史只显示调用了什么工具；不为此往 acpx 记录里塞私有字段。
- **acpx 的共享会话主控**：它不能注入 MCP 服务和工作区环境，远程保活改用 tmux。
- **旧数据迁移**：旧版 `bindings.json` 和旧卡片的对话不迁移。
