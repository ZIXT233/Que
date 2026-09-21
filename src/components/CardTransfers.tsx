"use client";

import { Component, createRef, type ReactNode } from "react";
import { shouldQuietRearQueueArrival, type AttentionMode } from "@/lib/attention-mode";
import { queueArrivalSide } from "@/lib/queue-arrival";

type Zone = "sidebar" | "deck" | "inspection";
type Props = {
  order: string[];
  locations: Record<string, Zone>;
  children: ReactNode;
  attentionMode?: AttentionMode;
  focusedId?: string | null;
};
type Snapshot = { flights: Flight[]; layout: { id: string; transform: string }[] };
type Flight = { id: string; zone: Zone; rect: DOMRect; image: HTMLElement };

/** Capture the source before React removes it; animate only the visual copy. */
export class CardTransfers extends Component<Props> {
  private root = createRef<HTMLDivElement>();
  private flights = new Map<string, () => void>();
  private layoutAnimations = new Set<Animation>();
  private stopLayout = () => { for (const animation of this.layoutAnimations) animation.cancel(); this.layoutAnimations.clear(); };

  componentDidMount() { this.root.current?.addEventListener("wheel", this.stopLayout, { capture: true, passive: true }); this.root.current?.addEventListener("cq-deck-drag-start", this.stopLayout); }

  private surface(id: string, zone: Zone) {
    return this.root.current?.querySelector<HTMLElement>(`[data-transfer-id="${CSS.escape(id)}"][data-transfer-zone="${zone}"]`);
  }

  private quietAttentionFlight(id: string, zone: Zone) {
    if (zone !== "deck") return false;
    const side = queueArrivalSide(this.props.order, this.props.focusedId, id);
    if (!side) return false;
    return shouldQuietRearQueueArrival(this.props.attentionMode ?? "daily", side, document.visibilityState);
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return { flights: [], layout: [] };
    const reordered = previous.order.length !== this.props.order.length || previous.order.some((id, index) => this.props.order[index] !== id);
    const moved = Object.entries(this.props.locations).some(([id, zone]) => previous.locations[id] && previous.locations[id] !== zone);
    if (!reordered && !moved) return { flights: [], layout: [] };
    const surfaces = new Map<string, HTMLElement>();
    this.root.current?.querySelectorAll<HTMLElement>("[data-transfer-id][data-transfer-zone]").forEach(element => {
      const key = `${element.dataset.transferZone}:${element.dataset.transferId}`;
      if (!surfaces.has(key) || element.closest(".cq-inspection-overlay")) surfaces.set(key, element);
    });
    const layout: Snapshot["layout"] = [];
    if (reordered) {
      for (const id of previous.order) {
        const source = surfaces.get(`deck:${id}`);
        if (source?.classList.contains("cq-deck-layer")) layout.push({ id, transform: getComputedStyle(source).transform });
      }
      this.stopLayout();
    }
    const snapshots: Flight[] = [];
    for (const [id, zone] of Object.entries(this.props.locations)) {
      if (!previous.locations[id] || previous.locations[id] === zone) continue;
      // Inspection keeps the real card on screen: leaving morphs it onto the
      // destination itself; keep-in-view takeovers cover the same stage area.
      if (previous.locations[id] === "inspection" || (zone === "inspection" && previous.locations[id] === "deck")) continue;
      if (this.quietAttentionFlight(id, zone)) continue;
      this.flights.get(id)?.();
      const source = surfaces.get(`${previous.locations[id]}:${id}`);
      if (!source) continue;
      const rect = source.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      // Carry the card silhouette and heading, not a potentially huge chat DOM.
      const image = document.createElement("div");
      const heading = source.querySelector(".cq-card-header") ?? source.querySelector("strong");
      image.className = heading?.classList.contains("cq-card-header") ? "cq-large-card" : "cq-small-card";
      if (heading) image.append(heading.cloneNode(true));
      image.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      snapshots.push({ id, zone, rect, image });
    }
    return { flights: snapshots, layout };
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot) {
    for (const { id, transform } of snapshot.layout) {
      const target = this.surface(id, "deck");
      if (!target || getComputedStyle(target).transform === transform) continue;
      const animation = target.animate([{ transform }, { transform: target.style.transform }], { duration: 320, easing: "cubic-bezier(.22,.8,.25,1)" });
      this.layoutAnimations.add(animation);
      void animation.finished.then(() => this.layoutAnimations.delete(animation), () => this.layoutAnimations.delete(animation));
    }
    for (const { id, zone, rect, image } of snapshot.flights) {
      const target = this.surface(id, zone);
      // A completion deep in the queue lands on the visible stack edge.
      const stage = this.root.current?.querySelector<HTMLElement>(".cq-stage");
      const destination = target?.getBoundingClientRect() ?? (zone === "deck" ? stage?.getBoundingClientRect() : undefined);
      if (!destination || !destination.width || !destination.height) continue;
      const panel = document.createElement("div");
      panel.className = "cq-transfer-flight";
      panel.setAttribute("aria-hidden", "true");
      panel.inert = true;
      Object.assign(panel.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      Object.assign(image.style, { position: "absolute", inset: "0", margin: "0", width: "100%", height: "100%", transform: "none", animation: "none", visibility: "visible" });
      panel.append(image);
      this.root.current?.append(panel);
      const shrinking = zone === "sidebar";
      const duration = shrinking ? 720 : 420;
      const dx = destination.left - rect.left;
      const dy = destination.top - rect.top;
      const sx = destination.width / rect.width;
      const sy = destination.height / rect.height;
      const middleScale = Math.max(sx, sy, 0.28);
      // Keep the card visible during travel; only dissolve once it reaches Working.
      const keyframes: Keyframe[] = shrinking ? [
        { offset: 0, transform: "translate3d(0,0,0) scale(1)", opacity: 1 },
        { offset: 0.35, transform: `translate3d(${dx * 0.28}px,${dy * 0.28 - 24}px,0) scale(${0.72})`, opacity: 1 },
        { offset: 0.78, transform: `translate3d(${dx * 0.88}px,${dy * 0.88}px,0) scale(${middleScale},${middleScale})`, opacity: 1 },
        { offset: 0.94, transform: `translate3d(${dx}px,${dy}px,0) scale(${sx},${sy})`, opacity: 1 },
        { offset: 1, transform: `translate3d(${dx}px,${dy}px,0) scale(${sx},${sy})`, opacity: 0 },
      ] : [
        { transform: "translate3d(0,0,0) scale(1,1)", opacity: 1 },
        { transform: `translate3d(${dx}px,${dy}px,0) scale(${sx},${sy})`, opacity: 0 },
      ];
      const motion = panel.animate(keyframes, { duration, easing: shrinking ? "cubic-bezier(.4,0,.2,1)" : "cubic-bezier(.22,.8,.25,1)", fill: "forwards" });
      const arrival = target?.animate(shrinking ? [
        { opacity: 0, transform: "scale(.94)" },
        { opacity: 1, transform: "scale(1.035)", offset: 0.7 },
        { opacity: 1, transform: "scale(1)" },
      ] : [{ opacity: 0 }, { opacity: 1 }], { duration: shrinking ? 220 : 260, delay: shrinking ? 600 : 160, fill: "backwards", easing: "ease-out" });
      let cleaned = false;
      const clean = () => {
        if (cleaned) return;
        cleaned = true;
        motion.cancel(); arrival?.cancel(); panel.remove();
        this.flights.delete(id);
      };
      this.flights.set(id, clean);
      void Promise.all([motion.finished, arrival?.finished]).then(clean, clean);
    }
  }

  componentWillUnmount() { this.stopLayout(); this.root.current?.removeEventListener("cq-deck-drag-start", this.stopLayout); this.root.current?.removeEventListener("wheel", this.stopLayout, true); for (const clean of this.flights.values()) clean(); }

  render() { return <div className="cq-transfer-root" ref={this.root}>{this.props.children}</div>; }
}
