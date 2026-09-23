<h1 align="center"><img src="src-tauri/icons/icon.png" alt="Que logo" width="64" height="64" align="absmiddle" /> Que</h1>

<p align="center"><strong>Queue of Agent Cues</strong></p>

<p align="center">
  <a href="https://github.com/ZIXT233/Que/releases/latest"><img src="https://img.shields.io/github/v/release/ZIXT233/Que?style=flat-square&amp;color=3b82f6" alt="Latest release" /></a>
  <a href="https://github.com/ZIXT233/Que/releases"><img src="https://img.shields.io/github/downloads/ZIXT233/Que/total?style=flat-square&amp;color=2ea66f" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-64748b?style=flat-square" alt="Windows, macOS, Linux" />
  <img src="https://img.shields.io/badge/Rust%20%2B%20Tauri%202-e88a39?style=flat-square" alt="Rust + Tauri 2" />
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/ZIXT233/Que/issues">Issues</a>
</p>

<h3 align="center"><a href="https://github.com/ZIXT233/Que/releases/latest">Download Que</a></h3>

Que schedules your attention with a unified queue of waiting Agent sessions, so you can just handle the one at the front instead of chasing notification badges.

Que supports mainstream CLI harnesses through terminal cards, so you can handle multiple harness workflows in one place.

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
  <kbd><img src="docs/assets/harness/openai.svg" width="16" height="16" alt="" /> Codex</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/anthropic.svg" width="16" height="16" alt="" /> Claude Code</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/cursor.svg" width="16" height="16" alt="" /> Cursor Agent</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/opencode.svg" width="16" height="16" alt="" /> OpenCode</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/antigravity.svg" width="16" height="16" alt="" /> Antigravity</kbd>
</p>
<p align="center">
  <kbd><img src="docs/assets/harness/pi.svg" width="16" height="16" alt="" /> Pi</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/omp.svg" width="16" height="16" alt="" /> Oh My Pi</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/codebuddy.svg" width="16" height="16" alt="" /> CodeBuddy</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/grok.svg" width="16" height="16" alt="" /> Grok Build</kbd> &nbsp;
  <kbd><img src="docs/assets/harness/devin.svg" width="16" height="16" alt="" /> Devin</kbd>
</p>

Use your existing CLIs, accounts and model settings. Que sets up the integration when launching a card. A plain Shell card is also available. Enable external-session notices per tool in Settings. [Integration docs →](docs/harness/hook-api.md)

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

App data lives in `~/.que`.


## License

[MIT](LICENSE). Third-party components retain their own licenses and notices.
