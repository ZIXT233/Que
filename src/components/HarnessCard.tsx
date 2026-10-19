"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { HarnessCatalogEntry } from "@/lib/harness/catalog";
import { ErrorDialog } from "./ErrorDialog";
import { AgentPicker } from "./AgentPicker";
import { AcpStartup, type StartLogEntry } from "./AcpStartup";
import { AcpConversation } from "./AcpConversation";
import type { QueueCard } from "@/lib/card-queue";

/**
 * A card's session: its conversation once it has an agent. A card without one
 * is from before cards were made with their agent; it can still pick one here.
 */
export function HarnessCard({ card, active, sshHost, sshHostName, onAction }: {
  card: QueueCard; active: boolean; inQueue?: boolean; sshHost?: string; sshHostName?: string; children?: ReactNode;
  onAction: (action: string, data: Record<string, unknown>) => Promise<boolean>;
  onStartAll?: () => Promise<void>; startingAll?: boolean; extensionHarnesses?: HarnessCatalogEntry[];
}) {
  const [starting, setStarting] = useState("");
  const [stage, setStage] = useState("preparing");
  const [startLog, setStartLog] = useState<StartLogEntry[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!starting) return;
    let gone = false;
    const timer = setInterval(() => { void fetch(`/api/acp/${encodeURIComponent(card.id)}`).then(r => r.ok ? r.json() : null).then(s => { if (gone) return; if (s?.stage) setStage(s.stage); if (Array.isArray(s?.startLog)) setStartLog(s.startLog); }).catch(() => {}); }, 650);
    return () => { gone = true; clearInterval(timer); };
  }, [starting, card.id]);
  // Starting a card without an agent; a card that has one resumes it.
  const start = async (kind: string, nickname?: string) => {
    setStarting(kind); setStage("preparing"); setStartLog([]);
    try {
      if (card.archivedAt !== undefined && !await onAction("restore", { id: card.id })) return;
      if (nickname !== undefined && !await onAction("card_nickname", { id: card.id, nickname })) return;
      await onAction(card.harness ? "harness_resume" : "harness_start", { id: card.id, kind });
    } finally { setStarting(""); }
  };
  if (card.harness) return <>
    {error ? <ErrorDialog message={error instanceof Error ? error.message : String(error)} onDismiss={() => setError(null)} /> : null}
    <AcpConversation card={card} active={active} onResume={() => start(card.harness!.kind).catch(setError)} />
  </>;
  if (starting) return <div className="cq-harness-empty"><AcpStartup agent={starting} stage={stage} log={startLog} /></div>;
  if (!active) return <div className="cq-harness-empty" />;
  return <AgentPicker catalog={`?card=${encodeURIComponent(card.id)}`} butler={card.workspaceId === "queacp-butler"} initialNickname={card.nickname ?? ""}
    sshHost={sshHost} sshHostName={sshHostName} onPick={start} />;
}
