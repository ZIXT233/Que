/**
 * Launch-chain failure codes Que itself authors. Their messages live in the i18n files
 * (`harness.error.<CODE>`) and are translated at render time, so a locale change
 * re-renders them. Machine connection codes use the shared machine translations.
 * Uncoded terminal, SSH or io text passes through untouched.
 * A `{detail}` placeholder in the message carries the variable part (the CLI name, the
 * version floor, the hook owner).
 */
export const HARNESS_ERROR_CODES = [
  "HARNESS_UNSUPPORTED", "HARNESS_RESUME_NO_ID", "HARNESS_SESSION_ID_INVALID",
  "HARNESS_CLI_MISSING", "HARNESS_CLI_MISSING_REMOTE", "HARNESS_VERSION_TOO_OLD",
  "HARNESS_NODE_MISSING", "REMOTE_HOME_UNKNOWN", "WORKSPACE_MISSING",
  "REMOTE_SHELL_NO_OUTPUT", "HARNESS_ENV_UNREADABLE", "HARNESS_CONFIG_UNREADABLE",
  "HARNESS_HOOKS_FOREIGN", "HARNESS_HOOKS_INVALID", "REMOTE_CWD_UNRESOLVABLE",
  "HARNESS_LAUNCH_IN_PROGRESS", "HARNESS_STILL_RUNNING", "HARNESS_START_NOT_BLANK",
  "HARNESS_ALREADY_KNOWN", "HARNESS_STATE_CHANGED", "CARD_ID_INVALID", "CARD_GONE",
] as const as readonly string[];

import type { TranslationParams } from "@/lib/i18n/types";
import { MACHINE_ERROR_CODES, machineErrorText } from "../workspace-machine-errors";

type Translate = (key: string, params?: TranslationParams) => string;

export function harnessErrorText(error: unknown, t: Translate): string {
  if (typeof error === "string") return error;
  if (!(error && typeof error === "object")) return "";
  const { code, message, detail } = error as { code?: string; message?: string; detail?: string };
  if (code && MACHINE_ERROR_CODES.includes(code)) return machineErrorText(error, t);
  if (!code || !HARNESS_ERROR_CODES.includes(code)) return message ?? "";
  return t(`harness.error.${code}`, detail !== undefined ? { detail } : undefined);
}
