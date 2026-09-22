# Open in VS Code

Each card has a **Review** button with a monochrome VS Code icon, immediately
to the left of **Terminal**. Its tooltip says **Open in VS Code**. It opens the card's working
directory in a separate VS Code window using the installed `vscode://` handler.
For SSH cards, the directory comes from the workspace's remote `cwd`; the card's
own `cwd` is a local runtime cache and must not be passed to Remote-SSH.
Use VS Code's Source Control view to inspect Git changes and edit files.
Que no longer bundles Monaco or serves a repository review API.

Local directories are checked before opening. Install desktop VS Code with its
URL handler enabled. Successful dispatch means the OS accepted the link; it does
not confirm that VS Code finished loading the folder.

SSH workspaces use VS Code Remote-SSH. Hosts from `~/.ssh/config` retain their
alias, including port, key and proxy configuration. Que-only saved hosts support
default-port connections by hostname and optional user. For custom ports, keys
or IPv6, create an SSH config alias and select that host in Que. Remote paths
must be absolute Unix paths. VS Code handles its own authentication and server
installation; Que passwords and live SSH connections are not transferred.

Protocol reference: https://github.com/microsoft/vscode-docs/blob/main/remote-release-notes/v1_43.md
