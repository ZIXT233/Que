"use client";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";
import type { QueueCard } from "@/lib/card-queue";

const isButler = (card: QueueCard) => card.workspaceId === "queacp-butler";

/** The cards this card may talk to, joined and parted by the user. */
export function CardChannels({ card, cards, channels, nameOf }: {
  card: QueueCard; cards: QueueCard[]; channels: [string, string][]; nameOf: (card: QueueCard) => string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  if (!card.harness || isButler(card)) return null;
  const others = cards.filter(c => c.id !== card.id && c.harness && c.archivedAt === undefined && !isButler(c));
  const joined = others.filter(c => channels.some(([a, b]) => (a === card.id && b === c.id) || (b === card.id && a === c.id)));
  const free = others.filter(c => !joined.includes(c));
  const set = async (other: string, value: boolean) => {
    setError("");
    try { await invoke("channel_set", { a: card.id, b: other, joined: value }); }
    catch (cause) { setError(String(cause)); }
  };
  return <div className="cq-channels">
    <button type="button" className="cq-channels-toggle" aria-expanded={open} title={t("channel.panelTitle")} onClick={() => setOpen(v => !v)}>⇄ {joined.length}</button>
    {open && <div className="cq-channels-panel" role="dialog" aria-label={t("channel.panelTitle")}>
      <strong>{t("channel.panelTitle")}</strong>
      <p>{t("channel.panelHint")}</p>
      {joined.length ? <ul>{joined.map(c => <li key={c.id}><span>{nameOf(c)}</span><button type="button" onClick={() => void set(c.id, false)}>{t("channel.disconnect")}</button></li>)}</ul>
        : <p className="cq-channels-empty">{t("channel.none")}</p>}
      {free.length > 0 && <select value="" aria-label={t("channel.connect")} onChange={event => { if (event.target.value) void set(event.target.value, true); }}>
        <option value="">{t("channel.connect")}</option>
        {free.map(c => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
      </select>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
