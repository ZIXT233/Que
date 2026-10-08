import { memo, useMemo } from "react";
import { cardRecap, clip, timeAgo, type RecapTurn } from "@/lib/card-recap";

/** One line at the top of a returning card; expands into the full recap. */
export const CardRecap = memo(function CardRecap({ turns }: { turns: RecapTurn[] }) {
  const recap = useMemo(() => cardRecap(turns), [turns]);
  if (!recap) return null;
  const when = timeAgo(recap.lastAskAt);
  const since = recap.since.map(s => `${s.name} ${s.count} 条`).join("、");
  return (
    <details className="cq-acp-recap">
      <summary>
        <span className="cq-acp-recap-label">上次你说</span>
        <span className="cq-acp-recap-text">{clip(recap.lastAsk, 80)}</span>
        {(when || since) && <span className="cq-acp-recap-meta">{[when, since && `之后：${since}`].filter(Boolean).join(" · ")}</span>}
      </summary>
      <dl>
        {recap.goal && <><dt>任务起点</dt><dd>{recap.goal}</dd></>}
        <dt>你上次说</dt><dd>{recap.lastAsk}</dd>
        {recap.lastReply && <><dt>最后回复</dt><dd>{recap.lastReply}</dd></>}
        {recap.peers.length > 0 && <><dt>往来卡片</dt><dd>{recap.peers.join("、")}</dd></>}
      </dl>
    </details>
  );
});
