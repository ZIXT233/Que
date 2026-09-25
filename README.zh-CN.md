<h1 align="center"><img src="src-tauri/icons/icon.png" alt="Que logo" width="64" height="64" align="absmiddle" /> Que</h1>

<p align="center"><strong>让 Agent 排队找你</strong></p>

<p align="center">
  <a href="https://github.com/ZIXT233/Que/releases/latest"><img src="https://img.shields.io/github/v/release/ZIXT233/Que?style=flat-square&amp;color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/ZIXT233/Que/releases"><img src="https://img.shields.io/github/downloads/ZIXT233/Que/total?style=flat-square&amp;color=2ea66f" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-3b82f6?style=flat-square" alt="Windows, macOS, Linux" />
  <img src="https://img.shields.io/badge/Rust%20%2B%20Tauri%202-e88a39?style=flat-square" alt="Rust + Tauri 2" />
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/ZIXT233/Que/issues">反馈</a>
</p>

<h3 align="center"><a href="https://github.com/ZIXT233/Que/releases/latest">下载 Que</a></h3>

Que 通过统一的待处理 Agent 会话队列调度你的注意力，让你只需处理队首，而不用追着通知小红点跑。

Que 通过终端卡片支持主流 CLI Harness，让你可以在同一个地方处理多个 Harness 工作流。

## 功能

<table>
<tr>
<td width="45%" valign="middle">
<h3>待回复卡片队列</h3>
<p>需要回复的会话进入队列，回复后移到侧边栏工作，需要你时再回队。支持优先级排序、先进先出、稍后提醒和独立窗口。</p>
</td>
<td width="55%"><a href="docs/assets/queue-demo.gif"><img src="docs/assets/queue-demo.gif" alt="会话在待回复队列和工作侧栏之间切换" width="440" /></a></td>
</tr>
<tr>
<td width="45%" valign="middle">
<h3>外部会话接入</h3>
<p>启用对应 hook 后，IDE、桌面应用和独立终端中的会话也能进入通知队列。在原应用处理后，通知卡自动退出。</p>
</td>
<td width="55%"><a href="docs/assets/external-notice.gif"><img src="docs/assets/external-notice.gif" alt="外部会话进入 Que 通知队列" width="440" /></a></td>
</tr>
<tr>
<td width="45%" valign="middle">
<h3>远程工作区与 tmux</h3>
<p>新建会话时选择 SSH 工作区，可启用 tmux 保活。连接断开或客户端退出后，会话继续运行。远程主机需安装对应 CLI 和 tmux。</p>
</td>
<td width="55%"><a href="docs/assets/remote-tmux.gif"><img src="docs/assets/remote-tmux.gif" alt="选择远程工作区和 tmux 并打开终端" width="440" /></a></td>
</tr>
</table>

## 支持的 Harness

<p align="center">
  <img src="docs/assets/harness/openai.svg" width="20" height="20" align="absmiddle" alt="" /> Codex &nbsp;
  <img src="docs/assets/harness/anthropic.svg" width="20" height="20" align="absmiddle" alt="" /> Claude Code &nbsp;
  <img src="docs/assets/harness/cursor.svg" width="20" height="20" align="absmiddle" alt="" /> Cursor Agent &nbsp;
  <img src="docs/assets/harness/opencode.svg" width="20" height="20" align="absmiddle" alt="" /> OpenCode &nbsp;
  <img src="docs/assets/harness/antigravity.svg" width="20" height="20" align="absmiddle" alt="" /> Antigravity
</p>
<p align="center">
  <img src="docs/assets/harness/pi.svg" width="20" height="20" align="absmiddle" alt="" /> Pi &nbsp;
  <img src="docs/assets/harness/omp.svg" width="20" height="20" align="absmiddle" alt="" /> Oh My Pi &nbsp;
  <img src="docs/assets/harness/codebuddy.svg" width="20" height="20" align="absmiddle" alt="" /> CodeBuddy &nbsp;
  <img src="docs/assets/harness/grok.svg" width="20" height="20" align="absmiddle" alt="" /> Grok Build &nbsp;
  <img src="docs/assets/harness/devin.svg" width="20" height="20" align="absmiddle" alt="" /> Devin
</p>

使用已有的 CLI、账号和模型配置，从卡片启动时自动完成接入。另提供普通 Shell 卡片。外部会话通知在设置中按工具开启。[接入文档 →](docs/harness/hook-api.zh-CN.md)

## 开始使用

1. 从 [Releases](https://github.com/ZIXT233/Que/releases/latest) 下载对应系统和架构的安装包。
2. 安装并登录要使用的 CLI 工具。
3. 在 Que 中选择工具和工作区，新建会话。

## 从源码运行

需要 Node.js 22+、Rust 和当前平台的 [Tauri 2 依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
git clone https://github.com/ZIXT233/Que.git
cd Que
npm ci
npm run tauri dev
# 打包当前平台
npm run tauri build
```

应用数据在 `~/.que`。参见 [Harness Hook 协议](docs/harness/hook-api.zh-CN.md)、[自定义 Harness 扩展指南](docs/harness/extensions.zh-CN.md)与[Qwen Code 扩展示例](examples/harness-extensions/qwen-code/README.zh-CN.md)。

## 协议

[MIT](LICENSE)。第三方组件保留各自的协议与版权声明。
