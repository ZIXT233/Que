# ACP 会话同步协议

会话状态只有一份真相：owner。界面保存一份视图，用同一套规则保持一致：先给完整快照，之后只给增量，序号对不上就重新取快照。Que（Rust）只保存每张卡最近一次的完整快照，用来做队列判断，不处理增量。

## 数据流

```
Agent ──事件──▶ owner ──snapshot / delta──▶ Que ──SSE──▶ 界面
                  ▲                          │（增量原样转发）
                  └──────── read ◀───────────┘（界面打开卡片时、或发现序号对不上时）
```

- owner → Que：stdio（本机）或 SSH 转发到 tmux 里的 owner（远程）上的按行 JSON。
- Que → 界面：`GET /api/acp/events`（SSE），界面唯一的会话流。所有已连接卡片合在一条流里，每个事件是 `{id, data}`。连上时先发每张卡缓存的快照，之后按顺序转发每张卡的事件；Que 丢了更新就把缓存快照全部重发。只有一条流，是因为浏览器对同一地址只开少数几条连接，一张卡一条流会把其他连接挤掉。
- `GET /api/acp/{id}`：取一份完整快照，界面打开一张卡、或序号对不上时使用。
- 界面（`src/lib/session-store.ts`）只开这一条流：卡片面、总览、启动进度用按卡合并好的快照（`useSessionSnapshot`，同一个 `foldEvents`）；会话视图要叠加自己的乐观消息，取该卡的原始事件（`subscribeSessionEvents`）自己合并。

## 事件

| 事件 | 内容 | 何时发送 |
| --- | --- | --- |
| `snapshot` | 完整会话，含 `ownerEpoch`、`revision` | 新连接、每次状态变化（启动、完成、待确认、取消、配置变化等） |
| `delta` | `{epoch, base, rev, ops}`，只在持有 `base` 版本时可应用 | 流式输出（文字追加、工具调用更新、用量、命令列表） |

`revision` 在同一个 `ownerEpoch` 内只增不减，允许跳号，所以只需要 `base` 与本地版本相等。

增量操作：

- `append {turn, block, text}`：给指定块的文字追加。
- `block {turn, block, value}`：设置或新增一个块（`block` 等于长度时为新增）。
- `set {key, value}`：只允许 `context`、`commands`。

界面应用增量的结果只有三种：成功；已包含（`rev` 不超过本地版本，忽略）；对不上（epoch 不同、`base` 不等、找不到回合或块、未知操作，重新取快照）。失败的增量不改动已有状态。

## 为什么 Que 不处理增量

Que 关心的只有状态：卡片该进牌堆还是侧栏、哪一轮结束了、有没有等人回答的请求。这些变化 owner 都以完整快照发出。增量只承载流式文字和工具进度，只有界面要显示它们，所以由界面独自折叠。

## 节流与顺序

- owner 对每个会话 60ms 内最多发一次：第一条立即发，窗口内的后续增量合并成一条（连续的 `append` 拼接成一个）。状态变化不等待窗口，立即发完整快照并取代尚未发出的增量。
- owner 在写出任何 RPC 响应之前，先发出所有待发事件，所以响应里的会话版本不会超前于事件流。
- 每个客户端的版本单独记录：中途加入的客户端收到快照，而不是对不上的增量。
- 界面按 16ms 一帧合并事件，一批只渲染一次。

## 验证

- `src/lib/acp-delta.ts` 实现界面一侧的规则，用 `tests/acp/delta-vectors.json` 验证。
- `runtime/session-wire.mjs` 是 owner 一侧的实现，`tests/acp/session-wire.test.mjs` 覆盖合并、取代、新客户端、失步修复。
- `tests/acp/acp-stream.test.mjs` 用真实 owner、真实 Que 和假 Agent 验证：回放事件流得到的状态与 owner 完全一致。

## 未做

- 历史分页与按需加载：连接时仍发送完整会话。
- 多会话共用一条流：每个正在显示的会话一条 SSE。
