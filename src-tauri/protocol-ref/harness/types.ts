export type HarnessId = "codex" | "claude" | "cursor" | "devin" | "pi" | "omp" | "grok" | "gemini" | "opencode" | "antigravity" | "shell";
export type HarnessState = "starting" | "working" | "attention" | "unknown" | "exited" | "error";
export interface HarnessSession {
  kind: HarnessId;
  terminalId: string;
  state: HarnessState;
  version: string;
  replyPreview?: string;
  shellCommandNotifications?: boolean;
  shellCommandStartedAt?: number;
  shellCommandRunning?: boolean;
  shellNotify?: boolean;
  shellExitCode?: number;
  exitCode?: number;
  providerSessionId?: string;
  title?: string;
  unpersistedSession?: boolean;
  remote?: boolean;
  source?: "hook" | "title";
  probe?: "hooks-and-title" | "hooks" | "title-only" | "unconfirmed";
}
export interface HarnessProbe {
  readonly sessionId?: string;
  readonly sessionIdPrefix?: string;
  /** Codex plan/approval TUI prompts have no hook; consume one-shot input waits. */
  consumeNeedsInput?(): boolean;
  push(data: string): HarnessState | undefined;
}
export interface HarnessAdapter {
  id: HarnessId;
  executable: string;
  args: string[];
  createProbe(): HarnessProbe;
  resumeArgs(sessionId: string): string[];
}
