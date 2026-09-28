"use client";

import { persistentStorage } from "../lib/persistent-storage.ts";

import { useSyncExternalStore } from "react";

export const CHAT_CONTENT_FONT_SIZE_DEFAULT = 14;
export const CHAT_CONTENT_FONT_SIZE_MIN = 12;
export const CHAT_CONTENT_FONT_SIZE_MAX = 24;
export const CHAT_CONTENT_FONT_SIZE_STORAGE_KEY = "pi-chat-content-font-size";

interface ChatAppearance {
  fontSize: number;
}

const DEFAULT_APPEARANCE: ChatAppearance = {
  fontSize: CHAT_CONTENT_FONT_SIZE_DEFAULT,
};
let appearance: ChatAppearance | null = null;
const listeners = new Set<() => void>();

export function clampChatContentFontSize(value: unknown): number {
  const size = Number(value ?? CHAT_CONTENT_FONT_SIZE_DEFAULT);
  if (!Number.isFinite(size)) return CHAT_CONTENT_FONT_SIZE_DEFAULT;
  return Math.max(CHAT_CONTENT_FONT_SIZE_MIN, Math.min(CHAT_CONTENT_FONT_SIZE_MAX, Math.round(size)));
}

function readStoredPreference(key: string): string | null {
  try {
    return persistentStorage().getItem(key);
  } catch {
    return null;
  }
}

function applyAppearance({ fontSize }: ChatAppearance): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--chat-content-font-size", `${fontSize}px`);
}

function getSnapshot(): ChatAppearance {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  if (!appearance) {
    appearance = {
      fontSize: clampChatContentFontSize(readStoredPreference(CHAT_CONTENT_FONT_SIZE_STORAGE_KEY)),
    };
    applyAppearance(appearance);
  }
  return appearance;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const sync=(event:StorageEvent)=>{
    if(event.key!==null && event.key!==CHAT_CONTENT_FONT_SIZE_STORAGE_KEY)return;
    const next=clampChatContentFontSize(readStoredPreference(CHAT_CONTENT_FONT_SIZE_STORAGE_KEY));
    if(next===getSnapshot().fontSize)return;
    appearance={fontSize:next};applyAppearance(appearance);listeners.forEach(fn=>fn());
  };
  window.addEventListener('storage',sync);
  return () => { listeners.delete(listener);window.removeEventListener('storage',sync); };
}

function setFontSize(value: number): void {
  const nextValue = clampChatContentFontSize(value);
  appearance = { ...getSnapshot(), fontSize: nextValue };
  applyAppearance(appearance);
  try {
    persistentStorage().setItem(CHAT_CONTENT_FONT_SIZE_STORAGE_KEY, String(nextValue));
  } catch {
    // Best-effort browser preference persistence.
  }
  listeners.forEach((listener) => listener());
}

export function useChatAppearance() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_APPEARANCE);
  return { ...snapshot, setFontSize };
}
