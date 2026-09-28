import { harnessName } from "./catalog.ts";
import type { HarnessSession } from "./types.ts";

export function cardTitle(
  harness: HarnessSession | undefined,
  workspaceName: string | undefined,
  fallback: string,
) {
  if (!harness) return fallback;
  // Prefer the provider title; the first prompt is the stable fallback.
  return harness.sessionName?.trim()
    || harness.firstPrompt?.trim()
    || harness.submitPrompt?.trim()
    || `${harnessName(harness.kind)} · ${workspaceName || fallback}`;
}
