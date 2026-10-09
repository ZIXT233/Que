# Que's way into a remote host's ACP owner, run by the SSH login shell.
# The owner lives in the tmux session "que-acp" and outlives SSH, like a
# terminal card's tmux session; this script only connects to it. Without tmux
# the owner runs on this connection and ends with it.
umask 077
B="@BUNDLE@"
N="$(command -v node)" || { echo "远程主机需要 Node.js 22.13 或更新版本" >&2; exit 127; }
"$N" "$B" --connect
code=$?
# 3: no owner is running. 4: an idle owner of another build just stopped.
[ "$code" -eq 3 ] || [ "$code" -eq 4 ] || exit "$code"
if command -v tmux >/dev/null 2>&1; then
  i=0
  while tmux has-session -t que-acp 2>/dev/null && [ "$i" -lt 10 ]; do sleep 1; i=$((i + 1)); done
  # tmux may hold an older environment: start the owner with this login's.
  L="$HOME/.queacp/runtime/serve.sh"
  { export -p; printf 'exec "%s" "%s" --serve\n' "$N" "$B"; } > "$L"
  tmux new-session -d -s que-acp "sh '$L'"
  exec "$N" "$B" --connect --wait
fi
exec "$N" "$B"
