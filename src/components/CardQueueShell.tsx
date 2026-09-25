"use client";

import { persistentStorage } from "../lib/persistent-storage.ts";

import { cardTitle as harnessCardTitle } from "@/lib/harness/card-title";
import { harnessName, setExtensionCatalog, type HarnessCatalogEntry } from "@/lib/harness/catalog";
import { harnessErrorText } from "@/lib/harness/errors";
import { ScoreChipTooltip } from "./ScoreChipTooltip";
import { useI18n } from "@/hooks/useI18n";

import { UrgentCallDialog } from "./UrgentCallDialog";
import { hasUrgentCall } from "@/lib/urgent-call";
import { PriorityBadge } from "./PriorityBadge";
import { ScoreFormulaPopover } from "./ScoreFormulaPopover";
import { tagColor } from "@/lib/tag-color";
import { THEME_OPTIONS } from "@/lib/theme";
import { DEFAULT_TURN_TAGS, scoreCard, sortedQueue, resolveQueueFocus } from "@/lib/turn-priority";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { HarnessCard } from "./HarnessCard";
import { CardNicknameEditor } from "./CardNicknameEditor";
import { nicknameHue } from "@/lib/card-nickname";
import { VSCodeButton } from "./VSCodeButton";
import { PersistentTerminalProvider } from "./PersistentTerminalViews";
import { SettingsPanel } from "./SettingsPanel";
import { QUE_REPO_URL, releaseUrl, useAppUpdate } from "@/hooks/useAppUpdate";
import { openUrl } from "@tauri-apps/plugin-opener";
import { McpApprovals } from "./McpApprovals";
import { useQueueScoreClock } from "@/hooks/useQueueScoreClock";
import { completedCards } from "@/lib/card-completion";
import { useCompletionNotifications } from "@/hooks/useCompletionNotifications";
import { useCardQueue } from "@/hooks/useCardQueue";
import { useTheme } from "@/hooks/useTheme";
import { WorkspacePicker, WorkspaceForm } from "./WorkspacePicker";
import { WorkspaceMachineIcon } from "./WorkspaceMachineIcon";
import { ThemeIcon } from "./ThemeIcon";
import { LanguageIcon } from "./LanguageIcon";
import { CardTransfers } from "./CardTransfers";
import { CardInspectionOverlay } from "./CardInspectionOverlay";
import { CardDeck } from "./CardDeck";
import { Icon } from "./QueueIcon";
import { QueLogo, QueMark } from "./QueLogo";
import { ExternalSessionCard } from "./ExternalNoticeStack";
import { CardQueueMinimap } from "./CardQueueMinimap";
import { CardQuickSearch, type CardQuickSearchItem } from "./CardQuickSearch";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { disposeCardSideTerminals, disposeInactiveCardSideTerminals, type RemoteShellTarget } from "@/lib/card-side-terminals";
import { CardSideTerminal, CardWorkspace, SideTerminalButton } from "./CardSideTerminal";
import { DetachedCardTools, type DetachedCardLayoutControls } from "./DetachedCardTools";
import { useAudio } from "@/hooks/useAudio";
import { useAttentionMode } from "@/hooks/useAttentionMode";
import { useSubmissionBehavior } from "@/hooks/useSubmissionBehavior";
import { ATTENTION_MODES, shouldQuietRearQueueArrival, type AttentionMode } from "@/lib/attention-mode";
import { QUEUE_TOAST_EVENT } from "@/lib/queue-toast";
import { latestAssistantReply, queueArrivalSide } from "@/lib/queue-arrival";
import { QueueArrivalPreview, type QueueArrivalNotice } from "./QueueArrivalPreview";
import { ErrorDialog } from "./ErrorDialog";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { cardWindowLabel, closeCurrentCardWindow, destroyCardWindow, focusMainWindow, isDesktopApp, setCurrentWindowTitle } from "@/lib/card-window";
import { desktopBridge } from "@/lib/desktop";
import { externalNoticeKey, externalNoticeTitle, externalWorkingNotices, newExternalNotices, startableHarnessCards, toExternalCard, type QueueCard, type QueueWorkspace } from "@/lib/card-queue";
import type { RemoteHost } from "@/lib/remote-hosts";
import type { SessionInfo } from "@/lib/types";

const cardTitle = (card: QueueCard, workspaceName: string | undefined, fallback: string) => harnessCardTitle(card.harness, workspaceName, fallback);
const URGENT_ALERTS_KEY = "que:urgent-alerts";
const REMIND_OPTIONS = [
  { minutes: 15, labelKey: "queue.15分钟" },
  { minutes: 60, labelKey: "queue.1小时" },
  { minutes: 180, labelKey: "queue.3小时" },
  { minutes: 480, labelKey: "queue.8小时" },
  { minutes: 1440, labelKey: "queue.24小时" },
] as const;
/** Compact language-neutral countdown, e.g. "12m", "3h 05m", "1d 6h". */
const formatRemainder = (ms: number) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
const cardTurnKey = (card: QueueCard) => JSON.stringify([
  card.id,
  card.turnKey ?? ["legacy", card.session?.modified, card.session?.messageCount, card.readyAt],
]);
const projectOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

const openDetachedCardTab = async (cardId: string) => {
  const desktop = desktopBridge();
  if (desktop?.openCard) {
    const opened = await desktop.openCard(cardId);
    return opened !== false;
  }
  const name = `card-${cardId}`;
  const targetUrl = new URL("/", window.location.href);
  targetUrl.searchParams.set("card", cardId);
  // Passing the URL to window.open() navigates an existing named tab again.
  // Open/reuse it without a URL first so an already-correct card only gets focus.
  const tab = window.open("", name);
  if (!tab) return null;

  let alreadyOpen = false;
  try {
    const current = new URL(tab.location.href);
    alreadyOpen = current.origin === targetUrl.origin
      && current.pathname === targetUrl.pathname
      && current.searchParams.get("card") === cardId;
  } catch {
    // A same-named tab may have navigated elsewhere; it can still be sent back.
  }
  if (!alreadyOpen) tab.location.replace(targetUrl.href);
  tab.focus();
  return tab;
};

export function CardQueueShell() {
  return <PersistentTerminalProvider><CardQueueShellContent /></PersistentTerminalProvider>;
}

function CardQueueShellContent() {
  const [extensionHarnesses, setExtensionHarnesses] = useState<HarnessCatalogEntry[]>([]);
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const response = await fetch("/api/extensions/harnesses");
        if (!response.ok) return;
        const body = await response.json() as { harnesses?: Array<{ id: string; name: string; description?: string; iconDataUrl?: string }> };
        if (!mounted) return;
        const entries = (body.harnesses ?? []).map(item => ({ id: item.id, name: item.name, description: item.description || "", iconId: item.id, iconDataUrl: item.iconDataUrl, extension: true }));
        setExtensionCatalog(entries);
        setExtensionHarnesses(entries);
      } catch { /* The built-in harnesses remain available. */ }
    };
    void load();
    // Extension discovery starts a Node helper; focus can recur when its
    // console closes on Windows, so do not use focus as a refresh trigger.
    return () => { mounted = false; };
  }, []);
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const detachedId = params.get("card");
  const appUpdate = useAppUpdate(!detachedId);
  const requestedSessionId = params.get("session");
  const requestedAttentionId = params.get("attention");
  const { queue, defaultCwd, error: connectionError, refresh, act } = useCardQueue();
  const notifications = useCompletionNotifications(queue);
  const { mode: attentionMode, setMode: setAttentionMode } = useAttentionMode();
  const { mode: submissionBehavior } = useSubmissionBehavior();
  const { soundEnabled, onSoundToggle, unlockAudio, playDoneSound, playQueueArrivalSound } = useAudio();
  const audio = useMemo(() => ({ soundEnabled, onSoundToggle, playDoneSound, unlockAudio }), [soundEnabled, onSoundToggle, playDoneSound, unlockAudio]);
  const previousSoundCards = useRef<QueueCard[] | null>(null);
  // External notices are not cards, so their arrivals are tracked by id.
  const previousExternalNotices = useRef<string[] | null>(null);
  // Both the management surface and detached tabs follow cross-tab changes.
  const { preference, setThemePreference } = useTheme();
  const attentionOption = ATTENTION_MODES.find((option) => option.id === attentionMode) ?? ATTENTION_MODES[0];
  useViewportHeight();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectionLeaving, setInspectionLeaving] = useState<{ id: string; to: "deck" | "sidebar" } | null>(null);
  // Keep-in-view mode: a card that just joined the Working list stays on screen here.
  const [watching, setWatching] = useState<string | null>(null);
  const watchingRef = useRef<string | null>(null);
  watchingRef.current = watching;
  const stageRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [workspaceThenCreate, setWorkspaceThenCreate] = useState(false);
  const [workspaceFormEntry, setWorkspaceFormEntry] = useState<"local" | RemoteHost>("local");
  const [history, setHistory] = useState<SessionInfo[] | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [settings, setSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(true);
  const [file, setFile] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<QueueCard | null>(null);
  const [skipArchiveConfirmation, setSkipArchiveConfirmation] = useState(false);
  const [skipArchiveChecked, setSkipArchiveChecked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [deckReset, setDeckReset] = useState(0);
  const deckNavigationRef = useRef<((direction: number) => void) | null>(null);
  const [claimOwner, setClaimOwner] = useState<string | null>(null);
  const [claimError, setClaimError] = useState("");
  const [pendingDetach, setPendingDetach] = useState<Set<string>>(() => new Set());
  const ownerRef = useRef<string | null>(null);
  const leaseGeneration = useRef(0);

  const openedSessionRef = useRef<string | null>(null);
  const [urgentAlerts, setUrgentAlerts] = useState<Set<string> | null>(null);
  const [arrivalNotices, setArrivalNotices] = useState<QueueArrivalNotice[]>([]);
  const [queueToast, setQueueToast] = useState("");
  const queueToastTimer = useRef<number | null>(null);
  const showQueueToast = useCallback((message: string) => {
    if (queueToastTimer.current) window.clearTimeout(queueToastTimer.current);
    setQueueToast(message);
    queueToastTimer.current = window.setTimeout(() => {
      queueToastTimer.current = null;
      setQueueToast("");
    }, 4200);
  }, []);
  useEffect(() => {
    const onToast = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (typeof message === "string" && message) showQueueToast(message);
    };
    window.addEventListener(QUEUE_TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(QUEUE_TOAST_EVENT, onToast);
      if (queueToastTimer.current) window.clearTimeout(queueToastTimer.current);
    };
  }, [showQueueToast]);
  const [focus, setFocus] = useState<{id: string; index: number} | null>(null);
  const [remoteHosts, setRemoteHosts] = useState<RemoteHost[]>([]);
  const refreshRemoteHosts = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/workspace-machines", { signal });
      if (!response.ok) return;
      const hosts: RemoteHost[] = (await response.json()).hosts ?? [];
      setRemoteHosts(hosts.filter((host) => host.source !== "config" || host.visible !== false));
    } catch { /* Keep the last host list when refresh is interrupted. */ }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refreshRemoteHosts(controller.signal);
    const refresh = () => void refreshRemoteHosts();
    window.addEventListener("que-remote-hosts-changed", refresh);
    return () => { controller.abort(); window.removeEventListener("que-remote-hosts-changed", refresh); };
  }, [refreshRemoteHosts]);
  const cards = queue?.cards ?? [];
  useEffect(() => {
    document.documentElement.classList.toggle("cq-detached-window", !!detachedId);
    return () => document.documentElement.classList.remove("cq-detached-window");
  }, [detachedId]);
  useEffect(() => {
    const live = new Set(cards.filter((card) => card.archivedAt === undefined).map((card) => card.id));
    for (const card of cards) {
      if (!live.has(card.id)) disposeCardSideTerminals(card.id);
    }
    disposeInactiveCardSideTerminals(live);
  }, [cards]);
  const workspaces = queue?.workspaces ?? [];
  const machineSettings = queue?.machineSettings ?? {};
  const titleOf = useCallback((card: QueueCard) => {
    if (card.externalNotice) {
      const raw = externalNoticeTitle(card.externalNotice);
      const prefix = t("external.title");
      return !raw ? prefix : (raw.startsWith(`${prefix} · `) ? raw : `${prefix} · ${raw}`);
    }
    const workspace = workspaces.find((item) => item.id === card.workspaceId);
    return cardTitle(card, workspace?.name, t("queue.新会话"));
  }, [t, workspaces]);
  const remoteHostOf = (workspace?: QueueWorkspace) => workspace?.kind === "ssh" ? remoteHosts.find((host) => host.id === workspace.sshHost) : undefined;
  const hostLabelOf = (workspace?: QueueWorkspace) => workspace?.kind === "ssh" ? remoteHostOf(workspace)?.name || workspace.sshHost || "SSH" : t("machines.local");
  const cardHostLabel = (card: QueueCard, workspace?: QueueWorkspace) => {
    // An external notice has no host of ours; the CLI that reported it is the context.
    if (card.externalNotice) return harnessName(card.externalNotice.kind);
    const host = hostLabelOf(workspace);
    if (!card.harness) return host;
    // Session names go on the card heading, not this host/CLI chip.
    return `${host} · ${harnessName(card.harness.kind)}`;
  };
  const workspaceOf = (card: QueueCard) => workspaces.find((workspace) => workspace.id === card.workspaceId);
  // A remote workspace's side terminals run on its host, in its remote directory:
  // the card's own `cwd` is a local runtime directory when the workspace is remote.
  const remoteShellOf = (workspace?: QueueWorkspace): RemoteShellTarget | undefined =>
    workspace?.kind === "ssh" && workspace.sshHost ? { host: workspace.sshHost, cwd: workspace.cwd } : undefined;
  const displayProject = (card: QueueCard) => workspaceOf(card)?.name || projectOf(card.cwd);
  const working = cards.filter((card) => card.phase === "working" && !card.detached && !pendingDetach.has(card.id) && !card.harness?.setup);
  // Sessions running outside Que have no terminal to inspect, but they are still work
  // in the background, so the sidebar lists them beside the queue's own.
  const externalWorking = externalWorkingNotices(queue?.external);
  const archived = cards.filter((card) => card.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!);
  const historyMatches = archived.filter((card) => card.harness && `${card.nickname ?? ""} ${titleOf(card)} ${card.cwd}`.toLocaleLowerCase().includes(historySearch.toLocaleLowerCase()));
  const detached = cards.filter((card) => card.detached || pendingDetach.has(card.id));
  const reminding = cards.filter((card) => card.remindAt !== undefined && card.archivedAt === undefined).sort((a, b) => (a.remindAt ?? 0) - (b.remindAt ?? 0));
  const remindCount = reminding.length;
  const [remindNow, setRemindNow] = useState(() => Date.now());
  useEffect(() => {
    if (!remindCount) return;
    setRemindNow(Date.now());
    const timer = window.setInterval(() => setRemindNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [remindCount]);
  const scoreTick = useQueueScoreClock(queue);
  useEffect(() => {
    setPendingDetach((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      let changed = false;
      for (const id of current) {
        const card = cards.find((item) => item.id === id);
        if (!card || card.detached) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cards]);
  const pendingDetachRef = useRef(pendingDetach);
  pendingDetachRef.current = pendingDetach;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  useEffect(() => {
    if (pendingDetach.size === 0) return;
    let cancelled = false;
    const checkClosedWindows = async () => {
      if (!isDesktopApp()) return;
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const closed: string[] = [];
      for (const id of pendingDetachRef.current) {
        const card = cardsRef.current.find((item) => item.id === id);
        if (!card || card.detached) continue;
        if (!(await WebviewWindow.getByLabel(cardWindowLabel(id)))) closed.push(id);
      }
      if (cancelled || closed.length === 0) return;
      setPendingDetach((current) => {
        const next = new Set(current);
        let changed = false;
        for (const id of closed) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : current;
      });
    };
    const timer = window.setInterval(() => { void checkClosedWindows(); }, 1500);
    const firstCheck = window.setTimeout(() => { void checkClosedWindows(); }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(firstCheck);
    };
  }, [pendingDetach.size]);
  const priorHarnessPhases = useRef(new Map<string, string>());
  useEffect(() => {
    if (watching !== null && inspecting !== watching) setWatching(null);
  }, [inspecting, watching]);
  const ready = useMemo(() => {
    // The clock invalidates time-dependent ordering even when the API is unchanged.
    void scoreTick;
    const list = queue ? sortedQueue(queue, Date.now(), true) : [];
    const queued = pendingDetach.size === 0 ? list : list.filter((card) => !pendingDetach.has(card.id));
    return queued;
  }, [queue, scoreTick, pendingDetach]);
  const deckIndex = resolveQueueFocus(ready, focus?.id ?? null, focus?.index ?? 0);
  const leaveInspection = useCallback((cardId: string) => {
    setWatching(current => current === cardId ? null : current);
    // A working card morphs back onto its Working button; anything else has
    // no surface to morph onto and closes instantly.
    const card = cards.find((item) => item.id === cardId);
    if (card && card.phase === "working" && !card.detached && !pendingDetach.has(card.id)) setInspectionLeaving({ id: card.id, to: "sidebar" });
    else setInspecting(null);
  }, [cards, pendingDetach]);
  const selectQueueCard = useCallback((index: number) => {
    const card = ready[index];
    if (!card) return;
    if (!inspecting && index === deckIndex) return;
    if (inspecting) leaveInspection(inspecting);
    setFocus({ id: card.id, index });
    setDeckReset((key) => key + 1);
  }, [ready, inspecting, deckIndex, leaveInspection]);
  const cardSearchItems: CardQuickSearchItem[] = [
    ...working.map((card) => ({ card, location: "working" as const })),
    ...externalWorking.map((notice) => ({ card: toExternalCard(notice), location: "working" as const })),
    ...ready.map((card) => ({ card, location: "queue" as const })),
    ...detached.map((card) => ({ card, location: "detached" as const })),
  ].map(({ card, location }) => {
    const workspace = workspaceOf(card);
    return {
      id: card.id,
      title: titleOf(card),
      nickname: card.nickname,
      host: cardHostLabel(card, workspace),
      folder: projectOf(card.cwd),
      remote: workspace?.kind === "ssh",
      tmux: Boolean(workspace?.kind === "ssh" && (card.harness ? card.harness.tmux !== false : true)),
      location,
    };
  });
  // Toolbar vs search box: measure the toolbar's real expanded width (labels
  // forced on) instead of guessing a breakpoint. Priority: keep labels visible
  // and let the centered search box yield width; collapse to icons only when
  // yielding would squeeze the search below a usable minimum.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarCompact, setToolbarCompact] = useState(false);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const toolbar = toolbarRef.current;
    if (!content || !toolbar) return;
    const MIN_SEARCH = 240;
    const GAP = 12;
    const update = () => {
      const search = content.querySelector<HTMLElement>(".cq-card-search");
      // Measure with labels forced on: the compact state shrinks the toolbar
      // and hides exactly the text we need to account for. Both the class add
      // and remove happen in this task, so nothing paints in between.
      toolbar.classList.add("cq-toolbar-expanded");
      const expanded = toolbar.offsetWidth;
      toolbar.classList.remove("cq-toolbar-expanded");
      const width = content.clientWidth;
      // The toolbar is offset from the content edge (left:16px, 14px ≤700px);
      // clearance is measured from its right edge, not the content edge.
      const toolbarLeft = toolbar.offsetLeft;
      const clearance = toolbarLeft + expanded + GAP;
      // Decide from stable quantities only (content width + measured expanded
      // width), never from the search box's current width — reading the
      // yielded width made the clear/yield decisions self-referential and let
      // them deadlock in the overlapped state.
      const baseWidth = Math.min(460, width - 360); // search box with no reservation
      const baseLeft = (width - baseWidth) / 2;
      const yielded = Math.min(460, width - 2 * clearance);
      const compact = !search || yielded < MIN_SEARCH;
      if (compact) {
        content.style.removeProperty("--cq-search-width");
        setToolbarCompact(true);
        return;
      }
      if (clearance <= baseLeft) content.style.removeProperty("--cq-search-width");
      else content.style.setProperty("--cq-search-width", `${yielded}px`);
      setToolbarCompact(false);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(content);
    observer.observe(toolbar);
    return () => {
      observer.disconnect();
      content.style.removeProperty("--cq-search-width");
    };
  }, [detachedId, cardSearchItems.length, t]);
  const tags = queue?.turnTagDefinitions ?? DEFAULT_TURN_TAGS;
  const inspected = cards.find((card) => card.id === inspecting && !card.detached && !pendingDetach.has(card.id))
    ?? (inspecting?.startsWith("external:")
      ? queue?.external?.filter((n) => `external:${n.id}` === inspecting).map(toExternalCard)[0]
      : undefined);
  const active = detachedId ? cards.find((card) => card.id === detachedId) : inspected || ready[Math.min(deckIndex, Math.max(0, ready.length - 1))];
  const detachedWindowTitle = detachedId && active
    ? `${active.harness ? `${harnessName(active.harness.kind)} · ` : ""}${titleOf(active)}`
    : null;
  useEffect(() => {
    if (!detachedWindowTitle) return;
    const previousTitle = document.title;
    document.title = detachedWindowTitle;
    if (isDesktopApp()) void setCurrentWindowTitle(detachedWindowTitle);
    return () => { document.title = previousTitle; };
  }, [detachedWindowTitle]);
  useEffect(() => {
    if (!active || inspecting || detachedId) return;
    setFocus(current => current?.id === active.id && current.index === deckIndex ? current : {id:active.id,index:deckIndex});
  }, [active, deckIndex, inspecting, detachedId]); // Keep the next reader stable after explicit actions.

  // Working cards leave the queue. Keep-in-view uses an inspection slot;
  // PersistentTerminalProvider retains the actual terminal across that move.
  if (submissionBehavior === "keep-in-view" && !detachedId && queue) {
    for (const card of cards) {
      if (card.phase !== "working" || card.detached || pendingDetach.has(card.id) || card.manualPlacement?.background) continue;
      const prior = priorHarnessPhases.current.get(card.id);
      if (prior === undefined || prior === "working") continue;
      if (inspecting === card.id) {
        if (watchingRef.current !== card.id) setWatching(card.id);
      } else if (inspecting === null && card.id === focus?.id) {
        setInspecting(card.id);
        setWatching(card.id);
      }
      break;
    }
  }
  useEffect(() => {
    if (!queue) return;
    for (const card of queue.cards) {
      const previous = priorHarnessPhases.current.get(card.id);
      if (card.harness && previous && previous !== card.phase) {
        if (card.phase === "working") {
          // The terminal view owns focus reporting. Working does not mean
          // unfocused when the user is watching it in an inspection slot.
          // Keep-in-view mode keeps the card on screen while it joins the Working
          // list; the phase -> working effect skips clearing inspecting for it.
          if (watchingRef.current !== card.id && inspecting === card.id) setInspectionLeaving({ id: card.id, to: "sidebar" });
        } else if (previous === "working" && !card.detached) {
          // Back in the queue while its working view is open: focus where it
          // landed, then let the overlay morph the real card onto that deck
          // layer instead of dropping one view and mounting another.
          if (inspecting === card.id && !activeCardRef.current.detached) {
            const index = ready.findIndex((item) => item.id === card.id);
            if (index >= 0) {
              setFocus({ id: card.id, index });
              setInspectionLeaving({ id: card.id, to: "deck" });
            } else setInspecting(null);
            setDeckReset((key) => key + 1);
          }
        }
      }
    }
    priorHarnessPhases.current = new Map(queue.cards.map(card => [card.id, card.phase]));
  }, [queue]);
  // The leave morph is tied to the card it started on; switching or clearing
  // the inspection drops any stale request.
  useEffect(() => {
    if (inspectionLeaving && (!inspected || inspectionLeaving.id !== inspecting)) setInspectionLeaving(null);
  }, [inspecting, inspected, inspectionLeaving]);

  // Stage sizing: prefer a 10:9 (height:width) card — width follows the
  // flex-determined stage height when the content area is wide enough to keep
  // side margins — but never narrower than 50% of the content area (which
  // also caps it at the full content width on narrow windows). Detached
  // windows stay fluid.
  const [stageWidth, setStageWidth] = useState<number | null>(null);
  useEffect(() => {
    if (detachedId) { setStageWidth(null); return; }
    const stage = stageRef.current;
    const main = stage?.parentElement;
    if (!stage || !main) return;
    const measure = () => {
      const mainStyle = getComputedStyle(main);
      const inner = main.clientWidth - parseFloat(mainStyle.paddingLeft) - parseFloat(mainStyle.paddingRight);
      const height = stage.getBoundingClientRect().height;
      if (!(inner > 0) || !(height > 0)) return;
      const width = Math.round(Math.max(inner * 0.5, Math.min(height * 0.9, inner)));
      setStageWidth(current => current === width ? current : width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(main);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [detachedId]);

  const resolvedAttention = useRef<string | null>(null);
  const focusNotificationCard = useCallback((id: string) => {
    if (detachedId) return false;
    const index = ready.findIndex(card => card.id === id);
    // External notices live in the overlay, never in queue.json: the deck is the
    // only place they exist, and focusing one is just focusing that deck position.
    const target = queue?.cards.find(card => card.id === id) ?? (index >= 0 ? ready[index] : undefined);
    if (!target) return false;
    if (target.detached || pendingDetach.has(target.id)) {
      openDetachedCardTab(target.id);
      return true;
    }
    setHistory(null);
    setInspecting(index < 0 ? id : null);
    setFocus({ id, index: Math.max(0, index) });
    setDeckReset(key => key + 1);
    return true;
  }, [queue, detachedId, ready, pendingDetach]);
  useEffect(() => {
    if (requestedAttentionId && resolvedAttention.current !== requestedAttentionId && focusNotificationCard(requestedAttentionId)) {
      resolvedAttention.current = requestedAttentionId;
    }
  }, [requestedAttentionId, focusNotificationCard]);

  const activeCardRef = useRef<{ id?: string; detached: boolean }>({ detached: false });
  activeCardRef.current = { id: active?.id, detached: !!detachedId };
  const finishCard = useCallback((cardId: string) => {
    // An accepted action may finish after the user has opened a different card.
    if (activeCardRef.current.detached || activeCardRef.current.id !== cardId) return;
    leaveInspection(cardId);
    setFocus(null);
    setDeckReset((key) => key + 1);
  }, [leaveInspection]);
  const advanceToNextCard = useCallback((cardId: string) => {
    const currentIndex = ready.findIndex((card) => card.id === cardId);
    const next = currentIndex >= 0 && ready.length > 1
      ? ready[(currentIndex + 1) % ready.length]
      : undefined;
    leaveInspection(cardId);
    setFocus(next ? { id: next.id, index: ready.indexOf(next) } : null);
    setDeckReset((key) => key + 1);
  }, [ready, leaveInspection]);

  const canShowDetached = !detachedId || (claimOwner && active?.detached?.owner === claimOwner);
  useEffect(() => {
    if (!queue) return;
    const completed = completedCards(previousSoundCards.current, queue.cards);
    previousSoundCards.current = queue.cards;
    // External notices are not queue cards, so `completedCards` cannot see them:
    // the ids that appeared since the previous snapshot announce themselves.
    const arrived = newExternalNotices(previousExternalNotices.current, queue.external);
    previousExternalNotices.current = (queue.external ?? []).map(externalNoticeKey);
    if (detachedId) return;
    const orderedIds = ready.map((card) => card.id);
    const focusedId = focus?.id ?? active?.id;
    // One banner for both sources: that is the whole point of the overlay reusing
    // the deck, so a notice arrives exactly like a card coming back.
    const announce = (key: string, cardId: string, title: string, reply: string) => {
      const side = queueArrivalSide(orderedIds, focusedId, cardId);
      if (!side) return false;
      const quiet = shouldQuietRearQueueArrival(attentionMode, side, document.visibilityState);
      setArrivalNotices((current) => current.some((notice) => notice.key === key) ? current : [...current, {
        key, cardId, side, quiet, title, reply,
      }]);
      return true;
    };
    for (const card of completed) {
      if (card.detached) continue;
      const key = cardTurnKey(card);
      const announced = announce(key, card.id, titleOf(card), card.harness?.replyPreview
        || (card.harness?.kind === "shell" ? t("harness.commandDone") : t("queue.回复已完成")));
      if (!announced || !card.session) continue;
      void fetch(`/api/sessions/${encodeURIComponent(card.session.id)}?tail=8&deferThinking=1&deferMedia=1`, { cache: "no-store" })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("preview unavailable")))
        .then((data: { context?: { messages?: unknown[] } }) => {
          const reply = latestAssistantReply(data.context?.messages ?? []);
          if (!reply) return;
          setArrivalNotices((current) => current.map((notice) => notice.key === key ? { ...notice, reply } : notice));
        })
        .catch(() => {});
    }
    for (const notice of arrived) {
      // Only the ones that want a human announce themselves; a session that went back to
      // work just takes its place in the sidebar.
      if (notice.state !== "attention") continue;
      // The card shows the reply in full; the banner is a two-line glimpse of it.
      const reply = (notice.preview ?? notice.prompt ?? t("external.finished"))
        .replace(/\s+/g, " ").trim().slice(0, 180);
      announce(`external:${externalNoticeKey(notice)}`, `external:${notice.id}`,
        `${harnessName(notice.kind)} · ${externalNoticeTitle(notice) ?? t("external.title")}`,
        reply);
    }
  }, [queue, detachedId, ready, focus?.id, active?.id, attentionMode, t, titleOf]);

  // Replies can arrive after the completion hook. Enrich only the same turn's notice.
  useEffect(() => {
    if (!queue) return;
    setArrivalNotices(current => {
      let changed = false;
      const next = current.map(notice => {
        const card = queue.cards.find(item => item.id === notice.cardId);
        const reply = card?.harness?.replyPreview;
        if (!card || card.phase !== "attention" || cardTurnKey(card) !== notice.key || !reply || reply === notice.reply) return notice;
        changed = true;
        return { ...notice, reply };
      });
      return changed ? next : current;
    });
  }, [queue]);

  const arrivalNotice = arrivalNotices[0];
  const arrivalNoticeKey = arrivalNotice?.key;
  const arrivalNoticeSide = arrivalNotice?.side;
  const arrivalNoticeQuiet = arrivalNotice?.quiet === true;
  useEffect(() => {
    if (!arrivalNoticeKey || !arrivalNoticeSide) return;
    if (!arrivalNoticeQuiet) playQueueArrivalSound(arrivalNoticeSide);
    const timer = window.setTimeout(() => setArrivalNotices((current) => current.slice(1)), 5000);
    return () => window.clearTimeout(timer);
  }, [arrivalNoticeKey, arrivalNoticeSide, arrivalNoticeQuiet, playQueueArrivalSound]);

  const urgentCard = urgentAlerts ? cards.filter((card) => card.phase === "attention" && card.archivedAt === undefined
    && (detachedId ? card.id === detachedId && canShowDetached : !card.detached)
    && hasUrgentCall(card) && !urgentAlerts.has(cardTurnKey(card)))
    .sort((a, b) => (a.readyAt ?? a.createdAt) - (b.readyAt ?? b.createdAt))[0] : undefined;
  const dismissUrgent = () => {
    if (!urgentCard) return;
    const next = new Set(urgentAlerts ?? []);
    next.add(cardTurnKey(urgentCard));
    setUrgentAlerts(next);
    try { persistentStorage().setItem(URGENT_ALERTS_KEY, JSON.stringify([...next])); } catch { /* Keep the reminder acknowledged in memory. */ }
  };
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(persistentStorage().getItem(URGENT_ALERTS_KEY) || "[]");
      setUrgentAlerts(new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []));
    } catch { setUrgentAlerts(new Set()); }
  }, []);


  const run = useCallback(async (action: string, data: Record<string, unknown> = {}) => {
    setError("");
    try { return await act(action, data); }
    catch (error) { setError(error); return null; }
  }, [act]);
  const startable = startableHarnessCards(cards);
  const startAllHarnesses = useCallback(async () => {
    const errors: string[] = [];
    for (const card of startableHarnessCards(cards)) {
      const harness = card.harness;
      if (!harness) continue;
      try {
        await act(harness.providerSessionId ? "harness_resume" : "harness_reopen", { id: card.id });
      } catch (error) {
        errors.push(`${titleOf(card)}: ${harnessErrorText(error, t)}`);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }, [act, cards, titleOf, t]);
  const chooseSortMode = useCallback(async (mode: "score" | "fifo") => {
    if (!queue || busy || queue.sortMode === mode) return;
    setBusy(true);
    if (active) setFocus({ id: active.id, index: deckIndex });
    try {
      const result = await run("sort_mode", { mode });
      if (result) showQueueToast(t(mode === "score" ? "queue.已切换评分排序说明" : "queue.已切换先进先出说明"));
    }
    finally { setBusy(false); }
  }, [active, busy, deckIndex, queue, run, showQueueToast, t]);
  const chooseAttentionMode = useCallback((mode: AttentionMode) => {
    if (mode === attentionMode) return;
    setAttentionMode(mode);
    showQueueToast(t(mode === "focus" ? "queue.已切换专注模式说明" : "queue.已切换日常模式说明"));
  }, [attentionMode, setAttentionMode, showQueueToast, t]);

  useEffect(() => {
    if (!detachedId) return;
    const desktopOwner = (window as Window & { queDesktop?: { owner?: string } }).queDesktop?.owner;
    const owner = ownerRef.current ??= desktopOwner || crypto.randomUUID();
    const generation = ++leaseGeneration.current;
    const stillCurrent = () => leaseGeneration.current === generation;
    let alive = true;
    const release = () => {
      if (desktopOwner) return; // The native window owns its lease across page reloads.
      navigator.sendBeacon("/api/card-queue", new Blob([JSON.stringify({ action: "release", id: detachedId, owner })], { type: "application/json" }));
    };
    const claim = async () => {
      try {
        await act("claim", { id: detachedId, owner });
        if (alive) { setClaimOwner(owner); setClaimError(""); }
        else if (stillCurrent()) release();
      } catch (error) {
        if (alive) setClaimError(error instanceof Error ? error.message : String(error));
      }
    };
    void claim();
    const timer = setInterval(() => { void claim(); }, 20_000);
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", claim);
    let unlistenClose: (() => void) | undefined;
    if (desktopOwner) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        if (!alive) return;
        return getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault();
          try { await act("release", { id: detachedId, owner }); } catch { /* Window is going away either way. */ }
          void focusMainWindow();
          await closeCurrentCardWindow();
        });
      }).then((unlisten) => {
        if (!unlisten) return;
        if (!alive) unlisten();
        else unlistenClose = unlisten;
      }).catch(() => {});
    }
    return () => {
      alive = false;
      clearInterval(timer);
      unlistenClose?.();
      // React Strict Mode replays effects. A replay must not release the new
      // effect's identical lease; an actual unmount must still release it.
      queueMicrotask(() => { if (stillCurrent()) release(); });
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", claim);
    };
  }, [detachedId, act]);
  const hadDetachedLease = useRef(false);
  useEffect(() => {
    if (!detachedId || !claimOwner) return;
    const card = cards.find((item) => item.id === detachedId);
    if (card?.detached?.owner === claimOwner) {
      hadDetachedLease.current = true;
      return;
    }
    if (!hadDetachedLease.current || !isDesktopApp()) return;
    void focusMainWindow();
    void closeCurrentCardWindow();
  }, [cards, claimOwner, detachedId]);
  useEffect(() => {
    if (detachedId || !isDesktopApp()) return;
    const keep = new Set([...pendingDetach, ...cards.filter((card) => card.detached).map((card) => card.id)]);
    for (const card of cards) {
      if (!keep.has(card.id)) void destroyCardWindow(card.id);
    }
  }, [cards, detachedId, pendingDetach]);

  const onAdopt = useCallback((_sessionId: string) => {
    // Que does not host native Pi sessions.
  }, []);
  useEffect(() => {
    if (!requestedSessionId || detachedId || openedSessionRef.current === requestedSessionId) return;
    openedSessionRef.current = requestedSessionId;
    onAdopt(requestedSessionId);
  }, [requestedSessionId, detachedId, onAdopt]);
  useEffect(() => {
    const openFromNotification = (raw: string) => {
      const url = new URL(raw, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const cardId = url.searchParams.get("card");
      if (cardId) { openDetachedCardTab(cardId); return; }
      const attentionId = url.searchParams.get("attention");
      if (attentionId) { focusNotificationCard(attentionId); return; }
      const sessionId = url.searchParams.get("session");
      if (sessionId && !detachedId) onAdopt(sessionId);
    };
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type !== "notification-click" || typeof event.data.url !== "string") return;
      openFromNotification(event.data.url);
    };
    const onDesktopNotification = (event: Event) => {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (typeof url === "string") openFromNotification(url);
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    window.addEventListener("que:notification-click", onDesktopNotification);
    return () => {
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onServiceWorkerMessage);
      window.removeEventListener("que:notification-click", onDesktopNotification);
    };
  }, [detachedId, onAdopt, focusNotificationCard]);
  const remindLater = useCallback(async (card: QueueCard, minutes: number) => {
    if (detachedId) return;
    const result = await run("remind_later", { id: card.id, minutes });
    if (result) showQueueToast(t("queue.已设置稍后提醒", { title: card.nickname || titleOf(card) }));
  }, [detachedId, run, showQueueToast, t, titleOf]);
  const remindBack = useCallback(async (card: QueueCard) => {
    const result = await run("remind_back", { id: card.id });
    if (result) setInspecting(current => current === card.id ? null : current);
    return !!result;
  }, [run]);

  const showNew = useCallback(() => {
    setCreating(true);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || settings || creating || history || detachedId) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || inspecting || addingWorkspace || file || archiveConfirm || urgentCard) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"],[role="spinbutton"],[role="combobox"],[role="menu"],[role="tablist"],[role="dialog"],dialog,summary')) return;
        if (!ready.length) return;
        // Consume native scroll even at the ends; one physical press = one card.
        event.preventDefault();
        if (event.repeat) return;
        const direction = event.key === "ArrowRight" ? 1 : -1;
        deckNavigationRef.current?.(direction);
        return;
      }
      if (event.key === "Escape") { if (inspecting) leaveInspection(inspecting); setFile(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings, creating, history, detachedId, inspecting, addingWorkspace, file, archiveConfirm, urgentCard, ready, leaveInspection]);

  const openHistory = async () => {
    setHistory([]);
    setHistorySearch("");
  };
  const popout = async () => {
    if (!active) return;
    const id = active.id;
    flushSync(() => {
      setPendingDetach((current) => new Set(current).add(id));
      advanceToNextCard(id);
    });
    const tab = await openDetachedCardTab(id);
    if (tab) return;
    setPendingDetach((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setFocus({ id, index: 0 });
    setError(t(isDesktopApp() ? "queue.无法打开独立窗口" : "queue.浏览器拦截了新标签页，请允许本站打开弹出窗口。"));
  };
  const returnToQueue = async () => {
    if (detachedId && claimOwner) await run("release", { id: detachedId, owner: claimOwner });
    if (isDesktopApp()) {
      await focusMainWindow();
      try { await closeCurrentCardWindow(); return; } catch { /* Fall through if destroy is unavailable. */ }
    }
    window.close();
    if (!isDesktopApp()) router.replace("/");
  };

  const renderCardContent = (visibleCard: QueueCard, isFront = true, layout?: DetachedCardLayoutControls) => {
    if (visibleCard.externalNotice) {
      const notice = visibleCard.externalNotice;
      // The chips are the shell's, so a notice is labelled by the same rules as a card.
      return <ExternalSessionCard notice={notice} isFront={isFront}
        host={cardHostLabel(visibleCard)}
        folder={displayProject(visibleCard)}
        directory={notice.cwd ?? ""}
        onSaveWeight={weight => run("external_priority_weight", { id: notice.id, weight })}
        onSnooze={async minutes => {
          const result = await run("snooze_external", { id: notice.id, minutes });
          if (result) {
            showQueueToast(t("queue.已设置稍后提醒", { title: titleOf(visibleCard) }));
            setInspecting(null);
          }
          return result;
        }}
        onDismiss={() => {
          if (inspecting === visibleCard.id) setInspecting(null);
          void run("dismiss_external", { id: notice.id });
        }} />;
    }
    const cardScore = scoreCard(visibleCard, tags);
    const waitMinutes = cardScore.waiting === 99 ? "99+" : cardScore.waiting;
    const workspace = workspaceOf(visibleCard);
    const hostLabel = hostLabelOf(workspace);
    const hostWithHarness = cardHostLabel(visibleCard, workspace);
    const workspaceLabel = workspace?.name || displayProject(visibleCard);
    const remoteHost = remoteHostOf(workspace);
    const remoteAddress = remoteHost ? `${remoteHost.user ? `${remoteHost.user}@` : ""}${remoteHost.hostname}${remoteHost.port && remoteHost.port !== 22 ? `:${remoteHost.port}` : ""}` : hostLabel;
    const isTmux = Boolean(workspace?.kind === "ssh" && (visibleCard.harness ? visibleCard.harness.tmux !== false : true));
    const showScore = !!(visibleCard.session || visibleCard.harness) && queue?.sortMode === "score" && visibleCard.phase === "attention";
    const bringForward = visibleCard.phase === "working";
    const placementLabel = t(bringForward ? "queue.manualForeground" : "queue.manualBackground");
    const placementButton = !detachedId && !visibleCard.detached && visibleCard.harness && !visibleCard.archivedAt
      && (visibleCard.phase === "attention" || bringForward) ? <button
        type="button" className="cq-tools-trigger" title={placementLabel} aria-label={placementLabel}
        disabled={busy || ["exited", "error", "not_running"].includes(visibleCard.harness.state)}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            if (!await run("card_placement", { id: visibleCard.id, background: !bringForward })) return;
            if (!bringForward) {
              setWatching(current => current === visibleCard.id ? null : current);
              finishCard(visibleCard.id);
            }
          } finally { setBusy(false); }
        }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={bringForward ? "M12 19V5m-6 6 6-6 6 6" : "M12 5v14m-6-6 6 6 6-6"} />
        </svg><span>{placementLabel}</span>
      </button> : null;
    const showHeaderMeta = visibleCard.phase !== "attention" || hasUrgentCall(visibleCard) || visibleCard.remindAt !== undefined || !(visibleCard.session || visibleCard.harness);
    const harness = (
              <HarnessCard key={`${visibleCard.id}:${visibleCard.workspaceId}`} card={visibleCard} active={isFront} inQueue={!detachedId && !visibleCard.detached && visibleCard.phase !== "working"} sshHost={workspace?.kind === "ssh" ? workspace.sshHost : undefined} sshHostName={remoteHost?.name ?? workspace?.sshHost} extensionHarnesses={extensionHarnesses} onStartAll={startable.length > 1 ? startAllHarnesses : undefined} onAction={async (action, data) => {
                const result = await act(action, data);
                if (result && action === "harness_start") {
                  setInspecting(null); setFocus({ id: visibleCard.id, index: 0 }); setDeckReset(key => key + 1);
                }
                if (result && action === "harness_close") finishCard(visibleCard.id);
                return !!result;
              }} />
    );
    return (
    <CardSideTerminal key={visibleCard.id} cardId={visibleCard.id} cwd={visibleCard.cwd} remoteShell={remoteShellOf(workspace)} active={isFront} enabled={!layout} saved={visibleCard.sideTerminals} savedOpen={visibleCard.sideTerminalOpen}>
      {({ button: sideButton, panel: sidePanel }) => (
    <article aria-hidden={!isFront} inert={!isFront} className="cq-large-card cq-continuous-card" data-transfer-id={visibleCard.id} data-transfer-zone="deck" data-card-id={visibleCard.id} data-phase={visibleCard.phase} data-working-view={visibleCard.phase === "working"} data-urgent-call={hasUrgentCall(visibleCard)}>
              <div className="cq-card-header">{detachedId && <div className="cq-detached-drag" data-tauri-drag-region aria-hidden="true" />}{layout?.leftToggle}<div className="cq-card-identity"><div className="cq-card-heading"><div className="cq-card-title-split"><h2 title={titleOf(visibleCard)}>{titleOf(visibleCard)}</h2><CardNicknameEditor cardId={visibleCard.id} nickname={visibleCard.nickname} onSave={async nickname => !!(await run("card_nickname", { id: visibleCard.id, nickname }))} /></div>{showHeaderMeta && <div className="cq-card-meta">{visibleCard.phase !== "attention" && <div className="cq-card-state"><i className={visibleCard.phase === "working" ? "cq-dot" : "cq-ready-dot"} />{visibleCard.phase === "draft" ? t("queue.新的思路") : t("queue.WORKING")}</div>}{hasUrgentCall(visibleCard) && <span className="cq-urgent-label" title={t("queue.urgentPriority")}>🚨 Urgent Call</span>}{visibleCard.remindAt !== undefined && <span className="cq-remind-label" title={t("queue.稍后提醒")}>⏰ {t("queue.稍后提醒")} · {formatRemainder((visibleCard.remindAt ?? 0) - remindNow)}</span>}{!(visibleCard.session || visibleCard.harness) && <PriorityBadge weight={visibleCard.priorityWeight ?? 0} enabled={isFront} onSave={weight => run("priority_weight", {id:visibleCard.id,weight})} />}<div className="cq-meta-harness" /></div>}{showScore && <ScoreFormulaPopover label={<><span aria-hidden="true">🧮</span> {t("queue.Score")} {hasUrgentCall(visibleCard) ? "∞" : cardScore.total}</>}>
                <span className="cq-score-operator">=</span>
                <PriorityBadge weight={visibleCard.priorityWeight ?? 0} enabled={isFront} onSave={weight => run("priority_weight", {id:visibleCard.id,weight})} />
                <span className="cq-score-term"><span className="cq-score-operator">+</span><ScoreChipTooltip text={t("queue.等待分钟", { minutes: waitMinutes })}><span className="cq-score-chip cq-score-wait"><span aria-hidden="true">⏳</span> {t("queue.Wait")} <b>{cardScore.waiting}</b></span></ScoreChipTooltip></span>
                {cardScore.tags.map(tag => <span className="cq-score-term" key={tag.name}><span className="cq-score-operator">+</span><ScoreChipTooltip text={tag.description}><span className="cq-score-chip" style={tagColor(tag.name)}>{tag.name} <b>{tag.weight}</b></span></ScoreChipTooltip></span>)}
              </ScoreFormulaPopover>}</div><div className="cq-card-title-row"><div className="cq-title-primary">{workspace?.kind === "ssh" ? <ScoreChipTooltip text={<div className="cq-environment-tooltip"><span><WorkspaceMachineIcon name="remote" size={14} />{hostLabel}{isTmux && <span className="cq-tmux-badge">TMUX</span>}</span><small>{remoteAddress}</small></div>}><span className="cq-title-environment cq-title-host" aria-label={hostWithHarness}><WorkspaceMachineIcon name="remote" size={15} />{isTmux && <span className="cq-tmux-badge">TMUX</span>}<b title={hostWithHarness}>{hostWithHarness}</b></span></ScoreChipTooltip> : <span className="cq-title-environment cq-title-host" aria-label={hostWithHarness}><WorkspaceMachineIcon name="local" size={15} /><b title={hostWithHarness}>{hostWithHarness}</b></span>}<ScoreChipTooltip text={<div className="cq-environment-tooltip"><span><WorkspaceMachineIcon name="folder" size={14} />{workspaceLabel}</span><small>{workspace?.cwd || visibleCard.cwd}</small></div>}><span className="cq-title-environment cq-title-workspace" aria-label={workspaceLabel}><WorkspaceMachineIcon name="folder" size={15} /><b>{workspaceLabel}</b></span></ScoreChipTooltip></div><div className="cq-title-controls"><div className="cq-title-harness" /><div className="cq-title-branches" /><div className="cq-title-actions"><div className="cq-title-tools"><VSCodeButton key={visibleCard.id} cardId={visibleCard.id} />{layout ? <SideTerminalButton pressed={layout.terminalOpen} label={t("queue.sideTerminal")} onClick={layout.toggleTerminal} /> : sideButton}</div>{(placementButton || visibleCard.harness) && <div className="cq-card-more">
                <button type="button" className="cq-tools-trigger" aria-label={t("queue.more")} aria-haspopup="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg><span>{t("queue.more")}</span></button>
                <div className="cq-card-more-popover">{placementButton}<div className="cq-title-logs" /></div>
              </div>}</div></div></div></div>
                <div className="cq-card-actions">
                  {!detachedId && (visibleCard.remindAt !== undefined
                    ? <button className="cq-action-defer" onClick={async () => { if (busy) return; if (await remindBack(visibleCard)) finishCard(visibleCard.id); }} disabled={busy} aria-label={t("queue.放回队列")}><Icon name="undo" /><span className="cq-action-tooltip" role="tooltip">{t("queue.放回队列")}</span></button>
                    : !inspecting && (!!visibleCard.session || !!visibleCard.harness) && visibleCard.phase !== "working" && <div className="cq-remind-menu">
                      <button className="cq-action-defer" aria-label={t("queue.稍后提醒")} aria-haspopup="menu"><Icon name="clock" /></button>
                      <div className="cq-remind-popover" role="menu" aria-label={t("queue.稍后提醒")}>
                        <div className="cq-remind-popover-title" aria-hidden="true">{t("queue.稍后提醒")}</div>
                        {REMIND_OPTIONS.map((option) => <button key={option.minutes} role="menuitem" onClick={(event) => { void remindLater(visibleCard, option.minutes); event.currentTarget.blur(); }}><span>{t(option.labelKey)}</span></button>)}
                      </div>
                    </div>)}
                    {!detachedId && (!!visibleCard.session || !!visibleCard.harness) && <button className="cq-action-popout" onClick={popout} aria-label={t("queue.移出")}><Icon name="maximize" /><span className="cq-action-tooltip" role="tooltip">{t("queue.移出")}</span></button>}
                    {!detachedId && (visibleCard.harness ? visibleCard.archivedAt === undefined && visibleCard.phase !== "working" : !inspecting && visibleCard.phase !== "working") && <button className="cq-action-archive" aria-label={(visibleCard.session || visibleCard.harness) ? t("queue.归档") : t("queue.关闭空白卡片")} onClick={async () => {
                      if (visibleCard.session || visibleCard.harness) {
                      if (busy) return;
                      if (!skipArchiveConfirmation) { setSkipArchiveChecked(false); setArchiveConfirm(visibleCard); return; }
                      setBusy(true);
                      const result = await run("archive", { id: visibleCard.id });
                      setBusy(false);
                      if (result) finishCard(visibleCard.id);
                      return;
                    } const result = await run("remove", { id: visibleCard.id }); if (result) setInspecting(null); }}><Icon name={(visibleCard.session || visibleCard.harness) ? "archive" : "close"} /><span className="cq-action-tooltip" role="tooltip">{(visibleCard.session || visibleCard.harness) ? t("queue.归档") : t("queue.关闭空白卡片")}</span></button>}
                  {detachedId && <button className="cq-action-archive" aria-label={t("queue.Attach")} onClick={() => returnToQueue()}><Icon name="undo" /><span className="cq-action-tooltip" role="tooltip">{t("queue.Attach")}</span></button>}
                </div>
                {layout?.rightToggle}
              </div>
              {layout ? harness : <CardWorkspace side={sidePanel}>{harness}</CardWorkspace>}
            </article>
      )}
    </CardSideTerminal>
    );
  };

  const renderCard = (card: QueueCard, isFront = true) => detachedId ? (
    <DetachedCardTools key={`${card.id}:${card.workspaceId}`} cardId={card.id} cwd={card.cwd} sessionId={card.session?.id ?? card.id} remoteShell={remoteShellOf(workspaceOf(card))} saved={card.sideTerminals} savedOpen={card.sideTerminalOpen} onSettings={(section) => { setSettingsSection(section); setSettings(true); }}>
      {layout => renderCardContent(card, isFront, layout)}
    </DetachedCardTools>
  ) : renderCardContent(card, isFront);

  return <div className={`cq-shell ${detachedId ? "cq-detached" : ""}`} onPointerDownCapture={() => unlockAudio()} onKeyDownCapture={() => unlockAudio()}>
    {notifications.status && <div className="cq-notification-alert" role="alert" aria-live="assertive">
      <span>{notifications.status}</span>
      {notifications.canOpenSystemSettings && <button type="button" onClick={() => void notifications.openSystemSettings()}>{t("settings.openNotificationSettings")}</button>}
      <button type="button" className="cq-notification-alert-close" aria-label={t("queue.关闭")} onClick={notifications.dismissStatus}>×</button>
    </div>}
    {!notifications.status && queueToast && <div className="cq-queue-toast" role="status" aria-live="polite">
      <span>{queueToast}</span>
      <button type="button" aria-label={t("queue.关闭")} onClick={() => setQueueToast("")}>×</button>
    </div>}
    {urgentCard?.urgentCall && <UrgentCallDialog key={cardTurnKey(urgentCard)} title={titleOf(urgentCard)} details={urgentCard.urgentCall}
      onDismiss={dismissUrgent} onRead={() => {
        dismissUrgent();
        setSettings(false); setHistory(null); setFile(null); setCreating(false); setAddingWorkspace(false);
        setArchiveConfirm(null);
        if (!detachedId) {
          const index = ready.findIndex((card) => card.id === urgentCard.id);
          if (index >= 0) { if (inspecting) leaveInspection(inspecting); setFocus({ id: urgentCard.id, index }); setDeckReset((key) => key + 1); }
          else setInspecting(urgentCard.id);
        }
      }} />}

    {!detachedId && <McpApprovals />}
    <CardTransfers
      order={ready.map((card) => card.id)}
      locations={detachedId ? {} : Object.fromEntries(cards.filter((card) => !card.detached && !pendingDetach.has(card.id) && card.archivedAt === undefined).map((card) => [card.id, card.phase === "working" ? (inspecting === card.id ? "inspection" : "sidebar") : "deck"]))}
      attentionMode={attentionMode}
      focusedId={focus?.id ?? active?.id}
    >
    <div className="cq-layout" inert={!!inspected && !detachedId}>
      {!detachedId && <aside className="cq-sidebar">
        <div className="cq-sidebar-brand"><a className="cq-brand" href={QUE_REPO_URL} aria-label="Que GitHub" title="GitHub" onClick={(event) => { event.preventDefault(); void openUrl(QUE_REPO_URL).catch(() => showQueueToast(t("settings.aboutOpenFailed"))); }}><span className="cq-logo"><QueLogo /></span>Que</a><button className="cq-notifications" onClick={() => void notifications.toggle()} aria-pressed={notifications.enabled} aria-label={notifications.enabled ? "系统完成通知：已开启" : "开启系统完成通知"} title={notifications.enabled ? "系统完成通知已开启，点击关闭" : "开启系统完成通知"}><Icon name={notifications.enabled ? "bell-filled" : "bell"} size={16} /></button><button onClick={() => { setSettingsSection(getLastSettingsSection(active?.cwd || defaultCwd || null)); setSettings(true); }} aria-label={t("common.settings")}><Icon name="settings" size={16} /></button></div>
        <button className="cq-new" onClick={showNew}><Icon name="plus" /> {t("queue.新会话")}</button>
        <button className="cq-mobile-settings" onClick={() => { setSettingsSection(getLastSettingsSection(active?.cwd || defaultCwd || null)); setSettings(true); }} aria-label={t("common.settings")}><Icon name="settings" /></button>

        <button className="cq-notifications cq-mobile-notifications" onClick={() => void notifications.toggle()} aria-pressed={notifications.enabled} aria-label={notifications.enabled ? "系统完成通知：已开启" : "开启系统完成通知"} title={notifications.enabled ? "系统完成通知已开启，点击关闭" : "开启系统完成通知"}><Icon name={notifications.enabled ? "bell-filled" : "bell"} size={16} /></button>
        <div className="cq-section-label"><span>{t("queue.WORKING")}</span><span>{(working.length + externalWorking.length).toString().padStart(2, "0")}</span></div>
        <div className="cq-working-list">
          {working.map((card, index) => <button key={card.id} data-transfer-id={card.id} data-transfer-zone="sidebar" className={`cq-small-card ${inspecting === card.id ? "is-selected" : ""}`} disabled={!card.session && !card.harness} onClick={() => setInspecting(card.id)}>
            <span className="cq-small-meta"><span className="cq-dot" />{displayProject(card)}<span className="cq-index">{String(index + 1).padStart(2, "0")}</span></span>
            {card.nickname ? <>
              <strong className="cq-small-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</strong>
              <span className="cq-small-session-title">{titleOf(card)}</span>
            </> : <strong>{titleOf(card)}</strong>}
            <span className="cq-working-bottom"><span className="cq-bars"><i /><i /><i /><i /></span>{t("queue.正在工作")}<span>↗</span></span>
          </button>)}
          {/* Work Que does not own: open session inspection on click. */}
          {externalWorking.map((notice) => {
            const cardId = `external:${notice.id}`;
            const harness = harnessName(notice.kind);
            const rawTitle = externalNoticeTitle(notice);
            const prefix = t("external.title");
            const title = !rawTitle
              ? prefix
              : rawTitle.startsWith(`${prefix} · `)
              ? rawTitle
              : `${prefix} · ${rawTitle}`;
            return (
              <button
                key={cardId}
                type="button"
                className={`cq-small-card cq-external-small ${inspecting === cardId ? "is-selected" : ""}`}
                title={t("external.hint", { name: harness })}
                onClick={() => setInspecting(cardId)}
              >
                <span className="cq-small-meta"><span className="cq-ready-dot" />{harness}</span>
                <strong>{title}</strong>
                <span className="cq-working-bottom">
                  <span className="cq-bars"><i /><i /><i /><i /></span>
                  {t("queue.正在工作")}
                  <span>↗</span>
                </span>
              </button>
            );
          })}
          {!working.length && !externalWorking.length && <div className="cq-quiet"><span className="cq-quiet-mark">∿</span><p>{t("queue.后台暂时很安静")}</p><span>{t("queue.回复后的卡片会来到这里，")}<br />{t("queue.让 Agent 继续工作。")}</span></div>}
        </div>
        {!!detached.length && <><div className="cq-section-label"><span>{t("queue.独立标签页")}</span><span>{detached.length}</span></div><div className="cq-detached-list">{detached.map((card) => <button key={card.id} onClick={() => openDetachedCardTab(card.id)}><Icon name="out" size={14} /><span>{titleOf(card)}</span><i className={card.phase === "working" ? "cq-dot" : "cq-ready-dot"} /></button>)}</div></>}
        {!!reminding.length && <><div className="cq-section-label"><span>{t("queue.稍后提醒")}</span><span>{remindCount.toString().padStart(2, "0")}</span></div><div className="cq-remind-list">{reminding.map((card) => <button key={card.id} className={`cq-small-card cq-remind-card ${inspecting === card.id ? "is-selected" : ""}`} onClick={() => setInspecting(card.id)}>
          <span className="cq-small-meta"><Icon name="bell" size={11} />{displayProject(card)}<span className="cq-remind-countdown">{formatRemainder((card.remindAt ?? 0) - remindNow)}</span></span>
          {card.nickname ? <>
            <strong className="cq-small-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</strong>
            <span className="cq-small-session-title">{titleOf(card)}</span>
          </> : <strong>{titleOf(card)}</strong>}
        </button>)}</div></>}
        <div className="cq-sidebar-bottom">
          <button onClick={openHistory}><Icon name="history" />{t("queue.历史对话")}</button>
          <div className="cq-sidebar-meta">
            <span>v{appUpdate.version}</span>
            {(import.meta.env.DEV || appUpdate.result?.newer) && <>
              <a className="cq-sidebar-update" href={import.meta.env.DEV ? `${QUE_REPO_URL}/releases/latest` : appUpdate.result ? releaseUrl(appUpdate.result.tag) : `${QUE_REPO_URL}/releases/latest`} title={appUpdate.result?.newer ? t("settings.aboutUpdateAvailable", { version: appUpdate.result.version }) : t("settings.aboutViewRelease")} onClick={(event) => { event.preventDefault(); void openUrl(event.currentTarget.href).catch(() => showQueueToast(t("settings.aboutOpenFailed"))); }}>{t("settings.aboutUpdateLink")}</a>
            </>}
          </div>
        </div>
      </aside>}
      <div className="cq-content" ref={contentRef}>
        {!detachedId && <div className="cq-content-drag" data-tauri-drag-region aria-hidden="true" />}
        {!detachedId && <div className={`cq-content-toolbar${toolbarCompact ? " is-compact" : ""}`} ref={toolbarRef}>
          <div className="cq-toolbar-menu">
            <button type="button" className="cq-toolbar-trigger" aria-haspopup="menu" aria-label={t("settings.appearance")} title={t("settings.appearance")}><ThemeIcon preference={preference} size={16} /></button>
            <div className="cq-toolbar-popover" role="menu" aria-label={t("settings.appearance")}>
              {THEME_OPTIONS.map((option) => <button key={option.id} type="button" role="menuitemradio" aria-checked={preference === option.id} onClick={(event) => { setThemePreference(option.id); event.currentTarget.blur(); }}><ThemeIcon preference={option.id} size={15} /><span>{t(option.label)}</span></button>)}
            </div>
          </div>
          <div className="cq-toolbar-menu">
            <button type="button" className="cq-toolbar-trigger" aria-haspopup="menu" aria-label={t("common.language")} title={t("common.language")}><LanguageIcon /></button>
            <div className="cq-toolbar-popover cq-language-popover" role="menu" aria-label={t("common.language")}>
              {supportedLocales.map((plugin) => <button key={plugin.id} type="button" role="menuitemradio" aria-checked={locale === plugin.id} onClick={(event) => { setLocale(plugin.id as typeof locale); event.currentTarget.blur(); }}><span>{plugin.label}</span><small>{plugin.id}</small></button>)}
            </div>
          </div>
          <div className="cq-toolbar-menu">
            <button type="button" className="cq-insertion-position" disabled={!queue} aria-haspopup="menu" aria-label={t("queue.切换队列排序")} title={t("queue.切换队列排序")}>{queue?.sortMode === "score" ? "⇅" : "→"} <span className="cq-sort-label">{queue?.sortMode === "score" ? t("queue.评分排序") : t("queue.先进先出")}</span></button>
            <div className="cq-toolbar-popover cq-sort-popover" role="menu" aria-label={t("queue.切换队列排序")}>
              <button type="button" role="menuitemradio" aria-checked={queue?.sortMode === "score"} disabled={busy || !queue} onClick={(event) => { void chooseSortMode("score"); event.currentTarget.blur(); }}><span>⇅</span><span>{t("queue.评分排序")}</span></button>
              <button type="button" role="menuitemradio" aria-checked={queue?.sortMode === "fifo"} disabled={busy || !queue} onClick={(event) => { void chooseSortMode("fifo"); event.currentTarget.blur(); }}><span>→</span><span>{t("queue.先进先出")}</span></button>
            </div>
          </div>
          <div className="cq-toolbar-menu">
            <button type="button" className="cq-insertion-position cq-attention-mode" aria-haspopup="menu" aria-label={t("queue.切换工作模式")} title={t("queue.切换工作模式")}>{attentionOption.icon} <span className="cq-mode-label">{t(attentionOption.label)}</span></button>
            <div className="cq-toolbar-popover cq-mode-popover" role="menu" aria-label={t("queue.切换工作模式")}>
              {ATTENTION_MODES.map((option) => (
                <button key={option.id} type="button" role="menuitemradio" aria-checked={attentionMode === option.id} onClick={(event) => { chooseAttentionMode(option.id); event.currentTarget.blur(); }}><span>{option.icon}</span><span>{t(option.label)}</span></button>
              ))}
            </div>
          </div>
        </div>}
      {!detachedId && cardSearchItems.length > 0 && <CardQuickSearch items={cardSearchItems} onOpen={(item) => {
        if (item.location === "detached") {
          openDetachedCardTab(item.id);
          return;
        }
        if (item.location === "working") {
          setInspecting(item.id);
          return;
        }
        const index = ready.findIndex((card) => card.id === item.id);
        if (index >= 0) selectQueueCard(index);
      }} />}
      {arrivalNotice && <QueueArrivalPreview notice={arrivalNotice} onOpen={(cardId) => {
        setArrivalNotices((current) => current.slice(1));
        focusNotificationCard(cardId);
      }} />}
      <main className="cq-main">
        {(error || connectionError) && <ErrorDialog
          message={[error, connectionError].filter(Boolean).map(entry => harnessErrorText(entry, t)).join("\n\n")}
          onDismiss={() => setError(null)}
          onRetry={() => { setError(null); void refresh(); }}
        />}
        {claimError && <ErrorDialog
          message={claimError}
          onDismiss={() => setClaimError("")}
          extraAction={{ label: t("queue.返回主页面"), onClick: () => void returnToQueue() }}
        />}
        <div className="cq-stage" ref={stageRef} style={stageWidth !== null ? { width: stageWidth } : undefined}>
          {!queue ? <div className="cq-empty"><span className="cq-orbit"><QueMark size={34} /></span><h2>{(error ? harnessErrorText(error, t) : "") || "Connecting Que…"}</h2></div> : active && canShowDetached ? <>
            {detachedId
              ? <div className="cq-static-card cq-single-mode-card">{renderCard(active)}</div>
              : <>
                  <CardDeck cards={ready} navigationRef={deckNavigationRef} focusedIndex={deckIndex} resetKey={deckReset} suspended={!!inspected} withheldCardId={inspected?.id ?? inspectionLeaving?.id ?? null} onIndexChange={(index) => { if (ready[index]) setFocus({id: ready[index].id, index}); }} renderCard={renderCard} />
                </>}
          </> : <div className="cq-empty">
            {detachedId && <div className="cq-detached-window-drag" data-tauri-drag-region aria-hidden="true" />}
            <span className="cq-orbit"><QueMark size={34} /></span>
            <h2>{detachedId ? t("queue.正在接入会话") : working.length ? t("queue.把工作交给它们。") : t("queue.创建卡片，让 Agent 开始工作。")}</h2>
            <p>{working.length ? t("queue.需要你的时候，卡片会自动来到这里。") : t("queue.完成后，卡片会经调度队列回到你面前；你只需依次处理顶层卡片。")}</p>
            {!detachedId && <button className="cq-primary" onClick={showNew}><Icon name="plus" size={16} /> {t("queue.新建第一张卡片")}</button>}
          </div>}
        </div>

        {!detachedId && <CardQueueMinimap
          cards={ready.map((card) => {
            const workspace = workspaceOf(card);
            return {
              id: card.id,
              sessionId: card.session?.id,
              title: titleOf(card),
              excerpt: card.session?.firstMessage === "(no messages)" ? undefined : card.session?.firstMessage,
              host: cardHostLabel(card, workspace),
              workspace: displayProject(card),
              remote: workspace?.kind === "ssh",
              tmux: Boolean(workspace?.kind === "ssh" && (card.harness ? card.harness.tmux !== false : true)),
            };
          })}
          activeIndex={inspecting ? -1 : deckIndex}
          label={t("queue.卡片队列导航")}
          itemLabel={(index, title) => t("queue.卡片位置", { current: index + 1, total: ready.length, title })}
          onSelect={selectQueueCard}
        />}

      </main>
      </div>
    </div>
    {inspected && !detachedId && <CardInspectionOverlay anchor={stageRef} transferId={inspected.id} leaving={inspectionLeaving?.id === inspected.id ? inspectionLeaving.to : null}
      onClose={() => leaveInspection(inspected.id)}
      onSettled={() => { setInspectionLeaving(null); setInspecting(null); }}>{renderCard(inspected)}</CardInspectionOverlay>}
    </CardTransfers>
    {creating && <WorkspacePicker workspaces={workspaces} machineSettings={machineSettings} remoteHosts={remoteHosts} busy={busy} onClose={() => setCreating(false)} onAddWorkspace={(machine) => { setCreating(false); setError(""); setWorkspaceThenCreate(true); setWorkspaceFormEntry(machine); setAddingWorkspace(true); }} onManageHosts={() => { setCreating(false); setSettingsSection("remote-hosts"); setSettings(true); }} onUpdate={async (workspaceId, value) => {
      setBusy(true); const result = await run("workspace_update", { workspaceId, ...value }); setBusy(false); return !!result;
    }} onUpdateMachine={async (machineKey, value) => {
      setBusy(true); const result = await run("machine_settings_update", { machineKey, ...value }); setBusy(false); return !!result;
    }} onRemove={async (workspaceId) => {
      setBusy(true); const result = await run("workspace_remove", { workspaceId }); setBusy(false); return !!result;
    }} onSelect={async (workspaceId) => {
      setBusy(true); const result = await run("create", { workspaceId }); setBusy(false);
      if (result) { setCreating(false); setInspecting(result.cards.find(card => !card.session && !card.harness)?.id ?? null); }
    }} />}
    {addingWorkspace && <WorkspaceForm key={typeof workspaceFormEntry === "string" ? workspaceFormEntry : workspaceFormEntry.id} entry={workspaceFormEntry} defaultCwd={defaultCwd} busy={busy} error={error} onClose={() => setAddingWorkspace(false)} onBack={() => { setAddingWorkspace(false); setCreating(true); }} onSave={async (value) => {
      setBusy(true); const result = await run("workspace_create", { ...value, createCard: workspaceThenCreate }); setBusy(false);
      if (result) {
        setAddingWorkspace(false);
        setWorkspaceThenCreate(false);
        if (workspaceThenCreate) setInspecting(result.cards.find(card => !card.session && !card.harness)?.id ?? null);
      }
    }} />}
    {archiveConfirm && <div className="cq-overlay" onClick={() => !busy && setArchiveConfirm(null)}><section className="cq-dialog cq-archive-confirm" role="dialog" aria-modal="true" aria-label={t("queue.确认归档")} onClick={(event) => event.stopPropagation()}><div className="cq-dialog-heading"><Icon name="archive" /><button aria-label={t("queue.关闭")} disabled={busy} onClick={() => setArchiveConfirm(null)}><Icon name="close" /></button></div><h2>{t("queue.确认归档")}</h2><p>{t("queue.归档后会话将移到历史对话，之后仍可重新打开。")}</p><label className="cq-archive-skip"><input type="checkbox" checked={skipArchiveChecked} disabled={busy} onChange={event => setSkipArchiveChecked(event.target.checked)} /><span>{t("queue.skipArchiveThisPage")}<small>{t("queue.skipArchiveThisPageHint")}</small></span></label><div className="cq-confirm-actions"><button disabled={busy} onClick={() => setArchiveConfirm(null)}>{t("queue.取消")}</button><button className="cq-primary cq-danger" disabled={busy} onClick={async () => { setBusy(true); const result = await run("archive", { id: archiveConfirm.id }); setBusy(false); if (result) { if (skipArchiveChecked) setSkipArchiveConfirmation(true); advanceToNextCard(archiveConfirm.id); setArchiveConfirm(null); } }}>{t("queue.归档")}</button></div></section></div>}
    {history && <div className="cq-overlay" onClick={() => setHistory(null)}><section className="cq-dialog cq-history" role="dialog" aria-modal="true" aria-label={t("queue.历史对话")} onClick={(event) => event.stopPropagation()}><div className="cq-dialog-heading"><Icon name="history" /><button aria-label={t("queue.关闭")} onClick={() => setHistory(null)}><Icon name="close" /></button></div><h2>{t("queue.历史对话")}</h2><p>{t("queue.已收起的卡片和未在当前队列中的会话，点击即可继续。")}</p><input aria-label="搜索会话" placeholder={t("queue.搜索会话或项目…")} value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} /><div className="cq-history-list">{historyMatches.map(card => <button key={card.id} onClick={() => { setHistory(null); setInspecting(card.id); }}><span>{harnessName(card.harness!.kind)} · {card.nickname ? <strong className="cq-history-nickname" style={{ "--cq-nickname-hue": nicknameHue(card.id) } as CSSProperties}>{card.nickname}</strong> : titleOf(card)}</span>{card.nickname && <small className="cq-history-session-title">{titleOf(card)}</small>}<small>{projectOf(card.cwd)} · {new Date(card.archivedAt!).toLocaleDateString()}</small></button>)}{!historyMatches.length && <p>{historySearch ? t("queue.没有匹配的历史对话。") : t("queue.暂无未在队列中的历史对话。")}</p>}</div></section></div>}
    {settings && <SettingsPanel cwd={active?.cwd || defaultCwd || null} sessionId={active?.session?.id || null} initialSection={settingsSection} onClose={() => { setSettings(false); setModelsRefreshKey((key) => key + 1); void refreshRemoteHosts(); }} onSessionReloaded={() => { setSessionRefreshKey((key) => key + 1); void refresh(); }} appUpdate={appUpdate} quoteSelectionEnabled={quoteSelectionEnabled} onQuoteSelectionChange={setQuoteSelectionEnabled} />}
  </div>;
}
