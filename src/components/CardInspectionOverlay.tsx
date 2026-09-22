"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";

/** The backdrop belongs beside the whole layout, so it samples sidebar and deck. */
export function CardInspectionOverlay({ anchor, children, onClose, onSettled, transferId, leaving }: {
  anchor: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  onClose: () => void;
  onSettled: () => void;
  transferId?: string;
  leaving?: "deck" | "sidebar" | null;
}) {
  const { t } = useI18n();
  const [bounds, setBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const leaveStarted = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useLayoutEffect(() => {
    const stage = anchor.current;
    if (!stage) return;
    const measure = () => {
      if (leaveStarted.current) return;
      const rect = stage.getBoundingClientRect();
      const top = window.matchMedia("(max-width: 700px)").matches ? 15 : 24;
      setBounds({ left: rect.left, top: rect.top + top, width: rect.width, height: Math.max(0, rect.height - top - 60) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [anchor]);
  // Leaving keeps the real card (terminal included) visible while it morphs
  // onto the destination — the deck layer it is landing on, or its Working
  // button when the overlay closes with the card still running.
  useEffect(() => {
    if (!leaving) { leaveStarted.current = false; return; }
    if (leaveStarted.current) return;
    leaveStarted.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onSettledRef.current(); return; }
    const root = anchor.current?.closest(".cq-transfer-root");
    const destination = leaving === "deck"
      ? anchor.current?.querySelector<HTMLElement>('.cq-deck-layer[aria-hidden="false"]')?.getBoundingClientRect()
      : root?.querySelector<HTMLElement>(`[data-transfer-id="${CSS.escape(transferId ?? "")}"][data-transfer-zone="sidebar"]`)?.getBoundingClientRect();
    if (!destination || !destination.width || !destination.height) { onSettledRef.current(); return; }
    const card = cardRef.current;
    if (!card) { onSettledRef.current(); return; }
    const source = card.getBoundingClientRect();
    if (!source.width || !source.height) { onSettledRef.current(); return; }
    // Animate the surface without resizing the live terminal on every frame.
    const motion = card.animate([
      { transform: "none", transformOrigin: "top left" },
      { transform: `translate(${destination.left - source.left}px, ${destination.top - source.top}px) scale(${destination.width / source.width}, ${destination.height / source.height})`, transformOrigin: "top left" },
    ], { duration: 340, easing: "cubic-bezier(.22,.8,.25,1)", fill: "forwards" });
    const timer = setTimeout(() => onSettledRef.current(), 360);
    return () => { motion.cancel(); clearTimeout(timer); };
  }, [leaving, anchor, transferId]);
  return (
    <div className={`cq-inspection-overlay${leaving ? " cq-leaving" : ""}`}>
      <button type="button" className="cq-inspection-backdrop" aria-label={t("queue.关闭")} onClick={onClose} />
      {bounds && <div ref={cardRef} className="cq-static-card cq-inspection-card" style={bounds} data-transfer-id={transferId} data-transfer-zone="inspection">{children}</div>}
    </div>
  );
}
