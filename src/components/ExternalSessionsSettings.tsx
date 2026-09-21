"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ProviderIcon } from "./ProviderIcon";
import { ConfigSwitch } from "./SettingsUi";
import { externalHarnesses, providerIconId, type FormSupportStatus } from "@/lib/harness/catalog";

function FormCapsule({
  formLabel,
  status,
  statusLabel,
}: {
  formLabel: string;
  status: FormSupportStatus;
  statusLabel: string;
}) {
  return (
    <span className={`external-form-capsule is-${status}`}>
      <span className="external-capsule-form">{formLabel}</span>
      <span className="external-capsule-status">{statusLabel}</span>
    </span>
  );
}

export function ExternalSessionsSettings() {
  const { t } = useI18n();
  const [master, setMaster] = useState(false);
  const [masterLoading, setMasterLoading] = useState(false);
  const [ingress, setIngress] = useState<Record<string, boolean>>({});
  const [loadingHarness, setLoadingHarness] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/tools/settings")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { externalIngress?: Record<string, boolean>; externalNoticesEnabled?: boolean };
        if (data.externalIngress) {
          setIngress(data.externalIngress);
        }
        if (typeof data.externalNoticesEnabled === "boolean") {
          setMaster(data.externalNoticesEnabled);
        }
      })
      .catch(() => {});
  }, []);

  const handleMasterToggle = async (nextChecked: boolean) => {
    setMasterLoading(true);
    setMaster(nextChecked);
    try {
      const res = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalNotices: nextChecked }),
      });
      if (!res.ok) throw new Error(`Settings update failed: ${res.status}`);
      if (res.ok) {
        const data = (await res.json()) as { externalNoticesEnabled?: boolean };
        if (typeof data.externalNoticesEnabled === "boolean") {
          setMaster(data.externalNoticesEnabled);
        }
      }
    } catch {
      setMaster((prev) => !nextChecked);
    } finally {
      setMasterLoading(false);
    }
  };

  const handleToggle = async (harnessId: string, nextChecked: boolean) => {
    setLoadingHarness(harnessId);
    setIngress((prev) => ({ ...prev, [harnessId]: nextChecked }));

    try {
      const res = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalHarness: harnessId, enabled: nextChecked }),
      });
      if (!res.ok) throw new Error(`Settings update failed: ${res.status}`);
      if (res.ok) {
        const data = (await res.json()) as { externalIngress?: Record<string, boolean> };
        if (data.externalIngress) {
          setIngress(data.externalIngress);
        }
      }
    } catch {
      // Revert on error
      setIngress((prev) => ({ ...prev, [harnessId]: !nextChecked }));
    } finally {
      setLoadingHarness(null);
    }
  };

  const getStatusText = (status: FormSupportStatus) => {
    if (status === "supported") return t("settings.harnessForms.supported");
    if (status === "in_progress") return t("settings.harnessForms.inProgress");
    if (status === "unknown") return t("settings.harnessForms.unknown");
    return t("settings.harnessForms.unsupported");
  };

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.externalSessions")}</h2>
      <p className="settings-general-description" style={{ marginTop: 6, marginBottom: 20 }}>
        {t("settings.externalSessionsDescription")}
      </p>

      <div className="external-harness-card is-master">
        <div className="external-harness-card-header">
          <div className="external-harness-brand">
            <div className="external-harness-info">
              <span className="external-harness-name">{t("settings.externalNoticesMaster")}</span>
              <span className="external-harness-vendor">{t("settings.externalNoticesMasterDescription")}</span>
            </div>
          </div>
          <div className="external-harness-toggle">
            <ConfigSwitch
              checked={master}
              loading={masterLoading}
              label={t("settings.externalNoticesMasterLabel")}
              onChange={(checked) => void handleMasterToggle(checked)}
            />
          </div>
        </div>
      </div>

      <div className={`external-sessions-list${master ? "" : " is-gated"}`}>
        {externalHarnesses.map((harness) => {
          const isEnabled = master && ingress[harness.id] !== false;
          const isLoading = loadingHarness === harness.id;

          return (
            <div key={harness.id} className={`external-harness-card${isEnabled ? " is-active" : ""}`}>
              <div className="external-harness-card-header">
                <div className="external-harness-brand">
                  <span className="external-harness-icon-wrap">
                    <ProviderIcon id={providerIconId(harness.iconId)} size={20} />
                  </span>
                  <div className="external-harness-info">
                    <span className="external-harness-name">{harness.name}</span>
                    <span className="external-harness-vendor">{harness.vendor}</span>
                  </div>
                </div>

                <div className="external-harness-toggle">
                  <ConfigSwitch
                    checked={isEnabled}
                    loading={isLoading}
                    disabled={!master}
                    label={`${t("settings.externalSessions")} - ${harness.name}`}
                    onChange={(checked) => void handleToggle(harness.id, checked)}
                  />
                </div>
              </div>

              <div className="external-harness-capsules">
                <FormCapsule
                  formLabel={t("settings.harnessForms.cli")}
                  status={harness.forms.cli}
                  statusLabel={getStatusText(harness.forms.cli)}
                />
                {harness.forms.desktop && (
                  <FormCapsule
                    formLabel={t("settings.harnessForms.desktop")}
                    status={harness.forms.desktop}
                    statusLabel={getStatusText(harness.forms.desktop)}
                  />
                )}
                {harness.forms.vscode && (
                  <FormCapsule
                    formLabel={t("settings.harnessForms.vscode")}
                    status={harness.forms.vscode}
                    statusLabel={getStatusText(harness.forms.vscode)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
