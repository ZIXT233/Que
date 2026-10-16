import React from "react";
import { startSettingsSync } from "./lib/settings-sync";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { CardQueueShell } from "./components/CardQueueShell";
import { DesktopChrome } from "./components/DesktopChrome";
import { I18nProvider } from "./hooks/useI18n";
import { openDetachedCardWindow } from "./lib/card-window";
import type { QueDesktop } from "./lib/desktop";
import { setDeveloperProbesEnabled } from "./lib/developer-probes";
import { installFrontendLogBridge } from "./lib/app-log";
import { installApiInterceptor, setApiAccess } from "./lib/http";
import "./styles/globals.css";
import "./styles/settings.css";
import "./styles/card-queue.css";

function installDesktopBridge() {
  const desktop: QueDesktop = {
    storage: window.localStorage,
    platform: navigator.userAgent.includes("Mac") ? "darwin" : navigator.userAgent.includes("Win") ? "win32" : "linux",
    owner: crypto.randomUUID(),
    writeClipboardText: async (text) => {
      try {
        await writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    openCard: (cardId) => openDetachedCardWindow(cardId),
    focus: () => window.focus(),
    openNotification: (url) => {
      window.dispatchEvent(new CustomEvent("que:notification-click", { detail: { url } }));
    },
    requestNotifications: async () => {
      try {
        const granted = await invoke<boolean>("request_notification_permission");
        return granted ? "granted" : "denied";
      } catch {
        if (await isPermissionGranted()) return "granted";
        return requestPermission();
      }
    },
    openNotificationSettings: async () => {
      // The Rust command bypasses the opener plugin's frontend URL scope,
      // which rejects system schemes like ms-settings:.
      try {
        await invoke("open_notification_settings");
        return true;
      } catch {
        return false;
      }
    },
  };
  window.queDesktop = desktop;
  document.documentElement.classList.add("que-desktop");
  document.documentElement.dataset.desktopPlatform = desktop.platform;
}

async function boot() {
  installDesktopBridge();
  const { base, token } = await invoke<{ base: string; token: string }>("api_access");
  setApiAccess(base, token);
  installApiInterceptor();
  installFrontendLogBridge();
  await startSettingsSync();
  window.__QUE_API_BASE__ = base;
  try {
    const response = await fetch("/api/tools/settings");
    const data = await response.json() as { developerProbes?: boolean; debugLogging?: boolean };
    setDeveloperProbesEnabled(!!(data.debugLogging ?? data.developerProbes));
  } catch {
    /* Keep the Vite default until settings load. */
  }
  try {
    // Whether local sessions must keep the Campbell canvas (inbox ConPTY
    // fallback). Resolved before the first terminal renders to avoid a flip.
    const response = await fetch("/api/terminal-theme");
    const data = await response.json() as { conptyFallback?: boolean; windowsBuild?: number };
    if (data.conptyFallback) document.documentElement.dataset.conptyFallback = "true";
    if (typeof data.windowsBuild === "number") document.documentElement.dataset.windowsBuild = String(data.windowsBuild);
  } catch {
    /* Default to the relaxed (theme-following) canvas. */
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <I18nProvider>
        <DesktopChrome />
        <CardQueueShell />
      </I18nProvider>
    </React.StrictMode>,
  );
}

void boot();
