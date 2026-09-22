"use client";

import { cloneElement, createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

type View = ReactElement<{ active: boolean; onClosed?: () => void }>;
type Slot = { container: HTMLDivElement; view: View };
type Entry = { host: HTMLDivElement; slots: Slot[]; view: View };

// Ownership belongs to the page, not to a deck/inspection slot. React always
// portals into the same host for an id; only that host's DOM parent changes.
class TerminalViews {
  entries = new Map<string, Entry>();
  parking: HTMLDivElement | null = null;
  private revision = 0;
  private evictionQueued = false;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private publish() { this.revision++; this.listeners.forEach(listener => listener()); }

  private bind(entry: Entry) {
    // An inspection slot wins over an underlying deck preview.
    const slot = [...entry.slots].reverse().find(item => item.container.closest(".cq-inspection-overlay"))
      ?? entry.slots[entry.slots.length - 1];
    if (slot) {
      if (entry.host.parentElement !== slot.container) slot.container.appendChild(entry.host);
      entry.view = slot.view;
    } else {
      this.parking?.appendChild(entry.host);
      entry.view = cloneElement(entry.view, { active: false });
    }
    // Bound retained screens. Visible terminals are never evicted; ordinary
    // queue/inspection moves keep their component, buffer and host intact.
    if (!this.evictionQueued) {
      this.evictionQueued = true;
      // Wait until all slots in this commit have registered: a transfer is not
      // an idle terminal even if its old slot cleans up before the new slot.
      queueMicrotask(() => {
        this.evictionQueued = false;
        const parked = [...this.entries].filter(([, item]) => item.slots.length === 0);
        const victims = parked.slice(0, Math.max(0, parked.length - 32));
        for (const [id, item] of victims) {
          this.entries.delete(id);
          item.host.remove();
        }
        if (victims.length) this.publish();
      });
    }
    this.publish();
  }

  attach(id: string, slot: Slot) {
    let entry = this.entries.get(id);
    if (!entry) {
      const host = document.createElement("div");
      host.style.display = "contents";
      entry = { host, slots: [], view: slot.view };
      this.entries.set(id, entry);
    }
    entry.slots.push(slot);
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.bind(entry);
    return () => {
      if (this.entries.get(id) !== entry) { entry.host.remove(); return; }
      entry.slots = entry.slots.filter(item => item !== slot);
      this.bind(entry);
    };
  }

  update(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.bind(entry);
  }

  remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.host.remove();
    this.publish();
  }
}

const Context = createContext<TerminalViews | null>(null);

function Portals({ store }: { store: TerminalViews }) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return <>{[...store.entries].map(([id, entry]) => createPortal(cloneElement(entry.view, {
    onClosed: () => { store.remove(id); entry.view.props.onClosed?.(); },
  }), entry.host, id))}</>;
}

export function PersistentTerminalProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new TerminalViews());
  return <Context.Provider value={store}>
    <div hidden ref={element => { store.parking = element; }} aria-hidden="true" />
    {children}
    <Portals store={store} />
  </Context.Provider>;
}

export function PersistentTerminalSlot({ id, children }: { id: string; children: View }) {
  const store = useContext(Context);
  const container = useRef<HTMLDivElement>(null);
  const slot = useRef<Slot | null>(null);
  useLayoutEffect(() => {
    if (!store || !container.current) return;
    const current = { container: container.current, view: children };
    slot.current = current;
    const detach = store.attach(id, current);
    return () => { detach(); slot.current = null; };
  }, [store, id]);
  useLayoutEffect(() => {
    if (!store || !slot.current || slot.current.view === children) return;
    slot.current.view = children;
    store.update(id);
  }, [store, id, children]);
  return store ? <div ref={container} style={{ display: "contents" }} /> : children;
}
