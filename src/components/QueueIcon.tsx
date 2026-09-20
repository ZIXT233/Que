"use client";

export type QueueIconName = "plus" | "stack" | "out" | "maximize" | "down" | "close" | "settings" | "history" | "archive" | "arrow" | "undo" | "bell" | "bell-off" | "bell-filled" | "eye-off" | "tools" | "clock" | "copy" | "check";

const ICON_PATHS: Record<Exclude<QueueIconName, "bell-filled">, string> = {
  plus: "M12 5v14M5 12h14", stack: "m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4",
  out: "M14 3h7v7M21 3 10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
  maximize: "M8 3H3v5m18 0V3h-5M3 16v5h5m8 0h5v-5",
  down: "M12 3v12m-5-5 5 5 5-5M4 20h16", close: "m6 6 12 12M6 18 18 6",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z", history: "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-4v6l4 2",
  archive: "M3 3h18v5H3zM5 8v13h14V8M10 12h4", arrow: "M19 12H5m6-6-6 6 6 6",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  "bell-off": "M4 4l16 16M18 8a6 6 0 0 0-9.9-4.5M6.5 6.5C6.3 7 6 7.5 6 8c0 7-3 7-3 9h12M18 17h3c0-2-3-2-3-9M10 21h4",
  "eye-off": "m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 8.5 4.5 9.5 8-0.4 1.4-1.3 3-2.7 4.3M6.2 6.2C4.3 7.7 3 10 2.5 12c1 3.5 4.5 8 9.5 8 1.5 0 2.8-.4 4-1.1M9.1 9.1A4 4 0 0 0 14.9 15",
  undo: "m9 14-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-1",
  tools: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3.5 2",
  copy: "M8 4v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7.24a2 2 0 0 0-.6-1.43L16.1 2.57A2 2 0 0 0 14.7 2H10a2 2 0 0 0-2 2ZM4 8v12a2 2 0 0 0 2 2h8",
  check: "m5 13 4 4L19 7",
};

/** The queue's own icon set: cards, toolbar and dialogs draw the same marks. */
export function Icon({ name, size = 18 }: { name: QueueIconName; size?: number }) {
  if (name === "bell-filled") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a6 6 0 0 0-6 6v2.9c0 2.1-.8 4.1-2.3 5.6A1.2 1.2 0 0 0 4.6 19h14.8a1.2 1.2 0 0 0 .9-2.5c-1.5-1.5-2.3-3.5-2.3-5.6V8a6 6 0 0 0-6-6Zm-2.7 19a3 3 0 0 0 5.4 0H9.3Z" /></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[name]} /></svg>;
}
