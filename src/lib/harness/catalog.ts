import type { HarnessId } from "./types";

export interface HarnessCatalogEntry {
  id: HarnessId;
  name: string;
  description: string;
  /** From the machine's ACP catalog: whether the agent's CLI was found. */
  available?: boolean;
  missing?: string;
  /** Picker only; a hidden id still resolves names, icons and quirks. */
  hidden?: boolean;
  iconId?: string;
  /** SVG supplied by an installed harness extension. */
  iconDataUrl?: string;
  /** Registered from the user extension directory rather than the built-in catalog. */
  extension?: boolean;
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
  { id: "codex", name: "Codex", description: "OpenAI · CLI", iconId: "openai", conptyCursorHide: false },
  { id: "claude", name: "Claude Code", description: "Anthropic · CLI", iconId: "anthropic" },
  { id: "cursor", name: "Cursor Agent", description: "Cursor · CLI", iconId: "cursor" },
  { id: "opencode", name: "OpenCode", description: "OpenCode · CLI", iconId: "opencode" },
  { id: "antigravity", name: "Antigravity CLI", description: "Google · CLI", iconId: "antigravity" },
  { id: "pi", name: "Pi", description: "Pi · CLI", iconId: "pi" },
  { id: "omp", name: "Oh My Pi", description: "OMP · CLI", iconId: "omp" },
  { id: "codebuddy", name: "CodeBuddy", description: "Tencent · CLI", iconId: "codebuddy" },
  { id: "grok", name: "Grok Build", description: "xAI · CLI", iconId: "grok", themeProfile: "grok" },
  { id: "devin", name: "Devin", description: "Cognition · CLI", iconId: "devin" },
  { id: "shell", name: "Shell", description: "纯终端，不响应 Agent 事件", focusReporting: false, hidden: true },
];

let extensionCatalog: HarnessCatalogEntry[] = [];
export function setExtensionCatalog(entries: HarnessCatalogEntry[]) {
  extensionCatalog = entries;
}
/** acpx registry agents that the built-in catalog does not describe: display name and icon. */
const ACP_AGENTS: Record<string, [name: string, iconId: string]> = {
  gemini: ["Gemini CLI", "google"],
  openclaw: ["OpenClaw", "openclaw"],
  copilot: ["GitHub Copilot", "github-copilot"],
  droid: ["Factory Droid", "factory"],
  "fast-agent": ["fast-agent", "fastagent"],
  fx: ["fx", "fx"],
  "grok-build": ["Grok Build", "grok"],
  iflow: ["iFlow CLI", "iflow"],
  junie: ["Junie", "junie"],
  kilocode: ["Kilo Code", "kilocode"],
  kimi: ["Kimi CLI", "kimi-coding"],
  kiro: ["Kiro", "kiro"],
  mcode: ["MiniMax Code", "minimax"],
  mux: ["Mux", "mux"],
  pool: ["Poolside", "poolside"],
  qoder: ["Qoder CLI", "qoder"],
  qwen: ["Qwen Code", "qwen"],
  trae: ["TRAE CLI", "trae"],
  zeroclaw: ["ZeroClaw", "zeroclaw"],
};
const harnessMeta = (id: HarnessId | string) => [...harnessCatalog, ...extensionCatalog].find(item => item.id === id);

/** Accepts any id: a card can name an agent this catalog does not describe. */
export const harnessName = (id: HarnessId | string) => harnessMeta(id)?.name ?? ACP_AGENTS[id]?.[0] ?? id;

const PROVIDER_ICON_IDS: Record<string, string> = { codex: "openai", claude: "claudecode" };
export const providerIconId = (id: string) => PROVIDER_ICON_IDS[id] ?? harnessMeta(id)?.iconId ?? ACP_AGENTS[id]?.[1] ?? id;
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
