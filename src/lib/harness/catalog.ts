import type { HarnessId } from "./types";

/** Support status of one external-session form factor. */
export type FormSupportStatus = "supported" | "unsupported" | "in_progress" | "unknown";
export interface HarnessForms {
  cli: FormSupportStatus;
  /** Omit a form that the harness does not offer rather than labelling it unsupported. */
  desktop?: FormSupportStatus;
  vscode?: FormSupportStatus;
}

export interface HarnessCatalogEntry {
  id: HarnessId;
  name: string;
  description: string;
  /** Picker only; a hidden id still resolves names, icons and quirks. */
  hidden?: boolean;
  /** Vendor line, shown in the external-sessions settings. */
  vendor?: string;
  iconId?: string;
  /** SVG supplied by an installed harness extension. */
  iconDataUrl?: string;
  /** Registered from the user extension directory rather than the built-in catalog. */
  extension?: boolean;
  forms?: HarnessForms;
  /** The terminal theme palette this harness paints itself in. */
  themeProfile?: "grok";
  /** Whether the PTY hides the cursor after ConPTY respawn (default true). */
  conptyCursorHide?: boolean;
  /** Whether focus events are reported to the CLI (default true). */
  focusReporting?: boolean;
}

/**
 * Built-in harness metadata. User extensions are loaded separately at runtime and
 * added to the new-session picker.
 */
export const harnessCatalog: HarnessCatalogEntry[] = [
  { id: "codex", name: "Codex", description: "OpenAI · CLI", vendor: "OpenAI", iconId: "openai", forms: { cli: "supported", desktop: "supported", vscode: "supported" }, conptyCursorHide: false },
  { id: "claude", name: "Claude Code", description: "Anthropic · CLI", vendor: "Anthropic", iconId: "anthropic", forms: { cli: "supported", desktop: "supported", vscode: "supported" } },
  { id: "cursor", name: "Cursor Agent", description: "Cursor · CLI", vendor: "Cursor", iconId: "cursor", forms: { cli: "supported", desktop: "supported" } },
  { id: "opencode", name: "OpenCode", description: "OpenCode · CLI", vendor: "OpenCode", iconId: "opencode", forms: { cli: "supported", desktop: "supported", vscode: "supported" } },
  { id: "antigravity", name: "Antigravity CLI", description: "Google · CLI", vendor: "Google", iconId: "antigravity", forms: { cli: "supported", desktop: "supported", vscode: "supported" } },
  { id: "pi", name: "Pi", description: "Pi · CLI", vendor: "Pi", iconId: "pi", forms: { cli: "supported" } },
  { id: "omp", name: "Oh My Pi", description: "OMP · CLI", vendor: "Pi", iconId: "omp", forms: { cli: "supported" } },
  { id: "codebuddy", name: "CodeBuddy", description: "Tencent · CLI", vendor: "Tencent", iconId: "codebuddy", forms: { cli: "supported", desktop: "unsupported" } },
  { id: "grok", name: "Grok Build", description: "xAI · CLI", vendor: "xAI", iconId: "grok", forms: { cli: "supported" }, themeProfile: "grok" },
  { id: "devin", name: "Devin", description: "Cognition · CLI", vendor: "Cognition", iconId: "devin", forms: { cli: "supported" } },
  { id: "shell", name: "Shell", description: "纯终端，不响应 Agent 事件", focusReporting: false, hidden: true },
];

let extensionCatalog: HarnessCatalogEntry[] = [];
export function setExtensionCatalog(entries: HarnessCatalogEntry[]) {
  extensionCatalog = entries;
}
const harnessMeta = (id: HarnessId | string) => [...harnessCatalog, ...extensionCatalog].find(item => item.id === id);

export const harnessPicker = harnessCatalog.filter(item => !item.hidden);
/** Accepts any id, so an external notice can name a CLI that is not in the picker. */
export const harnessName = (id: HarnessId | string) => harnessMeta(id)?.name ?? id;
export const isExtensionHarness = (id: HarnessId | string) => extensionCatalog.some(item => item.id === id);

/**
 * The external-ingress toggles, in settings order. OMP reports through Pi's extension
 * and shares its settings key, so the two share one card — as on the backend, where
 * `omp` resolves to Pi's `ingress_key`.
 */
const EXTERNAL_ORDER: HarnessId[] = ["codex", "claude", "cursor", "opencode", "antigravity", "pi", "codebuddy", "grok", "devin"];
export interface ExternalHarnessEntry {
  id: HarnessId;
  name: string;
  vendor: string;
  iconId: string;
  iconDataUrl?: string;
  extension?: boolean;
  forms: HarnessForms;
}
export const externalHarnesses: ExternalHarnessEntry[] = EXTERNAL_ORDER.map(id => {
  const meta = harnessMeta(id)!;
  return { id, name: id === "pi" ? "Pi / OMP" : meta.name, vendor: meta.vendor!, iconId: meta.iconId!, forms: meta.forms! };
});

const PROVIDER_ICON_IDS: Record<string, string> = { codex: "openai", claude: "claudecode", gemini: "google" };
export const providerIconId = (id: string) => PROVIDER_ICON_IDS[id] ?? harnessMeta(id)?.iconId ?? id;
export const extensionIconDataUrl = (id: string) => harnessMeta(id)?.iconDataUrl;

/** Terminal options for one harness, with the component defaults filled in. */
export const terminalOptions = (id: HarnessId | string) => {
  const meta = harnessMeta(id);
  return {
    themeProfile: meta?.themeProfile,
    conptyCursorHide: meta?.conptyCursorHide ?? true,
    focusReporting: meta?.focusReporting ?? true,
  };
};
