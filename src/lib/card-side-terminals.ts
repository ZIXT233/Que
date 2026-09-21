import type { TerminalTab } from "@/components/terminal-tab-state";
import { discardTerminalSession } from "./terminal-pool";

const registry = new Map<string, string[]>();

export type CardSideTerminalRef = { id: string; cwd: string };

/** Where the side terminals of a card run when its workspace is an SSH host. */
export type RemoteShellTarget = { host: string; cwd: string };

export function sideTerminalsFromCard(saved: CardSideTerminalRef[] | undefined, cwd: string, sshHost?: string): TerminalTab[] {
  return (saved ?? [])
    .filter((tab) => /^[a-f0-9]{32}$/.test(tab.id))
    .map((tab) => ({ id: tab.id, cwd: tab.cwd.trim() || cwd, restored: true, ...(sshHost ? { sshHost } : {}) }));
}

export function rememberCardSideTerminals(cardId: string, tabIds: string[]) {
  registry.set(cardId, tabIds);
}

export function forgetCardSideTerminals(cardId: string) {
  registry.delete(cardId);
}

export async function persistCardSideTerminalOpen(cardId: string, open: boolean) {
  await fetch("/api/card-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "side_terminal_open", id: cardId, open }),
    keepalive: true,
  }).catch(() => {
    /* The next snapshot still has the last committed panel state. */
  });
}

export async function persistCardSideTerminal(cardId: string, tab: CardSideTerminalRef, op: "add" | "remove") {
  await fetch("/api/card-queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: op === "add" ? "side_terminal_add" : "side_terminal_remove",
      id: cardId,
      terminalId: tab.id,
      cwd: tab.cwd,
    }),
    keepalive: true,
  }).catch(() => {
    /* The next queue snapshot still owns the PTY; a failed index write must not kill it. */
  });
}

const ensuring = new Map<string, TerminalTab>();

export function peekEnsuringSideTerminal(cardId: string) {
  return ensuring.get(cardId);
}

export function rememberEnsuringSideTerminal(cardId: string, tab: TerminalTab) {
  ensuring.set(cardId, tab);
}

export function clearEnsuringSideTerminal(cardId: string, tabId?: string) {
  const current = ensuring.get(cardId);
  if (!current || (tabId && current.id !== tabId)) return;
  ensuring.delete(cardId);
}

export function dropCardSideTerminal(cardId: string, tab: CardSideTerminalRef) {
  clearEnsuringSideTerminal(cardId, tab.id);
  void persistCardSideTerminal(cardId, tab, "remove");
  discardTerminalSession(tab.id);
  void fetch(`/api/terminal/${encodeURIComponent(tab.id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

export function disposeCardSideTerminals(cardId: string, tabIds?: string[]) {
  const ids = new Set([...(tabIds ?? []), ...(registry.get(cardId) ?? [])]);
  for (const id of ids) {
    discardTerminalSession(id);
    void fetch(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {
      /* The card is already gone; a failed delete must not keep it around. */
    });
  }
  registry.delete(cardId);
}

export function disposeInactiveCardSideTerminals(liveCardIds: Iterable<string>) {
  const live = new Set(liveCardIds);
  for (const cardId of [...registry.keys()]) {
    if (!live.has(cardId)) disposeCardSideTerminals(cardId);
  }
}
