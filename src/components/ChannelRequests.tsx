"use client";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";

type Peer = { cardId: string; name: string };
type Request = { from: Peer; to: Peer; preview: string; count: number };

/** An Agent messaged a card it has no channel with; the message waits for this answer. */
export function ChannelRequests() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const active = requests[0];
  const key = active ? `${active.from.cardId}>${active.to.cardId}` : "";
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const values = await invoke<Request[]>("channel_requests"); if (!gone) setRequests(values); }
      catch { /* Without the native window nothing can be allowed; messages keep waiting. */ }
      if (!gone) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => { gone = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    setError("");
    if (active) dialog.current?.showModal(); else dialog.current?.close();
  }, [key]);
  const decide = async (allow: boolean) => {
    if (!active || busy) return;
    setBusy(true); setError("");
    try {
      await invoke("channel_decide", { from: active.from.cardId, to: active.to.cardId, allow });
      setRequests(current => current.filter(r => `${r.from.cardId}>${r.to.cardId}` !== key));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="cq-urgent-dialog cq-channel-request" role="alertdialog" aria-labelledby="cq-channel-request-title"
    onCancel={event => { event.preventDefault(); if (!busy) void decide(false); }} onKeyDown={event => event.stopPropagation()}>
    {active && <>
      <div className="cq-urgent-heading"><strong id="cq-channel-request-title">{t("channel.requestTitle")}</strong></div>
      <p>{t("channel.requestHint", { from: active.from.name, to: active.to.name })}</p>
      <blockquote>{active.preview}{active.count > 1 && <small>{t("channel.more", { count: active.count - 1 })}</small>}</blockquote>
      {error && <p role="alert">{error}</p>}
      <div className="cq-channel-actions">
        <button type="button" autoFocus disabled={busy} onClick={() => void decide(false)}>{t("channel.deny")}</button>
        <button type="button" disabled={busy} onClick={() => void decide(true)}>{t("channel.allow")}</button>
      </div>
    </>}
  </dialog>;
}
