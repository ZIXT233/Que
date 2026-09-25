"use client";

import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "@/hooks/useI18n";
import { QUE_REPO_URL, releaseUrl, type AppUpdateState } from "@/hooks/useAppUpdate";
import { ConfigButton } from "./SettingsUi";
import { QueLogo } from "./QueLogo";

export function AboutSettings({ update }: { update: AppUpdateState }) {
  const { t } = useI18n();
  const [openFailed, setOpenFailed] = useState(false);
  const result = update.result;

  const openExternal = (url: string) => {
    setOpenFailed(false);
    void openUrl(url).catch(() => setOpenFailed(true));
  };

  return (
    <div className="settings-general settings-about">
      <h2 className="settings-general-title">{t("settings.about")}</h2>
      <div className="settings-about-brand">
        <span className="settings-about-logo"><QueLogo /></span>
        <div><strong>Que</strong><span>{t("settings.aboutTagline")}</span></div>
      </div>
      <p className="settings-about-description">{t("settings.aboutDescription")}</p>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.aboutVersion")}</h3>
        <div className="settings-about-row">
          <code>v{update.version}</code>
          <ConfigButton variant="secondary" size="small" onClick={() => void update.checkUpdates()} disabled={update.checking}>
            {update.checking ? t("settings.aboutChecking") : t("settings.aboutCheckUpdates")}
          </ConfigButton>
        </div>
        {result && (
          <div className="settings-about-update" role="status">
            <span>{result.newer ? t("settings.aboutUpdateAvailable", { version: result.version }) : t("settings.aboutUpToDate")}</span>
            {result.newer && (
              <ConfigButton variant="ghost" size="small" onClick={() => openExternal(import.meta.env.DEV ? `${QUE_REPO_URL}/releases/latest` : releaseUrl(result.tag))}>
                {t("settings.aboutViewRelease")}
              </ConfigButton>
            )}
          </div>
        )}
        {update.checkFailed && <p className="settings-general-error" role="alert">{t("settings.aboutCheckFailed")}</p>}
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">GitHub</h3>
        <button type="button" className="settings-about-link" onClick={() => openExternal(QUE_REPO_URL)}>
          github.com/ZIXT233/Que <span aria-hidden="true">↗</span>
        </button>
        {openFailed && <p className="settings-general-error" role="alert">{t("settings.aboutOpenFailed")}</p>}
      </section>
    </div>
  );
}
