"use client";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { announceQueueToast } from "@/lib/queue-toast";
import { useI18n } from "@/hooks/useI18n";

type Request = { id: string; source: string; sourceCardId?: string; target: string; cardId: string; tool: string; nickname?: string; text?: string; key?: string; submit: boolean; expiresAt: number };
export function McpApprovals() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [allCards, setAllCards] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const active = requests[0];
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const values = await invoke<Request[]>("mcp_pending"); if (!gone) setRequests(values); }
      catch { /* Native UI unavailable: input remains unapproved and expires. */ }
      if (!gone) timer = setTimeout(refresh, 750);
    };
    void refresh();
    return () => { gone = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    setError("");
    setAllCards(false);
    if (active) dialog.current?.showModal(); else dialog.current?.close();
  }, [active?.id]);
  const decide = async (approve: boolean) => {
    if (!active || busy) return;
    const id = active.id;
    setBusy(true); setError("");
    try {
      const result = await invoke<{ error?: string }>("mcp_decide", { id, approve, allCards: approve && allCards });
      setRequests(current => current.filter(r => r.id !== id));
      if (result.error) announceQueueToast(result.error);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="cq-urgent-dialog cq-mcp-approval" role="alertdialog" aria-labelledby="cq-mcp-approval-title"
    onCancel={event => { event.preventDefault(); if (!busy) void decide(false); }} onKeyDown={event => event.stopPropagation()}>
    {active && <>
      <div className="cq-urgent-heading"><strong id="cq-mcp-approval-title">{t("mcp.approvalTitle")}</strong></div>
      <p>{t(allCards && active.sourceCardId ? "mcp.allCardsHint" : active.tool === "start_card" ? "mcp.startHint" : "mcp.approvalHint")}</p>
      <dl>
        <div><dt>{t("mcp.source")}</dt><dd>{active.source === "External MCP client" ? t("mcp.external") : active.source}{active.sourceCardId && <small style={{ display: "block" }}>{active.sourceCardId}</small>}</dd></div>
        <div><dt>{t("mcp.target")}</dt><dd>{active.target}<small style={{ display: "block" }}>{active.cardId}</small></dd></div>
      </dl>
      {active.tool === "set_card_nickname" && <p>{t("mcp.nicknameChange", { nickname: active.nickname || t("mcp.clearNickname") })}</p>}
      {active.sourceCardId && <label className="cq-mcp-all-cards"><input type="checkbox" checked={allCards} disabled={busy} onChange={event => setAllCards(event.target.checked)} />{t("mcp.allCards")}</label>}
      {error && <p role="alert">{error}</p>}
      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
        <button type="button" autoFocus disabled={busy} onClick={() => void decide(false)}>{t("mcp.deny")}</button>
        <button type="button" disabled={busy} onClick={() => void decide(true)}>{t("mcp.allowRun")}</button>
      </div>
    </>}
  </dialog>;
}
