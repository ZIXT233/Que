import { desktopBridge } from "./desktop";

const CARD_ID = /^[a-zA-Z0-9-]{1,100}$/;
const CARD_RETURN_EVENT = "que:card-return";

// Send intent before releasing the lease: the main window can destroy the
// detached WebView as soon as it observes release, before its next await resumes.
export async function notifyCardReturn(cardId: string, cancel = false) {
  if (!CARD_ID.test(cardId) || !isDesktopApp()) return;
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("main", CARD_RETURN_EVENT, { cardId, cancel });
}

export async function listenCardReturn(onReturn: (cardId: string, cancel: boolean) => void) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().listen<{ cardId: string; cancel?: boolean }>(CARD_RETURN_EVENT, ({ payload }) => {
    if (typeof payload?.cardId === "string" && CARD_ID.test(payload.cardId)) onReturn(payload.cardId, !!payload.cancel);
  });
}

export function cardWindowLabel(cardId: string) {
  return `card-${cardId}`;
}

export async function openDetachedCardWindow(cardId: string): Promise<boolean> {
  if (!CARD_ID.test(cardId)) return false;
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  type BackgroundThrottlingPolicy = import("@tauri-apps/api/window").BackgroundThrottlingPolicy;
  const label = cardWindowLabel(cardId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.unminimize();
    await existing.show();
    await existing.setFocus();
    return true;
  }
  const webview = new WebviewWindow(label, {
    url: `/?card=${encodeURIComponent(cardId)}`,
    title: "Que",
    width: 1200,
    height: 900,
    minWidth: 720,
    minHeight: 540,
    hiddenTitle: true,
    titleBarStyle: "overlay",
    trafficLightPosition: new LogicalPosition(24, 25),
    // Windows/Linux drop the native frame too; in-app controls render via DesktopChrome.
    ...(desktopBridge()?.platform !== "darwin" ? { decorations: false } : {}),
    backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
    focus: true,
  });
  return await new Promise((resolve) => {
    void webview.once("tauri://created", () => resolve(true));
    void webview.once("tauri://error", () => resolve(false));
  });
}

export async function focusMainWindow() {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const main = await WebviewWindow.getByLabel("main");
  if (!main) return;
  await main.unminimize();
  await main.show();
  await main.setFocus();
}

export async function closeCurrentCardWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().destroy();
}

export async function destroyCardWindow(cardId: string) {
  if (!CARD_ID.test(cardId)) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(cardWindowLabel(cardId));
  if (existing) await existing.destroy();
}

export async function setCurrentWindowTitle(title: string) {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

export function isDesktopApp() {
  return !!desktopBridge();
}
