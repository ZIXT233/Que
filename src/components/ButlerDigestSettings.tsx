"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { persistentStorage } from "@/lib/persistent-storage";
import { BUTLER_DIGEST_KEY, BUTLER_DIGEST_MODES, DEFAULT_BUTLER_DIGEST, cronValid, digestFromStorage, type ButlerDigest } from "@/lib/butler-digest";
import { CONFIG_INPUT_STYLE, ConfigButton } from "./SettingsUi";

const CHANGED = "que:butler-digest-changed";

export function ButlerDigestSettings() {
  const { t } = useI18n();
  const [value, setValue] = useState<ButlerDigest>(DEFAULT_BUTLER_DIGEST);
  const [status, setStatus] = useState("");
  const [cronDraft, setCronDraft] = useState(DEFAULT_BUTLER_DIGEST.cron);

  useEffect(() => {
    const sync = () => {
      const next = digestFromStorage(persistentStorage().getItem(BUTLER_DIGEST_KEY));
      setValue(next);
      setCronDraft(next.cron);
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener(CHANGED, sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener(CHANGED, sync); };
  }, []);

  const update = useCallback((patch: Partial<ButlerDigest>) => {
    const next = { ...value, ...patch };
    persistentStorage().setItem(BUTLER_DIGEST_KEY, JSON.stringify(next));
    setValue(next);
    window.dispatchEvent(new Event(CHANGED));
  }, [value]);

  const runNow = async () => {
    setStatus("");
    try {
      const response = await fetch("/api/butler/digest", { method: "POST" });
      const data = await response.json();
      setStatus(response.ok ? t("settings.butlerDigest.sent") : data.error || t("settings.butlerDigest.failed"));
    } catch {
      setStatus(t("settings.butlerDigest.failed"));
    }
  };

  const cronOk = cronValid(cronDraft);
  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.butlerDigest")}</h3>
      <p className="settings-general-description">{t("settings.butlerDigestDescription")}</p>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{t("settings.butlerDigest.schedule")}</span>
          <div className="settings-chat-option-actions">
            <select aria-label={t("settings.butlerDigest.schedule")} style={CONFIG_INPUT_STYLE} value={value.mode} onChange={e => update({ mode: e.target.value as ButlerDigest["mode"] })}>
              {BUTLER_DIGEST_MODES.map(mode => <option key={mode} value={mode}>{t(`settings.butlerDigest.${mode}`)}</option>)}
            </select>
            {(value.mode === "daily" || value.mode === "weekdays") &&
              <input type="time" aria-label={t("settings.butlerDigest.time")} style={CONFIG_INPUT_STYLE} value={value.time} onChange={e => { if (e.target.value) update({ time: e.target.value }); }} />}
            {value.mode === "interval" &&
              <select aria-label={t("settings.butlerDigest.every")} style={CONFIG_INPUT_STYLE} value={value.intervalHours} onChange={e => update({ intervalHours: Number(e.target.value) })}>
                {[1, 2, 3, 4, 6, 8, 12].map(hours => <option key={hours} value={hours}>{t("settings.butlerDigest.hours", { count: hours })}</option>)}
              </select>}
            <ConfigButton variant="ghost" size="small" onClick={() => void runNow()}>{t("settings.butlerDigest.runNow")}</ConfigButton>
          </div>
        </div>
        {value.mode === "custom" && <div className="settings-chat-option">
          <input aria-label={t("settings.butlerDigest.cron")} style={{ ...CONFIG_INPUT_STYLE, fontFamily: "monospace", width: "100%" }} value={cronDraft} placeholder="0 9 * * 1-5"
            onChange={e => { setCronDraft(e.target.value); if (cronValid(e.target.value)) update({ cron: e.target.value.trim() }); }} />
        </div>}
        {value.mode === "custom" && <p className={cronOk ? "settings-general-description" : "settings-general-error"}>{cronOk ? t("settings.butlerDigest.cronHint") : t("settings.butlerDigest.cronInvalid")}</p>}
        {status && <p role="status" className="settings-general-description">{status}</p>}
      </div>
    </section>
  );
}
