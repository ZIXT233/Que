# Workspace terminal RC

Edit a workspace and enter a terminal RC script. Leave it empty to disable.
Saved scripts apply to newly started Agent sessions, shell cards and side
terminals in the same workspace and host. Existing processes keep their state.
Global shell configuration is not modified.

The script uses the startup shell's syntax: Bash/Zsh on Unix and SSH, or
PowerShell for local Windows RC sessions. Local PowerShell Core is also supported
when it is the configured login shell. Aliases, functions and environment settings
are loaded before the Agent command, with arguments preserved.

**Load and verify** executes the editor contents in a separate process on the
workspace host. It reports script loading output/errors without saving. It does
not inspect or invoke a specific application. Verification has a 15-second wait
limit and is not a sandbox or rollback mechanism.

Scripts may also run during version detection. Keep them suitable for repeated
startup; filesystem migrations belong outside RC scripts.
