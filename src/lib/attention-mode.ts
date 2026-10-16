export const ATTENTION_MODE_KEY = "que:attention-mode";
export const ATTENTION_MODE_CHANGED = "que:attention-mode-changed";

export const ATTENTION_MODES = [
  { id: "daily", icon: "◇", label: "queue.日常模式" },
  { id: "focus", icon: "◎", label: "queue.专注模式" },
] as const;

export type AttentionMode = (typeof ATTENTION_MODES)[number]["id"];

/** What switching to each mode tells the user. */
export const MODE_TOAST: Record<AttentionMode, string> = {
  daily: "queue.已切换日常模式说明",
  focus: "queue.已切换专注模式说明",
};

export function isAttentionMode(value: unknown): value is AttentionMode {
  return ATTENTION_MODES.some((mode) => mode.id === value);
}

export function attentionModeFromStorage(stored: string | null): AttentionMode {
  return isAttentionMode(stored) ? stored : "daily";
}

/**
 * Focus mode: while this page is in the foreground, cards that join behind the
 * current card keep their banner but skip the working→deck transfer flight and chime.
 */
export function shouldQuietRearQueueArrival(
  mode: AttentionMode,
  side: "left" | "right",
  visibilityState: DocumentVisibilityState = "visible",
): boolean {
  return mode === "focus" && side === "right" && visibilityState === "visible";
}
