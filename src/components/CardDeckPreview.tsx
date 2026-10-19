import { memo, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { QueueCard } from "@/lib/card-queue";
import { peekSessionSnapshot } from "@/lib/session-store";
import { tilePreview } from "@/lib/card-tile";
import { nicknameHue } from "@/lib/card-nickname";

/** A face for cards outside the mounted window, using data we already have.
 * It opens no stream and fetches no history while the deck is moving. */
export const CardDeckPreview = memo(function CardDeckPreview({ card, title, subtitle }: {
  card: QueueCard; title: string; subtitle: string;
}) {
  const { t } = useI18n();
  const preview = tilePreview(peekSessionSnapshot(card.id), card.harness?.replyPreview || "", 1200, 3);
  return <article className="cq-large-card cq-continuous-card cq-deck-preview" data-card-preview={card.id}>
    <div className="cq-card-header"><div className="cq-card-identity">
      <div className="cq-card-heading"><div className="cq-card-title-split">
        <h2 title={title}>{title}</h2>
        {card.nickname && <span className="cq-card-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</span>}
      </div></div>
      <div className="cq-card-title-row"><div className="cq-title-primary"><span className="cq-title-environment"><b>{subtitle}</b></span></div></div>
    </div></div>
    <div className="cq-deck-preview-content">
      {preview.ask && <p className="cq-deck-preview-ask">{preview.ask.text}</p>}
      {preview.items.map((item, index) => <p key={index}>{item.text}</p>)}
      {preview.live && <p className="cq-deck-preview-status">{preview.live.text}</p>}
      {!preview.ask && !preview.items.length && !preview.live && <p className="cq-deck-preview-status">{t("acp.loading.history")}</p>}
    </div>
  </article>;
});
