"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createShellProbe } from "@/lib/harness/shell-probe";
import { harnessPicker, harnessName, providerIconId, terminalOptions, type HarnessCatalogEntry } from "@/lib/harness/catalog";
import { harnessErrorText } from "@/lib/harness/errors";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { ProviderIcon } from "./ProviderIcon";
import { TerminalPanel, type TerminalConnectionStatus } from "./TerminalPanel";
import { TerminalStartupProgress } from "./TerminalStartupProgress";
import { SshAuthChallenge, useSshAuthChallenge } from "./SshAuthChallenge";
import { machineRequest } from "./RemoteHostsSettings";
import { needsSshSecret } from "@/lib/workspace-machine-errors";
import { ErrorDialog } from "./ErrorDialog";
import { saveAndOpenCardLog } from "@/lib/card-log";
import type { QueueCard } from "@/lib/card-queue";

export function HarnessCard({ card, active, inQueue = false, sshHost, sshHostName, children, onAction, onStartAll, extensionHarnesses = [] }: {
  card: QueueCard; active: boolean; inQueue?: boolean; sshHost?: string; sshHostName?: string; children?: ReactNode;
  onAction: (action: string, data: Record<string, unknown>) => Promise<boolean>;
  onStartAll?: () => Promise<void>;
  extensionHarnesses?: HarnessCatalogEntry[];
}) {
  const { t } = useI18n();
  const labels = { not_running:t("harness.processNotStarted"), starting:t("harness.starting"), working:t("harness.working"), attention:t("harness.waiting"), unknown:t("harness.unknown"), exited:t("harness.processNotStarted"), error:t("harness.disconnected") };
  const [target, setTarget] = useState<Element | null>(null);
  const [toolsTarget, setToolsTarget] = useState<Element | null>(null);
  const [switchPosition, setSwitchPosition] = useState<{ left: number; top: number } | null>(null);
  const [mode] = useState<"cli">("cli");
  const [busy, setBusy] = useState(false);
  const [startingKind, setStartingKind] = useState<string | null>(null);
  const [useTmux, setUseTmux] = useState(true);
  const [actionError, setActionError] = useState<unknown>(null);
  const auth = useSshAuthChallenge();
  const [pendingAction, setPendingAction] = useState<{ action: string; data: Record<string, unknown> } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<unknown>(null);
  const [terminalStatus, setTerminalStatus] = useState<TerminalConnectionStatus>("connecting");
  const [connection, setConnection] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [logBusy, setLogBusy] = useState(false);
  const [nickname, setNickname] = useState(card.nickname ?? "");
  const harness = card.harness;
  const [canBackground, setCanBackground] = useState(false);
  const shellTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shellProbe = useRef<ReturnType<typeof createShellProbe> | null>(null);
  if (!shellProbe.current) shellProbe.current = createShellProbe(running => {
    clearTimeout(shellTimer.current);
    setCanBackground(false);
    if (running) shellTimer.current = setTimeout(() => setCanBackground(true), 300);
  });
  useEffect(() => {
    if (harness?.kind !== "shell" || harness.shellCommandNotifications === false) return;
    clearTimeout(shellTimer.current);
    setCanBackground(false);
    if (harness.shellCommandRunning) shellTimer.current = setTimeout(() => setCanBackground(true), Math.max(0, 300 - (Date.now() - (harness.shellCommandStartedAt ?? Date.now()))));
    return () => clearTimeout(shellTimer.current);
  }, [harness?.kind, harness?.shellCommandNotifications, harness?.shellCommandStartedAt, harness?.shellCommandRunning]);
  const ended = !!harness && (["exited", "error", "not_running"].includes(harness.state) || terminalStatus === "exited");
  // A momentary "connecting" (deck re-focus, side-terminal tab switch) must not
  // flash the recovery overlay; only a connection that stays down for a while
  // counts as disconnected.
  const [connectingSlow, setConnectingSlow] = useState(false);
  useEffect(() => {
    if (terminalStatus !== "connecting") { setConnectingSlow(false); return; }
    const timer = setTimeout(() => setConnectingSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [terminalStatus]);
  const disconnected = !!harness && (ended || terminalStatus === "error" || connectingSlow);
  useEffect(() => { setShowTranscript(false); }, [disconnected, harness?.terminalId]);
  useEffect(() => { setNickname(card.nickname ?? ""); }, [card.nickname]);
  const fresh = !card.session && !harness;
  const probeDetail = harness?.kind === "shell" ? (harness.shellCommandNotifications === false ? t("harness.plainShell") : t("harness.shellHint"))
    : harness?.probe === "title-only" ? t("harness.titleProbe")
    : harness?.probe === "unconfirmed" ? t("harness.noSignal")
    : t("harness.hookSeen");

  useLayoutEffect(() => {
    const sync = () => {
      const cardEl = document.querySelector(`[data-card-id="${card.id}"]`);
      setTarget(cardEl?.querySelector(".cq-title-harness") ?? null);
      setToolsTarget(cardEl?.querySelector(".cq-title-logs") ?? null);
      if (!fresh || !active || !cardEl) { setSwitchPosition(null); return; }
      const rect = cardEl.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) { setSwitchPosition(null); return; }
      setSwitchPosition({
        left: Math.max(8, Math.round(rect.left - 78)),
        top: Math.round(rect.top + Math.min(168, Math.max(96, rect.height * 0.22))),
      });
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    const cardEl = document.querySelector(`[data-card-id="${card.id}"]`);
    const observer = typeof ResizeObserver !== "undefined" && cardEl ? new ResizeObserver(sync) : null;
    if (cardEl && observer) observer.observe(cardEl);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      observer?.disconnect();
    };
  }, [card.id, fresh, active, mode, harness?.state]);

  const act = async (action: string, data: Record<string, unknown> = {}) => {
    setBusy(true);
    setActionError(null);
    try { return await onAction(action, { id: card.id, ...data }); }
    catch (error) {
      // The SSH layer is asking for a secret, not failing: put up the auth
      // dialog, remember what the user was trying to do, and replay it once
      // the connection is in. Everything else stays a plain message.
      if (sshHost && needsSshSecret(error)) { setPendingAction({ action, data }); setAuthError(null); auth.present(error); }
      else setActionError(error);
      return false;
    }
    finally { setBusy(false); }
  };

  const startHarness = async (kind: string) => {
    setStartingKind(kind);
    try {
      if (!await act("card_nickname", { nickname: nickname.trim() })) return;
      await act("harness_start", { kind, tmux: Boolean(sshHost) && useTmux });
    } finally {
      setStartingKind(null);
    }
  };

  const retryWithSecret = async (secret?: string, trustedPrompt?: string) => {
    if (!pendingAction || !sshHost) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      await machineRequest({ action: "connect", host: sshHost, ...(trustedPrompt !== undefined ? { trustedPrompt } : {}), ...(secret !== undefined ? { password: secret } : {}) });
      auth.clear();
      const pending = pendingAction;
      setPendingAction(null);
      await act(pending.action, pending.data);
    }
    catch (error) {
      if (!auth.present(error)) setAuthError(error);
    }
    finally { setAuthBusy(false); }
  };

  const showBackground = !!harness && harness.kind === "shell" && harness.shellCommandNotifications !== false && canBackground && !harness.shellNotify && !["error", "exited", "not_running"].includes(harness.state);
  const showState = !!harness && !disconnected && harness.state !== "attention";
  const controls = fresh || !harness || (!showBackground && !showState) ? null : <div className="cq-harness-controls">
    {showBackground && <button type="button" disabled={busy} onClick={() => void act("shell_background")} title={t("harness.backgroundHint")}>↓ {t("harness.background")}</button>}
    {showState && <span className="cq-harness-state" data-state={harness.state} title={probeDetail}>{labels[harness.state]}</span>}
  </div>;
  const logsButton = fresh || !harness ? null : <button type="button" className="cq-tools-trigger" disabled={busy || logBusy} onClick={() => void (async () => {
    setLogBusy(true);
    setActionError(null);
    try { await saveAndOpenCardLog(card.id, harness.terminalId); }
    catch (error) { setActionError(error instanceof Error ? error : t("harness.logsFailed")); }
    finally { setLogBusy(false); }
  })()} aria-label={t("harness.logsHint")} title={t("harness.logsHint")}>
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" /></svg>
    <span>{logBusy ? t("harness.logsSaving") : t("harness.logs")}</span>
  </button>;
  const terminal = harness ? <TerminalPanel key={`${harness.terminalId}:${connection}`} cardId={card.id} embedded remote={harness.remote} {...terminalOptions(harness.kind)} readOnly={card.archivedAt !== undefined || harness.state === "exited" || harness.state === "error" || harness.state === "not_running"} tab={{ id: harness.terminalId, cwd: card.cwd, restored: true }} active={active} inQueue={inQueue}
    harnessKind={harness.kind} harnessName={harnessName(harness.kind)} reconnectVersion={connection} isStarting={harness.state === "starting" || connection > 0}
    onOutput={harness.kind === "shell" && harness.shellCommandNotifications !== false ? data => shellProbe.current?.(data) : undefined} onStatusChange={setTerminalStatus} onRestart={() => void act(harness.providerSessionId ? "harness_resume" : "harness_reopen", { tmux: harness.tmux ?? (Boolean(sshHost) && useTmux) })} onClosed={() => {}} onCloseError={() => {}} /> : null;

  return <>
    {actionError ? <ErrorDialog message={harnessErrorText(actionError, t)} onDismiss={() => setActionError(null)} /> : null}
    {sshHost && <SshAuthChallenge challenge={auth.challenge} hostName={sshHostName || sshHost} busy={authBusy} error={authError} onCancel={() => { auth.clear(); setPendingAction(null); setAuthError(null); }} onRetry={(password, trustedPrompt) => void retryWithSecret(password, trustedPrompt)} />}
    {fresh ? active && switchPosition && createPortal(<div className="cq-harness-floating" style={switchPosition}>{controls}</div>, document.body) : <>
      {target && controls && createPortal(controls, target)}
      {toolsTarget && logsButton && createPortal(logsButton, toolsTarget)}
    </>}
    {harness ? <div className="cq-harness-body" data-harness={harness.kind} data-disconnected={disconnected && !showTranscript ? "true" : undefined}>
      {disconnected && !showTranscript && <div className="cq-terminal-recovery" role="status">
        <div className="cq-terminal-recovery-content">
          <span className="cq-terminal-recovery-badge" aria-hidden="true">
            {harness.kind === "shell"
              ? <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>
              : <ProviderIcon id={providerIconId(harness.kind)} size={32} />}
          </span>
          <h3>{ended ? t("harness.processNotStarted", { name: harnessName(harness.kind) }) : terminalStatus === "connecting" ? t("harness.connecting") : t("harness.disconnected")}</h3>
          {!ended && <p>{t("harness.reconnectHint")}</p>}
          {actionError ? <p role="alert">{harnessErrorText(actionError, t)}</p> : null}
          <div className="cq-terminal-recovery-actions">
            <button type="button" className="cq-terminal-recovery-primary" disabled={busy} onClick={() => {
              if (ended) void act(harness.providerSessionId ? "harness_resume" : "harness_reopen", { tmux: harness.tmux ?? (Boolean(sshHost) && useTmux) });
              else { setTerminalStatus("connecting"); setConnection(key => key + 1); }
            }}>{busy ? t("harness.opening") : ended ? harness.providerSessionId ? t("harness.resume") : t("harness.startProcess") : t("harness.reconnect")}</button>
            {ended && onStartAll && <button type="button" className="cq-terminal-recovery-all" disabled={busy} onClick={() => void (async () => {
              setBusy(true);
              setActionError(null);
              try { await onStartAll(); }
              catch (error) { setActionError(error); }
              finally { setBusy(false); }
            })()}>{t("harness.startAllProcesses")}</button>}
          </div>
        </div>
        <button type="button" className="cq-terminal-recovery-view" onClick={() => setShowTranscript(true)}>{t("harness.viewOutput")}</button>
      </div>}
      {disconnected && showTranscript && <button type="button" className="cq-terminal-recovery-return" onClick={() => setShowTranscript(false)}>{t("harness.backToConnection")}</button>}
      {terminal}
    </div> : (busy && startingKind) ? <div className="cq-harness-body" data-harness={startingKind}>
      <TerminalStartupProgress
        stage="preparing"
        remote={Boolean(sshHost)}
        sshHost={sshHost}
        harnessKind={startingKind}
        harnessName={harnessName(startingKind)}
      />
    </div> : mode === "cli" ? <div className="cq-harness-empty"><div className="cq-harness-picker">
      <div className="cq-harness-picker-head">
        <div>
          <h3>{t("harness.choose")}</h3>
          <p>{t("harness.chooseHint")}</p>
        </div>
        <button type="button" className="cq-harness-option cq-harness-shell-entry" disabled={busy} onClick={() => {
          void startHarness("shell");
        }}>
          <span className="cq-harness-option-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></svg></span>
          <span><strong>{t("harness.openShell")}</strong><small>{t("harness.shellDescription")}</small></span><span className="cq-harness-option-arrow" aria-hidden="true">↗</span>
        </button>
      </div>
      <label className="cq-harness-nickname">
        <span>{t("harness.nicknameOptional")}</span>
        <input
          autoComplete="off"
          autoCorrect="off"
          maxLength={48}
          value={nickname}
          placeholder={t("harness.nicknamePlaceholder")}
          onChange={event => setNickname(event.target.value)}
        />
      </label>
      {Boolean(sshHost) && (
        <div style={{ margin: "8px 0 12px", display: "flex", alignItems: "center" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "12.5px", cursor: "pointer", opacity: 0.9, userSelect: "none" }}>
            <input
              type="checkbox"
              checked={useTmux}
              onChange={e => setUseTmux(e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            <span>{t("harness.tmuxKeepAlive") || "启用 tmux 会话保活（远程断线/重启不中断）"}</span>
          </label>
        </div>
      )}
      <div className="cq-harness-options">
      {[...harnessPicker, ...extensionHarnesses].map(item => <button key={item.id} type="button" className="cq-harness-option" disabled={busy} onClick={() => {
        void startHarness(item.id);
      }}>
        <span className="cq-harness-option-icon" aria-hidden="true"><ProviderIcon id={providerIconId(item.id)} size={28} /></span>
        <span className="cq-harness-option-copy"><span className="cq-harness-option-title"><strong>{item.name}</strong>{item.extension && <span className="cq-extension-badge">{t("harness.extensionBadge")}</span>}</span><small>{busy ? t("harness.checking") : item.description}</small></span><span className="cq-harness-option-arrow" aria-hidden="true">↗</span>
      </button>)}
      </div>
    </div></div> : children}
  </>;
}
