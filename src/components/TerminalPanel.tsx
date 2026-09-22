"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import type { TerminalThemeProfile } from "@/lib/terminal-theme";
import {
  acquireTerminalSession,
  liveThemeProfile,
  releaseTerminalSession,
  type TerminalConnectionStatus,
  type TerminalSession,
  type TerminalSessionSink,
  type TerminalSessionState,
} from "@/lib/terminal-pool";
import { TerminalStartupProgress } from "./TerminalStartupProgress";
import type { TerminalTab } from "./terminal-tab-state";
import { PersistentTerminalSlot } from "./PersistentTerminalViews";

export type { TerminalConnectionStatus };

interface Props {
  onOutput?: (data: string) => void;
  onStatusChange?: (status: TerminalConnectionStatus) => void;
  embedded?: boolean;
  themeProfile?: TerminalThemeProfile;
  remote?: boolean;
  readOnly?: boolean;
  /** Hide the xterm caret while ConPTY scrapes CUP cell-by-cell (Windows). */
  conptyCursorHide?: boolean;
  tab: TerminalTab;
  active: boolean;
  /** Reply to CSI ?1004h using the visible view's active state. */
  focusReporting?: boolean;
  inQueue?: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
  onUnavailable?: () => void;
  cardId?: string;
  harnessKind?: string;
  harnessName?: string;
  isStarting?: boolean;
  reconnectVersion?: number;
  placementVersion?: number;
}

/**
 * Queue and inspection locations only register slots. The page-level provider
 * keeps one TerminalPanelView and portal host per terminal id across moves.
 * Other pages without a provider retain the pooled-session fallback.
 */
export function TerminalPanel(props: Props) {
  return <PersistentTerminalSlot id={props.tab.id}><TerminalPanelView {...props} /></PersistentTerminalSlot>;
}

function TerminalPanelView({ tab, active, onRestart, onClosed, onCloseError, onUnavailable, embedded = false, readOnly = false, onStatusChange, onOutput, themeProfile, remote = false, focusReporting = false, conptyCursorHide = true, cardId, harnessKind, harnessName, isStarting, reconnectVersion = 0, placementVersion = 0 }: Props) {
  const { t } = useI18n();
  const { id, cwd, sshHost, restored } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError, onOutput, onUnavailable });
  callbacksRef.current = { onClosed, onCloseError, onOutput, onUnavailable };
  const optionsRef = useRef({ active, focusReporting, readOnly });
  optionsRef.current = { active, focusReporting, readOnly };

  const [view, setView] = useState<TerminalSessionState>(() => ({
    status: "connecting",
    error: null,
    exitCode: null,
    startupStage: isStarting || !restored ? "preparing" : "ready",
    showStartup: Boolean(isStarting || !restored),
    clipboardPending: null,
    dragging: false,
    startedAt: Date.now(),
  }));
  const { status, error, exitCode, startupStage, showStartup, clipboardPending, dragging, startedAt } = view;
  const [reconnectKey, setReconnectKey] = useState(0);
  const previousReconnectVersion = useRef(reconnectVersion);

  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [searchInvalid, setSearchInvalid] = useState(false);
  const [matches, setMatches] = useState({ resultIndex: -1, resultCount: 0 });
  const find = useCallback((previous = false, incremental = false) => {
    if (regex) {
      try { new RegExp(searchQuery); } catch { setSearchInvalid(true); searchRef.current?.clearDecorations(); return; }
    }
    setSearchInvalid(false);
    if (!searchQuery) { searchRef.current?.clearDecorations(); setMatches({ resultIndex: -1, resultCount: 0 }); return; }
    const options = { caseSensitive, regex, incremental, decorations: {
      matchBackground: "#796322", matchOverviewRuler: "#b69738",
      activeMatchBackground: "#35704d", activeMatchColorOverviewRuler: "#59c484",
    } };
    if (previous) searchRef.current?.findPrevious(searchQuery, options);
    else searchRef.current?.findNext(searchQuery, options);
  }, [caseSensitive, regex, searchQuery]);
  useEffect(() => {
    if (searchOpen) { searchInput.current?.focus(); find(false, true); }
    else searchRef.current?.clearDecorations();
  }, [searchOpen, find]);
  const closeSearch = () => { setSearchOpen(false); sessionRef.current?.focus(); };

  // The sink is swapped every render so the session always calls the latest
  // callbacks without re-attaching.
  const sinkRef = useRef<TerminalSessionSink>({ onUpdate: () => {} });
  sinkRef.current = {
    onUpdate: setView,
    onOutput: (data) => callbacksRef.current.onOutput?.(data),
    onClosed: () => callbacksRef.current.onClosed(),
    onCloseError: () => callbacksRef.current.onCloseError(),
    onUnavailable: () => callbacksRef.current.onUnavailable?.(),
    onOpenSearch: () => {
      setSearchOpen(true);
      requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
    },
    onSearchResults: setMatches,
  };

  // Attach before paint: a reused session's host is already populated, so the
  // terminal reappears without the serialize/replay flash a remount used to need.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (reconnectVersion > 0 && reconnectVersion !== previousReconnectVersion.current) releaseTerminalSession(id);
    previousReconnectVersion.current = reconnectVersion;
    const session = acquireTerminalSession({
      id, cwd, sshHost, restored, remote, themeProfile, harnessKind,
      conptyCursorHide, cardId,
      restarted: reconnectKey > 0,
      showStartup: Boolean(isStarting || !restored || reconnectKey > 0),
    });
    sessionRef.current = session;
    searchRef.current = session.search;
    const detach = session.attach(container, sinkRef, optionsRef.current);
    return () => {
      detach();
      if (sessionRef.current === session) sessionRef.current = null;
      if (searchRef.current === session.search) searchRef.current = null;
    };
  }, [id, cwd, sshHost, restored, remote, themeProfile, harnessKind, conptyCursorHide, cardId, reconnectKey, reconnectVersion]);

  useLayoutEffect(() => {
    sessionRef.current?.setViewOptions(sinkRef, { active, focusReporting, readOnly });
  }, [active, focusReporting, readOnly]);

  useLayoutEffect(() => {
    sessionRef.current?.refreshPlacement();
  }, [placementVersion]);

  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);

  useEffect(() => {
    if (!tab.closing) return;
    void sessionRef.current?.close();
  }, [id, tab.closing]);

  const reconnect = () => {
    releaseTerminalSession(id);
    setReconnectKey((key) => key + 1);
  };

  return (
    <section className={`terminal-panel${dragging ? " terminal-file-drag" : ""}${embedded ? " terminal-panel-embedded" : ""}`} data-terminal-theme={liveThemeProfile(themeProfile, remote)} suppressHydrationWarning aria-label={t("terminal.title")}>
      {!embedded && <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={reconnect} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 7l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>}
      <button type="button" className="terminal-find-toggle" onClick={() => setSearchOpen(true)} title={t("terminal.find")} aria-label={t("terminal.find")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg></button>
      {searchOpen && <div className="terminal-find" role="search" onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); find(event.shiftKey); }
      }}>
        <input ref={searchInput} aria-label={t("terminal.find")} placeholder={t("terminal.find")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} aria-invalid={searchInvalid} />
        <span role="status">{searchInvalid ? t("terminal.invalidRegex") : `${matches.resultIndex + 1}/${matches.resultCount}`}</span>
        <button type="button" onClick={() => setCaseSensitive((value) => !value)} aria-label={t("terminal.matchCase")} aria-pressed={caseSensitive}>Aa</button>
        <button type="button" onClick={() => setRegex((value) => !value)} aria-label={t("terminal.regex")} aria-pressed={regex}>.*</button>
        <button type="button" aria-label={t("terminal.previousMatch")} onClick={() => find(true)}>↑</button>
        <button type="button" aria-label={t("terminal.nextMatch")} onClick={() => find()}>↓</button>
        <button type="button" aria-label={t("files.cancel")} onClick={closeSearch}>×</button>
      </div>}
      {dragging && <div className="terminal-drop-hint">{t("terminal.dropFiles")}</div>}
      {showStartup && (
        <TerminalStartupProgress
          stage={startupStage}
          remote={remote}
          sshHost={sshHost}
          harnessKind={harnessKind}
          harnessName={harnessName}
          error={error}
          onRetry={reconnect}
          startedAt={startedAt}
        />
      )}
      <div className="terminal-panel-messages">
        {clipboardPending !== null && <button type="button" onClick={() => void copyText(clipboardPending).then(() => sessionRef.current?.clearClipboardPending()).catch(() => sessionRef.current?.setViewError(t("terminal.copyFailed")))}>{t("terminal.copyRemote")}</button>}
        {error && <div className="terminal-panel-error" role="alert">
          <span>{error.includes(" ") ? error : t(error)}</span>
          <button type="button" onClick={reconnect} disabled={Boolean(tab.closing)}>{t("terminal.reconnect")}</button>
        </div>}
        {!embedded && status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm" ref={containerRef} />
    </section>
  );
}
