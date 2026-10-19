"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";
import { Icon } from "./QueueIcon";
import { harnessName } from "@/lib/harness/catalog";
import { subscribeLive } from "@/lib/live-events";

type Peer = { cardId: string; name: string };
type Request = { from: Peer; to: Peer; preview: string; count: number };
type Creation = { id: string; from: Peer; workspace: string; kind: string; nickname?: string | null };

/**
 * What Agents ask of the user, one at a time: a message to a card it has no
 * channel with, which waits for this answer, and a card it asks to create.
 */
export function ChannelRequests() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<Request[]>([]);
  const [creations, setCreations] = useState<Creation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = requests[0];
  const creation = active ? undefined : creations[0];
  const key = active ? `${active.from.cardId}>${active.to.cardId}` : creation ? `create:${creation.id}` : "";
  // Read again whenever Que says requests or cards changed, and on (re)connecting.
  useEffect(() => {
    let gone = false;
    let reading = 0;
    const refresh = async () => {
      const mine = ++reading;
      try {
        const [values, created] = await Promise.all([invoke<Request[]>("channel_requests"), invoke<Creation[]>("create_requests")]);
        if (!gone && mine === reading) { setRequests(values); setCreations(created); }
      }
      catch { /* Without the native window nothing can be allowed; requests keep waiting. */ }
    };
    void refresh();
    const stop = subscribeLive({ open: () => void refresh(), change: reason => { if (reason === "channels" || reason === "queue") void refresh(); } });
    return () => { gone = true; stop(); };
  }, []);
  useEffect(() => setError(""), [key]);
  const decide = async (allow: boolean) => {
    if ((!active && !creation) || busy) return;
    setBusy(true); setError("");
    try {
      if (active) {
        await invoke("channel_decide", { from: active.from.cardId, to: active.to.cardId, allow });
        setRequests(current => current.filter(r => `${r.from.cardId}>${r.to.cardId}` !== key));
      } else if (creation) {
        await invoke("create_decide", { id: creation.id, allow });
        setCreations(current => current.filter(r => r.id !== creation.id));
      }
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  if (creation) return <div className="cq-overlay">
    <section className="cq-dialog cq-channel-request" role="alertdialog" aria-modal="true" aria-labelledby="cq-create-request-title"
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) void decide(false); }}>
      <div className="cq-dialog-heading"><Icon name="plus" /></div>
      <h2 id="cq-create-request-title">{t("create.requestTitle")}</h2>
      <p>{t("create.requestHint", { from: creation.from.name, workspace: creation.workspace, agent: harnessName(creation.kind) })}</p>
      {creation.nickname && <p>{t("create.nickname", { nickname: creation.nickname })}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="cq-confirm-actions">
        <button type="button" disabled={busy} onClick={() => void decide(false)}>{t("create.deny")}</button>
        <button type="button" className="cq-primary" autoFocus disabled={busy} onClick={() => void decide(true)}>{t("create.allow")}</button>
      </div>
    </section>
  </div>;
  if (!active) return null;
  return <div className="cq-overlay">
    <section className="cq-dialog cq-channel-request" role="alertdialog" aria-modal="true" aria-labelledby="cq-channel-request-title"
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !busy) void decide(false); }}>
      <div className="cq-dialog-heading"><Icon name="link" /></div>
      <h2 id="cq-channel-request-title">{t("channel.requestTitle")}</h2>
      <p>{t("channel.requestHint", { from: active.from.name, to: active.to.name })}</p>
      <blockquote className="cq-channel-preview">{active.preview}{active.count > 1 && <small>{t("channel.more", { count: active.count - 1 })}</small>}</blockquote>
      {error && <p role="alert">{error}</p>}
      <div className="cq-confirm-actions">
        <button type="button" disabled={busy} onClick={() => void decide(false)}>{t("channel.deny")}</button>
        <button type="button" className="cq-primary" autoFocus disabled={busy} onClick={() => void decide(true)}>{t("channel.allow")}</button>
      </div>
    </section>
  </div>;
}
