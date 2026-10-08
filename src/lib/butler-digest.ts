// Mirrors src-tauri/src/digest.rs: presets for people, cron underneath.
export const BUTLER_DIGEST_KEY = "que:butler-digest";
export const BUTLER_DIGEST_MODES = ["off", "daily", "weekdays", "interval", "custom"] as const;
export type ButlerDigest = { mode: typeof BUTLER_DIGEST_MODES[number]; time: string; intervalHours: number; cron: string };
export const DEFAULT_BUTLER_DIGEST: ButlerDigest = { mode: "off", time: "09:00", intervalHours: 4, cron: "0 9 * * 1-5" };

export function digestFromStorage(raw: string | null): ButlerDigest {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (value && BUTLER_DIGEST_MODES.includes(value.mode) && /^\d{2}:\d{2}$/.test(value.time)
      && Number.isInteger(value.intervalHours) && typeof value.cron === "string") return value;
  } catch { /* fall through to the default */ }
  return DEFAULT_BUTLER_DIGEST;
}

function field(spec: string, min: number, max: number): boolean {
  return spec.split(",").every(part => {
    const [range, step] = part.split("/");
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) > 0)) return false;
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2 || !bounds.every(b => /^\d+$/.test(b))) return false;
    const [lo, hi = lo] = bounds.map(Number);
    return lo >= min && hi <= max && lo <= hi;
  });
}

/** minute hour day-of-month month day-of-week */
export function cronValid(expr: string): boolean {
  const f = expr.trim().split(/\s+/);
  return f.length === 5 && field(f[0], 0, 59) && field(f[1], 0, 23) && field(f[2], 1, 31) && field(f[3], 1, 12) && field(f[4], 0, 7);
}
