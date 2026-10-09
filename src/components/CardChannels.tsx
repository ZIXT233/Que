"use client";
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";
import type { QueueCard } from "@/lib/card-queue";
import { ComposerPanel } from "./chat/ComposerPanel";
import { ChatIcon } from "./chat/Icons";
import { Icon } from "./QueueIcon";
import "./chat/composer.css";

const isButler = (card: QueueCard) => card.workspaceId === "queacp-butler";

/** The cards this card may talk to. Each is a switch: joined or not. */
export function CardChannels({ card, cards, channels, nameOf }: {
  card: QueueCard; cards: QueueCard[]; channels: [string, string][]; nameOf: (card: QueueCard) => string;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!card.harness || isButler(card)) return null;
  const others = cards.filter(c => c.id !== card.id && c.harness && c.archivedAt === undefined && !isButler(c));
  const joined = (other: string) => channels.some(([a, b]) => (a === card.id && b === other) || (b === card.id && a === other));
  const count = others.filter(c => joined(c.id)).length;
  const toggle = async (other: string) => {
    setBusy(other); setError("");
    try { await invoke("channel_set", { a: card.id, b: other, joined: !joined(other) }); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(""); }
  };
  return <>
    <button ref={anchor} type="button" className="cq-channels-toggle" data-joined={count > 0 || undefined}
      aria-haspopup="dialog" aria-expanded={open} title={t("channel.panelTitle")} onClick={() => setOpen(v => !v)}>
      <Icon name="link" size={13} /><span>{count}</span>
    </button>
    {open && anchor.current && <ComposerPanel anchor={anchor.current} align="start" title={t("channel.panelTitle")} updating={!!busy}
      onClose={focus => { setOpen(false); if (focus) anchor.current?.focus(); }}>
      <div className="fc-panel-heading">{t("channel.panelTitle")}</div>
      <p className="fc-host-hint">{t("channel.panelHint")}</p>
      {others.length ? <div className="fc-option-list" role="group" aria-label={t("channel.panelTitle")}>
        {others.map(other => <button key={other.id} type="button" role="menuitemcheckbox" aria-checked={joined(other.id)}
          disabled={!!busy} onClick={() => void toggle(other.id)}>
          <span className="cq-channel-name">{nameOf(other)}</span>{joined(other.id) && <ChatIcon name="check" />}
        </button>)}
      </div> : <p className="fc-host-hint">{t("channel.none")}</p>}
      {error && <p className="fc-host-hint" role="alert">{error}</p>}
    </ComposerPanel>}
  </>;
}
