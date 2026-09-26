<h1 align="center"><img src="src-tauri/icons/icon.png" alt="Que logo" width="64" height="64" align="absmiddle" /> Que</h1>

<p align="center"><strong>Queue of Agent Cues</strong></p>

<p align="center">
  <a href="https://github.com/ZIXT233/Que/releases/latest"><img src="https://img.shields.io/github/v/release/ZIXT233/Que?style=flat-square&amp;color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/ZIXT233/Que/releases"><img src="https://img.shields.io/github/downloads/ZIXT233/Que/total?style=flat-square&amp;color=2ea66f" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-3b82f6?style=flat-square" alt="Windows, macOS, Linux" />
  <img src="https://img.shields.io/badge/Rust%20%2B%20Tauri%202-e88a39?style=flat-square" alt="Rust + Tauri 2" />
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/ZIXT233/Que/issues">Issues</a>
</p>

<h3 align="center"><a href="https://github.com/ZIXT233/Que/releases/latest">Download Que</a></h3>

Que schedules your attention with a unified queue of agent sessions, so you can just handle the one at the front without wondering which agents are still waiting for your reply.

Que lets you work directly with mainstream CLI agents in terminal cards, or receive notifications from sessions running elsewhere in notification cards. Que puts both kinds of cards in the same queue so you can handle them one by one.

## Features

<table>
<tr>
<td width="45%" valign="middle">
<h3>Pending-reply card queue</h3>
<p>Sessions waiting for a reply enter the queue. After your reply, they move to the working sidebar and return when they need you. Includes priority sorting, FIFO, reminders and separate windows.</p>
</td>
<td width="55%"><a href="docs/assets/queue-demo.gif"><img src="docs/assets/queue-demo.gif" alt="Sessions move between the pending queue and working sidebar" width="440" /></a></td>
</tr>
<tr>
<td width="45%" valign="middle">
<h3>External sessions</h3>
<p>Enable the corresponding hooks to collect sessions from IDEs, desktop apps and standalone terminals. Reply in the original app; the notice leaves the queue when work resumes.</p>
</td>
<td width="55%"><a href="docs/assets/external-notice.gif"><img src="docs/assets/external-notice.gif" alt="An external session enters the Que notice queue" width="440" /></a></td>
</tr>
<tr>
<td width="45%" valign="middle">
<h3>SSH workspaces & tmux</h3>
<p>Choose an SSH workspace and enable tmux keep-alive. Sessions keep running through a disconnect or client exit. Install the CLI and tmux on the remote host first.</p>
</td>
<td width="55%"><a href="docs/assets/remote-tmux.gif"><img src="docs/assets/remote-tmux.gif" alt="Choose a remote workspace and tmux, then open a terminal" width="440" /></a></td>
</tr>
</table>

## Supported harnesses

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
  <img src="docs/assets/harness/devin.svg" width="20" height="20" align="absmiddle" alt="" /> Devin &nbsp;
  <img src="examples/harness-extensions/qwen-code/qwen-color.svg" width="20" height="20" align="absmiddle" alt="" /> Qwen Code
</p>

Use your existing CLIs, accounts and model settings. Que sets up the integration when launching a card. A plain Shell card is also available. Enable external-session notices per tool in Settings. [Integration docs →](docs/harness/hook-api.md)

### Harness extensions

Que can add CLI harnesses through Node.js extensions. The Qwen Code extension ships with Que; you can place your own in `~/.que/extensions/<id>/`. The CLI and Node.js still need to be installed on the user's machine. See the [extension guide](docs/harness/extensions.md) and [Qwen Code example](examples/harness-extensions/qwen-code/README.md).

## Quick start

1. Download the build for your OS and architecture from [Releases](https://github.com/ZIXT233/Que/releases/latest).
2. Install and sign in to your CLI tool.
3. Choose a tool and workspace in Que, then create a session.

## Build from source

Requires Node.js 22+, Rust and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/ZIXT233/Que.git
cd Que
npm ci
npm run tauri dev
# Package for the current platform
npm run tauri build
```

App data lives in `~/.que`. See the [harness hook contract](docs/harness/hook-api.md).

## License

[MIT](LICENSE). Third-party components retain their own licenses and notices.

## Friends

[LINUX DO](https://linux.do)
