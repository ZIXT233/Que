"use client";
import { useI18n } from "@/hooks/useI18n";
import { useEffect, useRef } from "react";

export function formatWorkspaceEnvironment(value: Record<string, string> = {}): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join("\n");
}

export function parseWorkspaceEnvironment(value: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  let size = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const equal = line.indexOf("=");
    const key = line.slice(0, equal);
    const entry = line.slice(equal + 1);
    size += line.length;
    if (equal < 0 || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key) || entry.includes("\0") || size > 32 * 1024 || (!Object.prototype.hasOwnProperty.call(result, key) && Object.keys(result).length >= 64)) return null;
    result[key] = entry;
  }
  return result;
}

export function WorkspaceEnvironmentEditor({ value, onChange, error }: { value: string; onChange: (value: string) => void; error: boolean }) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (error) details.current?.setAttribute("open", ""); }, [error]);
  return <details ref={details} className="workspace-advanced-setting">
    <summary>{t("workspace.envTitle")}</summary>
    <div className="workspace-advanced-setting-body">
      <label htmlFor="workspace-session-env">{t("workspace.envTitle")}</label>
      <textarea id="workspace-session-env" value={value} onChange={event => onChange(event.target.value)} spellCheck={false} rows={4} placeholder="CODEX_HOME=$HOME/.codex-alt" aria-invalid={error} />
      <p>{t("workspace.envHint")}</p>
      {error && <p role="alert" className="machine-error">{t("workspace.envInvalid")}</p>}
    </div>
  </details>;
}
