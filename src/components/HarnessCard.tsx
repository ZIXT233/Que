"use client";
import { useEffect, useState, type ReactNode } from "react";
import { harnessName, providerIconId, type HarnessCatalogEntry } from "@/lib/harness/catalog";
import { ProviderIcon } from "./ProviderIcon";
import { SshAuthChallenge, useSshAuthChallenge } from "./SshAuthChallenge";
import { machineRequest } from "./RemoteHostsSettings";
import { needsSshSecret } from "@/lib/workspace-machine-errors";
import { ErrorDialog } from "./ErrorDialog";
import { useI18n } from "@/hooks/useI18n";
import { AcpStartup, type StartLogEntry } from "./AcpStartup";
import { AcpConversation } from "./AcpConversation";
import type { QueueCard } from "@/lib/card-queue";

export function HarnessCard({ card, active, sshHost, sshHostName, onAction }: {
  card: QueueCard; active: boolean; inQueue?: boolean; sshHost?: string; sshHostName?: string; children?: ReactNode;
  onAction: (action: string, data: Record<string, unknown>) => Promise<boolean>;
  onStartAll?: () => Promise<void>; startingAll?: boolean; extensionHarnesses?: HarnessCatalogEntry[];
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<HarnessCatalogEntry[]>([]);
  const [nickname, setNickname] = useState(card.nickname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState("");
  const [stage, setStage] = useState("preparing");
  const [startLog, setStartLog] = useState<StartLogEntry[]>([]);
  const [retry, setRetry] = useState(0);
  const auth = useSshAuthChallenge();
  useEffect(() => {
    if (!active || card.harness) return;
    const abort = new AbortController();
    fetch(`/api/acp-catalog?card=${encodeURIComponent(card.id)}`, { signal: abort.signal }).then(async r => {
      const data = await r.json();
      if (!r.ok) throw Object.assign(new Error(data.error), data);
      setCatalog(data);
    }).catch(e => { if (!abort.signal.aborted) { if (sshHost && needsSshSecret(e)) auth.present(e); else setError(e); } });
    return () => abort.abort();
  }, [active, card.id, !!card.harness, retry]);
  useEffect(() => {
    if (!busy || !starting) return;
    let gone = false;
    const timer = setInterval(() => { void fetch(`/api/acp/${encodeURIComponent(card.id)}`).then(r => r.ok ? r.json() : null).then(s => { if (gone) return; if (s?.stage) setStage(s.stage); if (Array.isArray(s?.startLog)) setStartLog(s.startLog); }).catch(() => {}); }, 650);
    return () => { gone = true; clearInterval(timer); };
  }, [busy, starting, card.id]);
  const start = async (kind: string) => {
    setBusy(true); setStarting(kind); setStage("preparing"); setStartLog([]); setError(null);
    try {
      if (card.archivedAt !== undefined && !await onAction("restore", { id: card.id })) return;
      if (!await onAction("card_nickname", { id: card.id, nickname: nickname.trim() })) return;
      await onAction(card.harness ? "harness_resume" : "harness_start", { id: card.id, kind });
    } catch (e) { if (sshHost && needsSshSecret(e)) auth.present(e); else setError(e); }
    finally { setBusy(false); setStarting(""); }
  };
  return <>
    {error ? <ErrorDialog message={error instanceof Error ? error.message : String(error)} onDismiss={() => setError(null)} /> : null}
    {sshHost && <SshAuthChallenge challenge={auth.challenge} hostName={sshHostName || sshHost} busy={busy} error={null} onCancel={auth.clear} onRetry={async (password, trustedPrompt) => {
      setBusy(true);
      try { await machineRequest({ action: "connect", host: sshHost, password, trustedPrompt }); auth.clear(); setRetry(v => v+1); }
      catch (e) { if (!auth.present(e)) setError(e); }
      finally { setBusy(false); }
    }} />}
    {card.harness ? <AcpConversation card={card} active={active} onResume={() => start(card.harness!.kind)} /> : busy ? <div className="cq-harness-empty"><AcpStartup agent={starting} stage={stage} log={startLog} /></div> : <div className="cq-harness-empty"><div className="cq-harness-picker">
      <div className="cq-harness-picker-head"><div>{card.workspaceId === "queacp-butler"
        ? <><h3>选择管家使用的 Agent</h3><p>之后点管家按钮会直接用它；这里列出的是这台机器上检测到的 Agent</p></>
        : <><h3>选择 Agent</h3><p>选择 Agent，在当前工作区开始会话</p></>}</div></div>
      <label className="cq-harness-nickname"><span>{t("harness.nicknameOptional")}</span><input autoComplete="off" maxLength={48} value={nickname} placeholder={t("harness.nicknamePlaceholder")} onChange={e => setNickname(e.target.value)} /></label>
    {[catalog.filter(item => item.available !== false), catalog.filter(item => item.available === false)].map((items, group) => items.length > 0 && <div key={group}>
      {group === 1 && <p className="cq-harness-missing-head">未检测到（需要先安装并登录对应的命令行工具）</p>}
      <div className="cq-harness-options" data-missing={group === 1 || undefined}>{items.map(item => <button key={item.id} type="button" className="cq-harness-option" onClick={() => void start(item.id)}>
        <span className="cq-harness-option-icon"><ProviderIcon id={providerIconId(item.id)} size={28} /></span>
        <span className="cq-harness-option-copy"><span className="cq-harness-option-title"><strong>{harnessName(item.id)}</strong></span><small>{item.available === false && item.missing ? `未找到 ${item.missing}` : item.description}</small></span><span className="cq-harness-option-arrow">↗</span>
      </button>)}</div>
    </div>)}
      {!catalog.length && <p role="status">正在读取这台机器的 Agent 列表… <button type="button" onClick={() => setRetry(v => v+1)}>重试</button></p>}
    </div></div>}
  </>;
}
