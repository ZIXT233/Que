"use client";

import { persistentStorage } from "../lib/persistent-storage.ts";
import { useCallback, useSyncExternalStore } from "react";
import {
  applyTerminalBackgroundAttr,
  isTerminalBackground,
  readTerminalBackground,
  resolveTerminalDark,
  syncTerminalCanvasToBackend,
  TERMINAL_BACKGROUND_KEY,
  type TerminalBackground,
} from "@/lib/terminal-background";

const listeners = new Set<() => void>();
let preference: TerminalBackground | null = null;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function getSnapshot(): TerminalBackground {
  if (typeof window === "undefined") return "follow";
  if (!preference) {
    preference = readTerminalBackground();
    applyTerminalBackgroundAttr(preference);
  }
  return preference;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const sync=(event:StorageEvent)=>{
    if(event.key!==null && event.key!==TERMINAL_BACKGROUND_KEY)return;
    const next=readTerminalBackground();if(next===getSnapshot())return;
    preference=next;applyTerminalBackgroundAttr(next);
    syncTerminalCanvasToBackend(resolveTerminalDark(document.documentElement.classList.contains('dark'),next));emit();
  };
  window.addEventListener('storage',sync);
  return () => { listeners.delete(listener);window.removeEventListener('storage',sync); };
}

export function useTerminalBackground() {
  const background = useSyncExternalStore(subscribe, getSnapshot, () => "follow" as const);
  const setBackground = useCallback((next: TerminalBackground) => {
    if (!isTerminalBackground(next)) return;
    preference = next;
    applyTerminalBackgroundAttr(next);
    try {
      persistentStorage().setItem(TERMINAL_BACKGROUND_KEY, next);
    } catch {
      /* private mode, quota */
    }
    const appDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    syncTerminalCanvasToBackend(resolveTerminalDark(appDark, next));
    emit();
  }, []);
  return { background, setBackground };
}
