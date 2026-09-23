"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export function McpSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/mcp/config", { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(value => setConfig(JSON.stringify(value, null, 2)))
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  return <section className="settings-general-section">
    <h3 className="settings-general-heading">MCP</h3>
    <p className="settings-general-description">{t("settings.mcpDescription")}</p>
    {failed ? <p role="alert">{t("settings.mcpUnavailable")}</p> :
      <textarea aria-label={t("settings.mcpConfig")} readOnly value={config} rows={11}
        onFocus={event => event.currentTarget.select()}
        style={{ width: "100%", boxSizing: "border-box", marginTop: 12, padding: 12, fontFamily: "monospace", fontSize: 12, border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--bg-secondary)", color: "inherit", resize: "vertical" }} />}
    <p className="settings-general-description">{t("settings.mcpNode")}</p>
  </section>;
}
