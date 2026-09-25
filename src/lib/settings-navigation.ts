import { persistentStorage } from "./persistent-storage.ts";

export const SETTINGS_SECTION_VALUES = [
  "general",
  "terminal",
  "external-sessions",
  "remote-hosts",
  "about",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTION_VALUES)[number];
export type SettingsDetailSection = Exclude<SettingsSection, "general">;

const STORAGE_KEY = "que:settings-navigation";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return persistentStorage();
  } catch {
    return null;
  }
}

function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTION_VALUES.includes(value as SettingsSection);
}

export function getLastSettingsSection(
  _cwd: string | null,
  storage: StorageLike | null = getBrowserStorage(),
): SettingsSection {
  if (!storage) return "general";
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return "general";
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "general";
    const section = (parsed as { section?: unknown }).section;
    return isSettingsSection(section) ? section : "general";
  } catch {
    return "general";
  }
}

export function setLastSettingsSection(
  section: SettingsSection,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ section }));
  } catch {
    // Browser storage is best-effort.
  }
}

export function getLastSettingsSelection(): string | null {
  return null;
}

export function setLastSettingsSelection(): void {}
