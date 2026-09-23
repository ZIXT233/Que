"use client";
import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
export function WorkspaceRcEditor({ workspaceId, draft, value, onChange }: { workspaceId?: string; draft?: { kind: "local" | "ssh"; cwd: string; sshHost?: string }; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  async function verify() {
    setBusy(true); setResult("");
    try {
      const response = await fetch("/api/card-queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "workspace_rc_verify", workspaceId, ...draft, terminalRc: value }) });
      const data = await response.json();
      setResult(response.ok ? data.output : data.error || data.code || t("workspace.rcFailed"));
    } catch (error) { setResult(String(error)); }
    finally { setBusy(false); }
  }
  return <div style={{ marginTop: 16 }}>
    <label htmlFor="workspace-rc">{t("workspace.rcTitle")}</label>
    <textarea id="workspace-rc" value={value} disabled={busy} spellCheck={false} rows={6}
      style={{ width: "100%", boxSizing: "border-box", fontFamily: "monospace", resize: "vertical", background: "var(--cq-paper)", color: "var(--cq-ink)", border: "1px solid var(--cq-line)", borderRadius: 8, padding: 10 }}
      onChange={event => { onChange(event.target.value); setResult(""); }} />
    <div className="workspace-rc-actions">
      <p>{t("workspace.rcHint")}</p>
      <button className="workspace-rc-verify" type="button" disabled={busy} onClick={() => void verify()}>{busy ? t("workspace.rcChecking") : t("workspace.rcVerify")}</button>
    </div>
    {result && <pre className="workspace-rc-result" role="status">{result}</pre>}
  </div>;
}
