"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useCompletionNotifications } from "@/hooks/useCompletionNotifications";
import { useAudio } from "@/hooks/useAudio";
import { useTheme } from "@/hooks/useTheme";
import { useAttentionMode } from "@/hooks/useAttentionMode";
import { useSubmissionBehavior } from "@/hooks/useSubmissionBehavior";
import { ATTENTION_MODES } from "@/lib/attention-mode";
import { SUBMISSION_BEHAVIORS } from "@/lib/submission-behavior";
import { announceQueueToast } from "@/lib/queue-toast";
import { THEME_OPTIONS } from "@/lib/theme";
import { McpSettings } from "./McpSettings";
import { TerminalSettings } from "./TerminalSettings";
import { ThemeIcon } from "./ThemeIcon";
import { setLastSettingsSection, SETTINGS_SECTION_VALUES, type SettingsSection } from "@/lib/settings-navigation";
import { RemoteHostsSettings } from "./RemoteHostsSettings";
import { ExternalSessionsSettings } from "./ExternalSessionsSettings";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { saveAndOpenAppLog } from "@/lib/card-log";
import { invoke } from "@tauri-apps/api/core";
import { setDeveloperProbesEnabled } from "@/lib/developer-probes";
import { QueLogo } from "./QueLogo";

interface Props {
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
}

export function SettingsSectionIcon({ section, size = 16, strokeWidth = 1.8 }: { section: SettingsSection; size?: number; strokeWidth?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
  };
  if (section === "remote-hosts") return <svg {...common}><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6h.01M8 17h.01M12 6h5M12 17h5" /></svg>;
  if (section === "terminal") return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
  if (section === "external-sessions") {
    return (
      <svg {...common}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    );
  }
  return <svg {...common}><path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></svg>;
}

function GeneralSettings() {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const notifications = useCompletionNotifications(null);
  const audio = useAudio();
  const [audioBlocked, setAudioBlocked] = useState(false);
  const { preference, setThemePreference } = useTheme();
  const { mode: attentionMode, setMode: setAttentionMode } = useAttentionMode();
  const { mode: submissionBehavior, setMode: setSubmissionBehavior } = useSubmissionBehavior();

  const [debugLogging, setDebugLogging] = useState(false);
  const [logStatus, setLogStatus] = useState("");

  useEffect(() => {
    void fetch("/api/tools/settings").then(async (response) => {
      const data = await response.json() as { debugLogging?: boolean; developerProbes?: boolean };
      const on = !!(data.debugLogging ?? data.developerProbes);
      setDebugLogging(on);
      setDeveloperProbesEnabled(on);
    }).catch(() => {});
  }, []);

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.general")}</h2>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.appearance")}</h3>
        <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
          {THEME_OPTIONS.map((option) => {
            const selected = preference === option.id;
            return (
              <label key={option.id} className="settings-theme-option">
                <input type="radio" name="theme" value={option.id} checked={selected} onChange={() => setThemePreference(option.id)} className="sr-only" />
                <ThemeIcon preference={option.id} />
                <span className="settings-theme-option-label">{t(option.label)}</span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.attentionMode")}</h3>
        <div className="settings-attention-mode-copy">
          <p className="settings-general-description">{t("settings.attentionModeDailyDescription")}</p>
          <p className="settings-general-description">{t("settings.attentionModeFocusDescription")}</p>
        </div>
        <div role="radiogroup" aria-label={t("settings.attentionMode")} className="settings-theme-options settings-attention-mode-options">
          {ATTENTION_MODES.map((option) => {
            const selected = attentionMode === option.id;
            return (
              <label key={option.id} className="settings-theme-option">
                <input
                  type="radio"
                  name="attention-mode"
                  value={option.id}
                  checked={selected}
                  onChange={() => {
                    setAttentionMode(option.id);
                    announceQueueToast(t(option.id === "focus" ? "queue.已切换专注模式说明" : "queue.已切换日常模式说明"));
                  }}
                  className="sr-only"
                />
                <span className="settings-attention-mode-icon" aria-hidden="true">{option.icon}</span>
                <span className="settings-theme-option-label">{t(option.label)}</span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.submissionBehavior")}</h3>
        <div className="settings-attention-mode-copy">
          <p className="settings-general-description">{t("settings.submissionKeepInViewDescription")}</p>
          <p className="settings-general-description">{t("settings.submissionCollapseDescription")}</p>
        </div>
        <div role="radiogroup" aria-label={t("settings.submissionBehavior")} className="settings-theme-options settings-attention-mode-options">
          {SUBMISSION_BEHAVIORS.map((option) => {
            const selected = submissionBehavior === option.id;
            return (
              <label key={option.id} className="settings-theme-option">
                <input
                  type="radio"
                  name="submission-behavior"
                  value={option.id}
                  checked={selected}
                  onChange={() => setSubmissionBehavior(option.id)}
                  className="sr-only"
                />
                <span className="settings-attention-mode-icon" aria-hidden="true">{option.icon}</span>
                <span className="settings-theme-option-label">{t(option.label)}</span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.notifications")}</h3>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.completionNotifications")}</span>
            <div className="settings-chat-option-actions">
              <ConfigButton variant="ghost" size="small" onClick={() => { void notifications.sendTestNotification(); }}>{t("settings.sendTestNotification")}</ConfigButton>
              <ConfigSwitch checked={notifications.enabled} label={t("settings.completionNotifications")} onChange={() => void notifications.toggle()} />
            </div>
          </div>
          <p className="settings-general-description">{t("settings.completionNotificationsDescription")}</p>
          {notifications.status && <p role="status" className="settings-general-error">{notifications.status}</p>}
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.notificationSound")}</span>
            <div className="settings-chat-option-actions">
              <ConfigButton variant="ghost" size="small" onClick={() => { void audio.previewSound().then((ok) => setAudioBlocked(!ok)); }}>{t("settings.previewSound")}</ConfigButton>
              <ConfigSwitch checked={audio.soundEnabled} label={t("settings.notificationSound")} onChange={audio.onSoundToggle} />
            </div>
          </div>
          {audioBlocked && <p role="status" className="settings-general-error">{t("settings.audioBlocked")}</p>}
        </div>
      </section>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.diagnostics")}</h3>
        <p className="settings-general-description">{t("settings.debugLoggingDescription")}</p>
        <div className="settings-chat-options">
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.debugLogging")}</span>
            <ConfigSwitch
              checked={debugLogging}
              label={t("settings.debugLogging")}
              onChange={(next) => {
                setDebugLogging(next);
                setDeveloperProbesEnabled(next);
                void fetch("/api/tools/settings", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ debugLogging: next }),
                }).catch(() => {});
              }}
            />
          </div>
          <div className="settings-chat-option settings-chat-switch-option">
            <span>{t("settings.logs")}</span>
            <div className="settings-chat-option-actions">
              <ConfigButton variant="ghost" size="small" onClick={() => {
                setLogStatus("");
                void saveAndOpenAppLog().catch(() => setLogStatus(t("settings.openLogFailed")));
              }}>{t("settings.openLog")}</ConfigButton>
              <ConfigButton variant="ghost" size="small" onClick={() => {
                setLogStatus("");
                void invoke("open_devtools").catch(() => setLogStatus(t("settings.openDevtoolsFailed")));
              }}>{t("settings.openDevtools")}</ConfigButton>
            </div>
          </div>
        </div>
        {logStatus && <p role="status" className="settings-general-error">{logStatus}</p>}
      </section>

      <McpSettings />
      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("common.language")}</h3>
        <div role="radiogroup" aria-label={t("common.language")} className="settings-language-options">
          {supportedLocales.map((plugin) => {
            const selected = locale === plugin.id;
            return (
              <button key={plugin.id} type="button" role="radio" aria-checked={selected} onClick={() => setLocale(plugin.id as typeof locale)} className="settings-language-option">
                <span className="settings-language-radio">{selected && <span className="settings-language-radio-dot" />}</span>
                <span className="settings-language-label">{plugin.label}</span>
                <span className="settings-language-code">{plugin.id}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function SettingsPanel({ initialSection, onClose }: Props) {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>(
    SETTINGS_SECTION_VALUES.includes(initialSection as SettingsSection) ? initialSection : "general"
  );
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(() => new Set([section]));
  const sections: { id: SettingsSection; label: string }[] = [
    { id: "general", label: t("settings.general") },
    { id: "terminal", label: t("settings.terminal") },
    { id: "remote-hosts", label: t("machines.settings") },
    { id: "external-sessions", label: t("settings.externalSessions") },
  ];

  useEffect(() => setLastSettingsSection(section), [section]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const activateSection = (nextSection: SettingsSection) => {
    setMountedSections((current) => new Set(current).add(nextSection));
    setSection(nextSection);
    setLastSettingsSection(nextSection);
  };

  const sectionHost = (id: SettingsSection, content: ReactNode) => mountedSections.has(id) ? (
    <div key={id} hidden={section !== id} className={`settings-section-host${id !== "remote-hosts" ? " is-general" : ""}`}>
      {content}
    </div>
  ) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label={t("settings.title")} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} className="settings-dialog-backdrop">
      <div className="settings-dialog-surface">
        <div className="settings-dialog-header">
          <div className="settings-dialog-brand">
            <span className="settings-dialog-mark"><QueLogo /></span>
            <span><strong>Que</strong><small className="settings-dialog-title">{t("settings.title")}</small></span>
          </div>
          <select aria-label={t("settings.title")} value={section} onChange={(event) => activateSection(event.target.value as SettingsSection)} className="settings-mobile-section-picker">
            {sections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <nav aria-label={t("settings.title")} className="settings-section-tabs">
            {sections.map((item) => (
              <button key={item.id} type="button" className="settings-section-tab" aria-current={section === item.id ? "page" : undefined} onClick={() => activateSection(item.id)}>
                <SettingsSectionIcon section={item.id} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <button type="button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")} className="config-close-button settings-dialog-close">×</button>
        </div>
        <main className="settings-dialog-main">
          {sectionHost("remote-hosts", <RemoteHostsSettings />)}
          {sectionHost("external-sessions", <ExternalSessionsSettings />)}
          {sectionHost("general", <GeneralSettings />)}
          {sectionHost("terminal", <TerminalSettings />)}
        </main>
      </div>
    </div>
  );
}
