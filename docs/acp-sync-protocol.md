# ACP 会话同步协议

会话状态只有一份真相：Node owner。Rust 保存一份缓存，界面保存一份视图。三处用同一套规则保持一致：先给完整快照，之后只给增量，序号对不上就重新取快照。

## 数据流

```
Agent ──增量事件──▶ owner ──snapshot/delta──▶ Rust 缓存 ──SSE──▶ 界面
                       ▲                          │
                       └──── resync / read ◀──────┘（序号对不上时）
```

- owner → Rust：stdio / socket 上的按行 JSON。
- Rust → 界面：`GET /api/acp/{id}/events`（SSE）。连接后先发当前快照，断线重连同样从快照开始。
- `GET /api/acp/{id}` 仍然存在，只用来在序号对不上时取一份完整快照。界面不再轮询。

## 事件

| 事件 | 内容 | 何时发送 |
| --- | --- | --- |
| `snapshot` | 完整会话，含 `ownerEpoch`、`revision` | 新连接、状态变化（启动、完成、审批、取消等）、`resync` |
| `delta` | `{epoch, base, rev, ops}`，只在持有 `base` 版本时可应用 | 流式输出（文字追加、工具调用更新、用量、命令列表） |

`revision` 在同一个 `ownerEpoch` 内只增不减，允许跳号，所以只需要 `base` 与本地版本相等。

增量操作：

- `append {turn, block, text}`：给指定块的文字追加。
- `block {turn, block, value}`：设置或新增一个块（`block` 等于长度时为新增）。
- `set {key, value}`：只允许 `context`、`commands`。

应用结果只有三种：成功；已包含（`rev` 不超过本地版本，忽略）；对不上（epoch 不同、`base` 不等、找不到 turn/块、未知操作，需要重新同步）。失败的增量不会改动已有状态。

## 节流与顺序

- owner 对每个会话 60ms 内最多发一次：第一条立即发，窗口内的后续增量合并成一条（连续的 `append` 拼接成一个）。状态变化不等待窗口，立即发送完整快照并取代尚未发出的增量。
- owner 在写出任何 RPC 响应之前，先发出所有待发事件，所以响应里的会话版本不会超前于事件流。
- 每个客户端的版本单独记录：中途加入或失步的客户端收到快照，而不是对不上的增量。
- 界面按 16ms 一帧合并事件，一批只渲染一次。
- 流式文字不会唤醒队列刷新；只有快照事件才会（队列状态只随状态变化改变）。

## 一致性保证与约束

- `src/lib/acp-delta.ts`（界面）与 `src-tauri/src/acp.rs`（缓存）实现同一份规则，并共用 `tests/acp/delta-vectors.json` 验证。
- `runtime/session-wire.mjs` 是 owner 一侧的实现，`tests/acp/session-wire.test.mjs` 覆盖合并、取代、新客户端、失步修复。
- `tests/acp/acp-stream.test.mjs` 用真实 owner + 真实 Rust + 假 Agent 验证：回放事件流得到的状态与服务端完全一致。
- 协议版本号随 owner 的 `protocolVersion` 变化（当前 `acpx-history-v3`）；不兼容的旧 owner 不会被连接。

## 未做

- 历史分页与按需加载：连接时仍发送完整会话。
- 多会话共用一条流：目前每个正在显示的会话一条 SSE。
