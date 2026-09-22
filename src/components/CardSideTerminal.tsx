"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clearEnsuringSideTerminal, dropCardSideTerminal, peekEnsuringSideTerminal, persistCardSideTerminal, persistCardSideTerminalOpen, rememberCardSideTerminals, rememberEnsuringSideTerminal, sideTerminalsFromCard, type CardSideTerminalRef, type RemoteShellTarget } from "@/lib/card-side-terminals";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useI18n } from "@/hooks/useI18n";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, type TerminalTab } from "./terminal-tab-state";

const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;

export function useCardExtraTerminals({
  cardId,
  cwd,
  remoteShell,
  enabled,
  saved,
}: {
  cardId: string;
  cwd: string;
  remoteShell?: RemoteShellTarget;
  enabled: boolean;
  saved?: CardSideTerminalRef[];
}) {
  // A remote card's terminal belongs to the workspace's machine, so both the
  // starting directory and the host come from there — never from `cwd`, which is
  // the card's *local* runtime directory on a remote workspace.
  const baseCwd = remoteShell?.cwd ?? cwd;
  const sshHost = remoteShell?.host;
  const dropped = useRef(new Set<string>());
  const [tabs, setTabs] = useState<TerminalTab[]>(() => sideTerminalsFromCard(saved, baseCwd, sshHost));
  const [activeId, setActiveId] = useState<string | null>(() => sideTerminalsFromCard(saved, baseCwd, sshHost)[0]?.id ?? peekEnsuringSideTerminal(cardId)?.id ?? null);
  const savedKey = (saved ?? []).map((tab) => tab.id).join(",");

  useEffect(() => {
    for (const id of [...dropped.current]) {
      if (!(saved ?? []).some((tab) => tab.id === id)) dropped.current.delete(id);
    }
    const incoming = sideTerminalsFromCard(saved, baseCwd, sshHost).filter((tab) => !dropped.current.has(tab.id));
    setTabs((current) => {
      const incomingIds = new Set(incoming.map((tab) => tab.id));
      const optimistic = current.filter((tab) => !incomingIds.has(tab.id) && !tab.restored && !dropped.current.has(tab.id));
      const merged = [...incoming, ...optimistic];
      return merged.length === current.length && merged.every((tab, index) => tab.id === current[index]?.id)
        ? current
        : merged;
    });
    setActiveId((current) => {
      if (current && incoming.some((tab) => tab.id === current)) return current;
      return incoming[0]?.id ?? current;
    });
    if (incoming.some((tab) => tab.id === peekEnsuringSideTerminal(cardId)?.id)) {
      clearEnsuringSideTerminal(cardId);
    }
  }, [cardId, baseCwd, sshHost, saved, savedKey]);

  useEffect(() => {
    if (enabled) rememberCardSideTerminals(cardId, tabs.map((tab) => tab.id));
  }, [cardId, enabled, tabs]);

  const dropTab = useCallback((id: string, nextCwd = baseCwd) => {
    dropped.current.add(id);
    dropCardSideTerminal(cardId, { id, cwd: nextCwd });
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id);
      setActiveId((active) => active === id ? remaining.at(-1)?.id ?? null : active);
      return remaining;
    });
  }, [cardId, baseCwd]);

  const addTab = useCallback(() => {
    if (!enabled) return null;
    const tab = newTerminalTab(baseCwd, sshHost);
    dropped.current.delete(tab.id);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    void persistCardSideTerminal(cardId, tab, "add");
    return tab;
  }, [cardId, baseCwd, sshHost, enabled]);

  const ensureTab = useCallback(() => {
    if (!enabled) return;
    setTabs((current) => {
      if (current.length > 0) return current;
      const incoming = sideTerminalsFromCard(saved, baseCwd, sshHost).filter((tab) => !dropped.current.has(tab.id));
      if (incoming.length > 0) {
        setActiveId(incoming[0].id);
        return incoming;
      }
      const pending = peekEnsuringSideTerminal(cardId);
      if (pending && !dropped.current.has(pending.id)) {
        setActiveId(pending.id);
        return [pending];
      }
      const tab = newTerminalTab(baseCwd, sshHost);
      rememberEnsuringSideTerminal(cardId, tab);
      setActiveId(tab.id);
      void persistCardSideTerminal(cardId, tab, "add");
      return [tab];
    });
  }, [cardId, baseCwd, sshHost, enabled, saved]);

  const closeTab = useCallback((id: string) => {
    const tab = tabs.find((item) => item.id === id);
    dropTab(id, tab?.cwd);
  }, [dropTab, tabs]);

  const restartTab = useCallback((id: string) => {
    const tab = tabs.find((item) => item.id === id);
    dropTab(id, tab?.cwd);
    addTab();
  }, [addTab, dropTab, tabs]);

  return { tabs, activeId, setActiveId, addTab, ensureTab, closeTab, restartTab, dropTab };
}

export function TerminalTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onAdd,
  disabled,
}: {
  tabs: TerminalTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="cq-terminal-tabs" role="tablist" aria-label={t("terminal.title")}>
      <div className="cq-terminal-tab-list">
        {tabs.map((tab, index) => (
          <div key={tab.id} className="cq-terminal-tab" data-active={tab.id === activeId} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              className="cq-terminal-tab-select"
              onClick={() => onSelect(tab.id)}
            >
              {t("terminal.tabLabel", { name: String(index + 1) })}
            </button>
            <button
              type="button"
              className="cq-terminal-tab-close"
              disabled={disabled}
              aria-label={t("terminal.close")}
              title={t("terminal.close")}
              onClick={() => onClose(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="cq-terminal-tab-add"
        disabled={disabled}
        aria-label={t("terminal.newTab")}
        title={t("terminal.newTab")}
        onClick={onAdd}
      >
        +
      </button>
    </div>
  );
}

export function CardExtraTerminalPanes({
  tabs,
  activeId,
  active,
  remote,
  cardId,
  onRestart,
  onUnavailable,
}: {
  tabs: TerminalTab[];
  activeId: string | null;
  active: boolean;
  remote?: boolean;
  cardId?: string;
  onRestart: (id: string) => void;
  onUnavailable: (id: string) => void;
}) {
  return tabs.map((tab) => (
    <div key={tab.id} className="cq-side-terminal-body" hidden={tab.id !== activeId}>
      <TerminalPanel
        embedded
        cardId={cardId}
        remote={remote}
        tab={tab}
        active={active && tab.id === activeId}
        onRestart={() => onRestart(tab.id)}
        onClosed={() => {}}
        onCloseError={() => {}}
        onUnavailable={() => onUnavailable(tab.id)}
      />
    </div>
  ));
}

export function CardSideTerminal({
  cardId,
  cwd,
  remoteShell,
  active,
  enabled,
  saved,
  savedOpen,
  children,
}: {
  cardId: string;
  cwd: string;
  remoteShell?: RemoteShellTarget;
  active: boolean;
  enabled: boolean;
  saved?: CardSideTerminalRef[];
  savedOpen?: boolean;
  children: (ui: { button: ReactNode; panel: ReactNode }) => ReactNode;
}) {
  const ui = useCardSideTerminal({ cardId, cwd, remoteShell, active, enabled, saved, savedOpen });
  return children(ui);
}

function useCardSideTerminal({
  cardId,
  cwd,
  remoteShell,
  active,
  enabled,
  saved,
  savedOpen,
}: {
  cardId: string;
  cwd: string;
  remoteShell?: RemoteShellTarget;
  active: boolean;
  enabled: boolean;
  saved?: CardSideTerminalRef[];
  savedOpen?: boolean;
}) {
  const { t } = useI18n();
  const extras = useCardExtraTerminals({ cardId, cwd, remoteShell, enabled, saved });
  const [open, setOpen] = useState(!!savedOpen);
  const lastSavedOpen = useRef(!!savedOpen);
  // Echo guard: after a local toggle, our own persisted writes come back as
  // savedOpen snapshots that can lag behind newer local toggles and resurrect
  // a just-closed panel. Local state is the source of truth from then on.
  const userToggled = useRef(false);
  useEffect(() => {
    if (lastSavedOpen.current === !!savedOpen) return;
    lastSavedOpen.current = !!savedOpen;
    if (userToggled.current) return;
    setOpen(!!savedOpen);
  }, [savedOpen]);
  const initialEnsured = useRef(false);
  useEffect(() => {
    if (!initialEnsured.current) {
      initialEnsured.current = true;
      if (open && extras.tabs.length === 0) extras.ensureTab();
    }
  }, [open, extras]);
  const widthRef = useRef(DEFAULT_WIDTH);
  const maxWidth = useCallback(() => {
    if (typeof window === "undefined") return MAX_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.45)));
  }, []);
  const resize = useResizablePanel({
    ariaLabel: t("queue.resizeSideTerminal"),
    cssVariable: "--cq-side-terminal-width",
    defaultWidth: DEFAULT_WIDTH,
    getMaxWidth: maxWidth,
    growthDirection: "left",
    maxWidth: MAX_WIDTH,
    minWidth: MIN_WIDTH,
    storageKey: "que:card-side-terminal-width",
    widthRef,
  });

  const setPanelOpen = (next: boolean) => {
    userToggled.current = true;
    setOpen(next);
    void persistCardSideTerminalOpen(cardId, next);
    if (next) extras.ensureTab();
  };

  const toggle = () => {
    setPanelOpen(!open);
  };

  const closeTab = (id: string) => {
    extras.closeTab(id);
    if (extras.tabs.filter((tab) => tab.id !== id).length === 0) setPanelOpen(false);
  };

  const button = enabled ? (
    <SideTerminalButton
      pressed={open}
      label={t("queue.sideTerminal")}
      onClick={toggle}
    />
  ) : null;

  const panel = enabled && extras.tabs.length > 0 ? (
    <div
      ref={resize.panelRef}
      className="cq-side-terminal-layer"
      hidden={!open}
      style={{ "--cq-side-terminal-width": `${resize.width}px` } as CSSProperties}
    >
      {open && <div {...resize.separatorProps} className={`panel-resize-handle cq-side-terminal-resize${resize.isResizing ? " is-resizing" : ""}`} />}
      <aside
        className="cq-card-side-terminal"
        aria-label={t("queue.sideTerminal")}
      >
        <div className="cq-side-terminal-heading">
          <TerminalTabBar
            tabs={extras.tabs}
            activeId={extras.activeId}
            onSelect={extras.setActiveId}
            onClose={closeTab}
            onAdd={() => extras.addTab()}
          />
        </div>
        <CardExtraTerminalPanes
          tabs={extras.tabs}
          activeId={extras.activeId}
          active={active && open}
          cardId={cardId}
          remote={!!remoteShell}
          onRestart={extras.restartTab}
          onUnavailable={(id) => extras.dropTab(id)}
        />
      </aside>
    </div>
  ) : null;

  return { button, panel, open };
}

export function SideTerminalButton({
  disabled,
  pressed,
  label,
  onClick,
}: {
  disabled?: boolean;
  pressed?: boolean;
  label: string;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="cq-tools-trigger cq-side-terminal-trigger"
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M5 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H5Zm.8 5.8 3.2 3.2-3.2 3.2 1.4 1.4 4.6-4.6-4.6-4.6-1.4 1.4ZM13 14v2h5v-2h-5Z" clipRule="evenodd" /></svg>
      <span>{t("terminal.title")}</span>
    </button>
  );
}

export function CardWorkspace({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <div className="cq-card-workspace">
      <div className="cq-card-main">{children}</div>
      {side}
    </div>
  );
}
