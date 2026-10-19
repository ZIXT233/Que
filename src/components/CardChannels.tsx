"use client";
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "@/hooks/useI18n";
import type { CardPermissions, QueueCard } from "@/lib/card-queue";
import { ComposerPanel } from "./chat/ComposerPanel";
import { ChatIcon } from "./chat/Icons";
import { Icon } from "./QueueIcon";
import "./chat/composer.css";

const PERMISSIONS = [
  { key: "manageCards", label: "permission.manageCards", hint: "permission.manageCardsHint" },
  { key: "allChannels", label: "permission.allChannels", hint: "permission.allChannelsHint" },
  { key: "settings", label: "permission.settings", hint: "permission.settingsHint" },
] as const;

/**
 * What this card's Agent may do beyond its own session: the cards it may talk
 * to, each a switch, and the permissions the user gives it, all off by default.
 */
export function CardChannels({ card, cards, channels, nameOf }: {
  card: QueueCard; cards: QueueCard[]; channels: [string, string][]; nameOf: (card: QueueCard) => string;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!card.harness) return null;
  const permissions: CardPermissions = card.permissions ?? {};
  const everyone = (other: QueueCard) => !!(permissions.allChannels || other.permissions?.allChannels);
  const others = cards.filter(c => c.id !== card.id && c.harness && c.archivedAt === undefined);
  const joined = (other: QueueCard) => everyone(other) || channels.some(([a, b]) => (a === card.id && b === other.id) || (b === card.id && a === other.id));
  const count = others.filter(joined).length;
  const attempt = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError("");
    try { await action(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(""); }
  };
  const toggle = (other: QueueCard) => attempt(other.id, () => invoke("channel_set", { a: card.id, b: other.id, joined: !joined(other) }));
  const grant = (key: keyof CardPermissions) => attempt(key, () => invoke("card_permissions_set", { id: card.id, permissions: { ...permissions, [key]: !permissions[key] } }));
  const granted = PERMISSIONS.some(p => permissions[p.key]);
  return <>
    <button ref={anchor} type="button" className="cq-channels-toggle" data-joined={count > 0 || granted || undefined}
      aria-haspopup="dialog" aria-expanded={open} title={t("channel.panelTitle")} onClick={() => setOpen(v => !v)}>
      <Icon name="link" size={13} /><span>{count}</span>
    </button>
    {open && anchor.current && <ComposerPanel anchor={anchor.current} align="start" title={t("channel.panelTitle")} updating={!!busy}
      onClose={focus => { setOpen(false); if (focus) anchor.current?.focus(); }}>
      <div className="fc-panel-heading">{t("permission.title")}</div>
      <p className="fc-host-hint">{t("permission.hint")}</p>
      <div className="fc-option-list" role="group" aria-label={t("permission.title")}>
        {PERMISSIONS.map(p => <button key={p.key} type="button" role="menuitemcheckbox" aria-checked={!!permissions[p.key]}
          disabled={!!busy} title={t(p.hint)} onClick={() => void grant(p.key)}>
          <span className="cq-channel-name">{t(p.label)}<small>{t(p.hint)}</small></span>{permissions[p.key] && <ChatIcon name="check" />}
        </button>)}
      </div>
      <div className="fc-panel-heading">{t("channel.panelTitle")}</div>
      <p className="fc-host-hint">{permissions.allChannels ? t("channel.allJoined") : t("channel.panelHint")}</p>
      {others.length ? <div className="fc-option-list" role="group" aria-label={t("channel.panelTitle")}>
        {others.map(other => <button key={other.id} type="button" role="menuitemcheckbox" aria-checked={joined(other)}
          disabled={!!busy || everyone(other)} onClick={() => void toggle(other)}>
          <span className="cq-channel-name">{nameOf(other)}</span>{joined(other) && <ChatIcon name="check" />}
        </button>)}
      </div> : <p className="fc-host-hint">{t("channel.none")}</p>}
      {error && <p className="fc-host-hint" role="alert">{error}</p>}
    </ComposerPanel>}
  </>;
}
