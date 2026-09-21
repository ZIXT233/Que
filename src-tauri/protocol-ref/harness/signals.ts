import type { HarnessState } from "./types.ts";
import type { HookSignal } from "./hook-contract.ts";
export type { HookSignal } from "./hook-contract.ts";

export interface ProbeState {
  replyPreview?: string;
  antigravityCompleted?: boolean;
  state: HarnessState;
  at: number;
  shellCommandStartedAt?: number;
  shellCommandRunning?: boolean;
  shellExitCode?: number;
  title?: string;
  titleState?: HarnessState;
  titleSeen?: boolean;
  hookSeen?: boolean;
  sessionId?: string;
  identityAt?: number;
  sessionIdPrefix?: string;
  source?: "hook" | "title";
  /** Wall-clock ms when a guessed ask was first seen; cleared once it settles. */
  heldAttentionAt?: number;
  /** The tool whose start is held, so a promoted ask can still name it. */
  heldTool?: string;
}

/**
 * How long a guessed ask is held before it is raised as one. Antigravity and Cursor
 * fire the same tool hook whether or not the user is asked, so only silence longer
 * than this tells a running tool from one that is waiting.
 */
export const HELD_ATTENTION_MS = 5_000;

/**
 * What one hook event means for a card. A harness's own words are read once, by
 * `meaningOf`, and turn straight into what the card does with them — there is no
 * canonical-event layer in between to translate again. Mirror of the `Meaning` enum in
 * `src-tauri/src/harness/signals.rs`.
 *
 * The states are still two (`working`, `attention`); this vocabulary adds the two things
 * that are not states: the turn boundaries, and the honest "cannot tell" of a tool gate
 * the CLI answers itself.
 */
export type Meaning =
  | "nothing"
  | "sessionStart"
  | "turnStart"
  | "working"
  | "maybeAttention"
  | "attention"
  | "turnEnd";

/** Tools whose whole purpose is to ask: the hook is the ask, not a tool gate. */
const ASK_TOOL = /(^|[/.])(request_user_input|ask_user_question|ask_user|ask_question|AskUserQuestion)$/;

/** A tool start whose gate the CLI owns, so the ask is only a guess. */
function guessesAttention(signal: HookSignal): boolean {
  if (signal.kind === "antigravity") return signal.event === "PreToolUse";
  if (signal.kind === "cursor") return ["preToolUse", "beforeShellExecution", "beforeMCPExecution"].includes(signal.event);
  return false;
}

/** A notification the CLI sends to say a prompt is on screen, rather than to chat. */
function isAskNotification(signal: HookSignal): boolean {
  return signal.event === "Notification"
    && ["permission_prompt", "ToolPermission", "idle_prompt"].includes(signal.notification ?? "");
}

// Event names follow Orca's Codex adapter (MIT, attribution in docs/harness).
// Que schedules the interactive root TUI, not a roster of background agents.
/** The one place a harness's vocabulary is read. */
export function meaningOf(signal: HookSignal): Meaning {
  if (signal.agentId) return "nothing";
  // An ask-shaped tool is the ask itself, whatever gate the harness owns.
  const toolStart = ["PreToolUse", "BeforeTool", "preToolUse"].includes(signal.event);
  if (toolStart && ASK_TOOL.test(signal.tool ?? "")) return "attention";
  if (guessesAttention(signal)) return "maybeAttention";
  if (isAskNotification(signal)) return "attention";
  switch (signal.event) {
    case "SessionStart":
    case "sessionStart":
      return "sessionStart";
    // A prompt was submitted: a new turn.
    case "beforeSubmitPrompt":
    case "UserPromptSubmit":
    case "BeforeAgent":
    case "PreInvocation":
      return "turnStart";
    // Tool traffic: a turn already in progress.
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "BeforeTool":
    case "AfterTool":
    case "PostInvocation":
    case "preToolUse":
    case "postToolUse":
    case "postToolUseFailure":
      return "working";
    // A turn that ended — unless Antigravity reports that it only paused.
    case "stop":
    case "Stop":
    case "StopFailure":
    case "StopCancelled":
    case "sessionEnd":
    case "SessionEnd":
    case "AfterAgent":
    case "afterAgentResponse":
      return signal.fullyIdle === false ? "working" : "turnEnd";
    // A permission act the harness reports itself.
    case "PermissionRequest":
    case "beforeShellExecution":
    case "beforeMCPExecution":
      return "attention";
    default:
      return "nothing";
  }
}

/** The whole mapping: two states, and nothing to say about the rest. */
export function hookState(meaning: Meaning): HarnessState | undefined {
  switch (meaning) {
    case "working":
    case "turnStart":
    case "maybeAttention":
      return "working";
    case "attention":
    case "turnEnd":
      return "attention";
    default:
      return undefined;
  }
}

export function observeHook(current: ProbeState, raw: HookSignal): ProbeState {
  if (!Number.isFinite(raw.at) || raw.agentId) return current;
  if (typeof raw.event !== "string") return current;
  const meaning = meaningOf(raw);
  const sessionId = typeof raw.sessionId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(raw.sessionId) ? raw.sessionId : undefined;
  // Signals already landed on this card. Cursor /resume often skips sessionStart.
  const cleanTitle = (value: unknown) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) || undefined : undefined;
  const newIdentity = sessionId && sessionId !== current.sessionId;
  const title = cleanTitle(raw.title) ?? (!newIdentity ? current.title : undefined) ?? cleanTitle(raw.prompt);
  const identity = sessionId && raw.at >= (current.identityAt ?? 0) ? { sessionId, sessionIdPrefix: undefined, identityAt: raw.at, title } : {};
  if (raw.at < current.at) return { ...current, hookSeen: true, ...identity };
  // Antigravity files stragglers once a turn really ended, so it needs the two turn
  // boundaries told apart from the states it also reports.
  if (raw.kind === "antigravity" && current.antigravityCompleted && !newIdentity && meaning !== "turnStart" && meaning !== "turnEnd") return current;
  const state = hookState(meaning);
  return { ...current, hookSeen: true, ...identity,
    ...(raw.kind === "antigravity" ? { antigravityCompleted: meaning === "turnEnd" } : {}),
    replyPreview: state === "working" ? undefined : cleanTitle(raw.replyPreview) ?? (newIdentity ? undefined : current.replyPreview),
    ...(!state && meaning === "sessionStart" && current.state === "starting" ? { state: "attention" as const } : {}),
    ...(state ? { state, at: raw.at, source: "hook" as const,
      // A guessed ask is held: the first one stamps the clock, later ones leave it alone.
      heldAttentionAt: meaning === "maybeAttention" ? (current.heldAttentionAt ?? raw.at) : undefined,
      heldTool: meaning === "maybeAttention" ? (raw.tool ?? current.heldTool) : undefined,
    } : {}),
  };
}

/** Promote a held guess whose window has run out, or `undefined` while it is still inside it. */
export function settleHeld(current: ProbeState, now: number): ProbeState | undefined {
  const held = current.heldAttentionAt;
  if (held === undefined || now - held < HELD_ATTENTION_MS) return undefined;
  // Something already spoke for this card; there is no guess left to promote.
  if (current.state !== "working") return undefined;
  return { ...current, heldAttentionAt: undefined, heldTool: undefined, state: "attention", at: now, source: "hook" };
}

export function observeTitle(current: ProbeState, state: HarnessState, at: number, hooksAuthoritative = false): ProbeState {
  if (hooksAuthoritative && current.hookSeen) return { ...current, titleSeen: true, titleState: state };
  // A repeated spinner must not override a newer approval hook with an old working title.
  if (current.titleState === state) return { ...current, titleSeen: true };
  return { ...current, titleSeen: true, titleState: state, state, at, source: "title" };
}
