"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { documentCanvasDark, harnessTerminalTheme, resolveTerminalThemeProfile, terminalThemeHostFromDocument, windowsPtyOptions, type TerminalThemeProfile } from "@/lib/terminal-theme";
import { readTerminalAppearance, terminalFontFamily, terminalFontSize, TERMINAL_APPEARANCE_EVENT, TERMINAL_APPEARANCE_KEY, type TerminalAppearance } from "@/lib/terminal-appearance";
import { CodexComposerColors, codexComposerTheme } from "@/lib/codex-composer-colors";
import { TerminalReplyPolicy, isTerminalProtocolReply } from "@/lib/terminal-replies";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { enhancedTerminalKey, decodeTerminalClipboard } from "@/lib/terminal-enhancements";
import { isFileDrag, droppedFiles, dropFilesError } from "@/lib/file-drop";
import { copyText } from "@/lib/clipboard";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "@/hooks/useI18n";
import { createTerminalWriter, isTerminalAbortError, terminalRequest } from "@/lib/terminal-client";
import { setXtermProbe } from "@/lib/terminal-probe";
import { appLog, oscTrace } from "@/lib/app-log";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "@/lib/image-attachments";
import type { TerminalEvent } from "@/lib/terminal-manager";
import type { TerminalTab } from "./terminal-tab-state";
import { TerminalStartupProgress, type TerminalStartupStage } from "./TerminalStartupProgress";
import { dropTerminalSnapshot, getTerminalSnapshot, saveTerminalSnapshot } from "@/lib/terminal-snapshots";

export type TerminalConnectionStatus = "connecting" | "ready" | "exited" | "error" | "paused";
interface Props {
  onOutput?: (data: string) => void;
  onStatusChange?: (status: TerminalConnectionStatus) => void;
  embedded?: boolean;
  themeProfile?: TerminalThemeProfile;
  remote?: boolean;
  readOnly?: boolean;
  /** Hide the xterm caret while ConPTY scrapes CUP cell-by-cell (Windows). */
  conptyCursorHide?: boolean;
  tab: TerminalTab;
  active: boolean;
  /** Reply to CSI ?1004h. I while the card is in the queue, O otherwise. */
  focusReporting?: boolean;
  inQueue?: boolean;
  onRestart: () => void;
  onClosed: () => void;
  onCloseError: () => void;
  onUnavailable?: () => void;
  cardId?: string;
  harnessKind?: string;
  harnessName?: string;
  isStarting?: boolean;
}

function liveThemeProfile(themeProfile: TerminalThemeProfile | undefined, remote: boolean | undefined): TerminalThemeProfile | undefined {
  if (typeof document === "undefined") return themeProfile === "grok" ? "grok" : undefined;
  return resolveTerminalThemeProfile(themeProfile, terminalThemeHostFromDocument(remote, document.documentElement, navigator));
}

export function TerminalPanel({ tab, active, onRestart, onClosed, onCloseError, onUnavailable, embedded = false, readOnly = false, onStatusChange, onOutput, themeProfile, remote = false, focusReporting = false, inQueue = false, conptyCursorHide = true, cardId, harnessKind, harnessName, isStarting }: Props) {
  const { t } = useI18n();
  const { id, cwd, sshHost, restored } = tab;
  const initialNeedsStartup = Boolean(isStarting || !restored);
  const [startupStage, setStartupStage] = useState<TerminalStartupStage>(initialNeedsStartup ? "preparing" : "ready");
  const [showProgress, setShowProgress] = useState<boolean>(initialNeedsStartup);
  const hasOutputRef = useRef(!initialNeedsStartup);
  const startTimeRef = useRef(Date.now());
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const liveControlRef = useRef<((live: boolean) => void) | null>(null);
  const callbacksRef = useRef({ onClosed, onCloseError, onOutput, onUnavailable });
  callbacksRef.current = { onClosed, onCloseError, onOutput, onUnavailable };
  const focusReportingRef = useRef(focusReporting);
  const focusArmedRef = useRef(false);
  const closingRef = useRef(tab.closing);
  closingRef.current = tab.closing;
  const inQueueRef = useRef(inQueue);
  focusReportingRef.current = focusReporting;
  inQueueRef.current = inQueue;
  const conptyCursorHideRef = useRef(conptyCursorHide);
  conptyCursorHideRef.current = conptyCursorHide;
  // The only writer of focus reports. xterm's own half is filtered out of
  // `sendInput` because it reports browser textarea focus, which is not what the
  // CLI is asking about — the queue position is.
  const sendFocusReport = useCallback((inQueueNow: boolean) => {
    if (!focusReportingRef.current || !focusArmedRef.current) return;
    writerRef.current?.write(inQueueNow ? "\x1b[I" : "\x1b[O");
  }, []);
  const [status, setStatus] = useState<TerminalConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [searchInvalid, setSearchInvalid] = useState(false);
  const [matches, setMatches] = useState({ resultIndex: -1, resultCount: 0 });
  const [dragging, setDragging] = useState(false);
  const [clipboardPending, setClipboardPending] = useState<string | null>(null);
  const find = useCallback((previous = false, incremental = false) => {
    if (regex) {
      try { new RegExp(searchQuery); } catch { setSearchInvalid(true); searchRef.current?.clearDecorations(); return; }
    }
    setSearchInvalid(false);
    if (!searchQuery) { searchRef.current?.clearDecorations(); setMatches({ resultIndex: -1, resultCount: 0 }); return; }
    const options = { caseSensitive, regex, incremental, decorations: {
      matchBackground: "#796322", matchOverviewRuler: "#b69738",
      activeMatchBackground: "#35704d", activeMatchColorOverviewRuler: "#59c484",
    } };
    if (previous) searchRef.current?.findPrevious(searchQuery, options);
    else searchRef.current?.findNext(searchQuery, options);
  }, [caseSensitive, regex, searchQuery]);
  useEffect(() => {
    if (searchOpen) { searchInput.current?.focus(); find(false, true); }
    else searchRef.current?.clearDecorations();
  }, [searchOpen, find]);
  const closeSearch = () => { setSearchOpen(false); terminalRef.current?.focus(); };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    focusArmedRef.current = false;
    let disposed = false;
    let events: EventSource | null = null;
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    let sessionReadOnly = readOnly;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const isExplicitRestart = reconnectKey > 0;
    if (initialNeedsStartup || isExplicitRestart) {
      hasOutputRef.current = false;
      setStartupStage("preparing");
      setShowProgress(true);
      startTimeRef.current = Date.now();
    } else {
      hasOutputRef.current = true;
      setShowProgress(false);
    }

    const conptyHost = !remote && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
    const replyPolicy = new TerminalReplyPolicy(conptyHost && document.documentElement.dataset.conptyFallback !== "true");
    let conptyCursorHidden = false;
    let conptyRevealTimer: ReturnType<typeof setTimeout> | undefined;
    let appearance = readTerminalAppearance();
    const composerColors = harnessKind === "codex" && appearance.codexAdaptiveBackground ? new CodexComposerColors() : undefined;
    const liveTheme = () => {
      const dark = documentCanvasDark(document.documentElement);
      const profile = liveThemeProfile(themeProfile, remote);
      const theme = harnessTerminalTheme(dark, profile, appearance[dark ? "dark" : "light"]);
      return composerColors ? codexComposerTheme(theme, profile === "campbell" || profile === "grok" || dark) : theme;
    };
    const liveFont = () => terminalFontFamily(appearance.font, getComputedStyle(container).getPropertyValue("--font-mono").trim() || "monospace");
    // Follow the settings font slider 1:1 (chat baseline 14px ↔ terminal 13px),
    // so one control scales both surfaces.
    const liveFontSize = () => {
      const chat = Number.parseFloat(getComputedStyle(container).getPropertyValue("--chat-content-font-size"));
      return terminalFontSize(chat);
    };
    const snapshot = getTerminalSnapshot(id);
    let restoringSnapshot = Boolean(snapshot);
    const terminal = new Terminal({
      ...(snapshot ? { cols: snapshot.cols, rows: snapshot.rows } : {}),
      cursorBlink: !conptyHost,
      allowProposedApi: true,
      fontFamily: liveFont(),
      fontSize: liveFontSize(),
      // Keep the DOM fallback compact too; WebGL draws continuous block glyphs.
      lineHeight: 1,
      letterSpacing: 0,
      customGlyphs: true,
      scrollback: 100000,
      // xterm 6.0.0 + screenReaderMode re-sends the trailing character when an
      // IME commits in the middle of a line (xtermjs/xterm.js#5456 / PR #5698).
      // Re-enable after upgrading past that CompositionHelper fix.
      screenReaderMode: false,
      disableStdin: true,
      windowsPty: windowsPtyOptions(conptyHost, document.documentElement),
      theme: liveTheme(),
    });
    const refreshAppearance = () => {
      terminal.options.theme = liveTheme();
      container.closest<HTMLElement>(".terminal-panel")?.style.setProperty("--terminal-bg", liveTheme().background!);
      const size = liveFontSize();
      const font = liveFont();
      if (size !== terminal.options.fontSize || font !== terminal.options.fontFamily) {
        terminal.options.fontSize = size;
        terminal.options.fontFamily = font;
        if (!restoringSnapshot) fit.fit();
        void document.fonts.load(`${size}px ${font}`).then(() => { if (!disposed && !restoringSnapshot) { fit.fit(); terminal.refresh(0, terminal.rows - 1); } });
      }
    };
    const appearanceChanged = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== TERMINAL_APPEARANCE_KEY && event.key !== null) return;
      appearance = event instanceof CustomEvent ? event.detail as TerminalAppearance : readTerminalAppearance();
      refreshAppearance();
    };
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, appearanceChanged);
    window.addEventListener("storage", appearanceChanged);
    const themeObserver = new MutationObserver(refreshAppearance);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-desktop-platform", "data-terminal-bg", "style"] });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    terminal.open(container);
    refreshAppearance();
    const hideConptyCursor = () => {
      if (!conptyHost || gpu || !conptyCursorHideRef.current) return;
      // Reveal only after output goes quiet. A short window strobes the cursor
      // while streaming TUIs (Codex spinner) emit chunks faster than the timer.
      clearTimeout(conptyRevealTimer);
      if (!conptyCursorHidden) {
        conptyCursorHidden = true;
        container.classList.add("is-conpty-redraw");
      }
      conptyRevealTimer = setTimeout(() => {
        conptyCursorHidden = false;
        if (!disposed) container.classList.remove("is-conpty-redraw");
      }, 250);
    };
    // Let native horizontal gestures reach the card deck without xterm turning
    // them into terminal input or cancelling them. Vertical terminal scrolling
    // and detached terminals keep their existing behavior.
    const preserveDeckGesture = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && container.closest(".cq-deck-scroller")) {
        event.stopPropagation();
      }
    };
    container.addEventListener("wheel", preserveDeckGesture, { capture: true, passive: true });
    const search = new SearchAddon();
    terminal.loadAddon(search);
    searchRef.current = search;
    const searchResults = search.onDidChangeResults(setMatches);
    let replaying = true;
    if (snapshot) {
      offset = snapshot.offset;
      hasOutputRef.current = true;
      setStartupStage("ready");
      setShowProgress(false);
    }
    let renderedOffset = snapshot?.offset;
    let writing = Boolean(snapshot);
    const restoreSnapshot = snapshot
      ? new Promise<void>((resolve) => terminal.write(snapshot.output, () => { restoringSnapshot = false; writing = false; replaying = false; resolve(); }))
      : Promise.resolve();
    let outputQueue = Promise.resolve();
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let checkpointDue = !snapshot;
    let snapshotDirty = false;
    const saveSnapshot = () => {
      // Never pair a partially parsed screen with a cursor past its contents.
      // Keep the previous checkpoint if xterm is still processing a write.
      if (writing || closingRef.current || renderedOffset === undefined || !snapshotDirty) return;
      saveTerminalSnapshot(id, {
        output: serializer.serialize(), offset: renderedOffset,
        cols: terminal.cols, rows: terminal.rows,
      });
      snapshotDirty = false;
      checkpointDue = false;
    };
    const scheduleSnapshot = () => {
      if (disposed || closingRef.current || snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        checkpointDue = true;
        saveSnapshot();
      }, 5000);
    };
    const clipboard = terminal.parser.registerOscHandler(52, (payload) => {
      if (replaying || disposed || !document.hasFocus() || !container.contains(document.activeElement)) return true;
      const text = decodeTerminalClipboard(payload);
      if (text !== null) void copyText(text).catch(() => { if (!disposed) setClipboardPending(text); });
      return true;
    });
    // Modern ConPTY transports OSC replies. Answer live application queries,
    // including CLIs launched inside a shell; never answer historical output.
    // The inbox fallback retains its fixed palette and conservative policy.
    const swallowColorQueries = conptyHost && liveThemeProfile(themeProfile, remote) === "campbell";
    appLog("debug", "osc", `panel-mount swallow=${swallowColorQueries} harnessKind=${harnessKind ?? "none"} conpty=${conptyHost}`, { card: cardId, term: id });
    for (const ident of [4, 10, 11, 12]) {
      terminal.parser.registerOscHandler(ident, data => data.includes("?") && (replaying || swallowColorQueries));
    }
    // WebGL custom glyphs fill block cells exactly; DOM font glyphs leave
    // vertical seams on Windows. Fall back to DOM if GPU setup/context fails.
    let gpu: import("@xterm/addon-webgl").WebglAddon | undefined;
    let gpuLoss: { dispose(): void } | undefined;
    {
      void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
        if (disposed) return;
        const addon = new WebglAddon();
        try {
          terminal.loadAddon(addon);
          gpu = addon;
          clearTimeout(conptyRevealTimer);
          conptyCursorHidden = false;
          container.classList.remove("is-conpty-redraw");
          gpuLoss = addon.onContextLoss(() => {
            gpuLoss?.dispose(); gpuLoss = undefined;
            gpu?.dispose(); gpu = undefined;
            terminal.refresh(0, terminal.rows - 1);
          });
          terminal.refresh(0, terminal.rows - 1);
        } catch { addon.dispose(); }
      }).catch(() => { /* DOM rendering remains available. */ });
    }
    const writer = createTerminalWriter(id, (reason) => {
      if (disposed) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    });
    writerRef.current = writer;
    let pendingInput = "";
    let inputRaf = 0;
    const flushInput = () => {
      inputRaf = 0;
      const data = pendingInput;
      pendingInput = "";
      if (data && connected && !exited && !inputFailed && !sessionReadOnly) writer.write(data);
    };
    const sendInput = (data: string) => {
      if (exited || inputFailed || sessionReadOnly) return;
      // Replies share the input channel. Filter replay and the already-answered
      // native startup handshake, not normal live application probes.
      if (replyPolicy.suppress(data, replaying, focusReportingRef.current)) return;
      if (!connected || terminal.options.disableStdin) return;
      if (isTerminalProtocolReply(data)) { writer.reply(data); return; }
      if (!conptyHost) { writer.write(data); return; }
      // One HTTP POST per animation frame instead of one per keystroke.
      pendingInput += data;
      if (!inputRaf) inputRaf = requestAnimationFrame(flushInput);
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return true;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const key = event.key.toLowerCase();
      if ((mac ? event.metaKey : event.ctrlKey) && key === "f") {
        event.preventDefault(); event.stopPropagation(); setSearchOpen(true);
        requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select(); });
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      const data = enhancedTerminalKey(event, mac);
      if (data !== null) {
        event.preventDefault(); event.stopPropagation();
        sendInput(data);
        return false;
      }
      return true;
    });
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!connected || exited || inputFailed || sessionReadOnly || terminal.options.disableStdin) return;
      if (files.length > MAX_ATTACHED_IMAGES || files.some((file) => file.size > MAX_ATTACHED_IMAGE_BYTES)) {
        setError("Paste up to 10 images, each 10 MB or smaller.");
        return;
      }
      setError(null);
      if (inputRaf) { cancelAnimationFrame(inputRaf); flushInput(); }
      writer.pasteImages(files, terminal.modes.bracketedPasteMode);
    };
    // Capture before xterm's text-only paste listener consumes the clipboard.
    container.addEventListener("paste", paste, true);
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !isFileDrag(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation();
      const writable = connected && !exited && !inputFailed && !sessionReadOnly && !terminal.options.disableStdin;
      event.dataTransfer.dropEffect = writable ? "copy" : "none";
      setDragging(writable);
    };
    const dragLeave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer || !isFileDrag(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); setDragging(false);
      if (!connected || exited || inputFailed || sessionReadOnly || terminal.options.disableStdin) return;
      try {
        const files = droppedFiles(event.dataTransfer);
        const reason = dropFilesError(files);
        if (reason) throw new Error(reason);
        if (files.length) {
          setError(null);
          if (inputRaf) { cancelAnimationFrame(inputRaf); flushInput(); }
          writer.pasteFiles(files, terminal.modes.bracketedPasteMode);
          terminal.focus();
        }
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    };
    container.addEventListener("dragover", dragOver);
    container.addEventListener("dragleave", dragLeave);
    container.addEventListener("drop", drop);
    const onData = terminal.onData((data) => {
      oscTrace("xterm-onData", data, { card: cardId, term: id });
      sendInput(data);
    });
    const fitAndResize = () => {
      if (disposed || restoringSnapshot || !container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    const onResize = terminal.onResize(({ cols, rows }) => {
      snapshotDirty = true;
      scheduleSnapshot();
      if (connected && !exited && !inputFailed && !sessionReadOnly) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);

    let sseMessages = 0;
    let bytesWritten = 0;
    let skipped = 0;
    let gaps = 0;
    // Bytes the server confirmed are unrecoverable. Kept apart from `gaps`:
    // a gap triggers a resync that can still repair the stream, a drop is data
    // that is simply gone, and conflating them hides real loss behind retries.
    let dropped = 0;
    let lastReset = false;
    let resyncing = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    const publishProbe = (statusName: string) => {
      setXtermProbe(id, {
        cols: terminal.cols,
        rows: terminal.rows,
        sseMessages,
        bytesWritten,
        lastOffset: offset,
        lastReset,
        gaps,
        dropped,
        status: `${statusName}${skipped ? ` skip=${skipped}` : ""}${gaps ? ` gaps=${gaps}` : ""}${dropped ? ` dropped=${dropped}B` : ""}`,
      });
    };
    // Native EventSource retry would reuse the URL captured at connect time,
    // including a stale `after` cursor. Always rebuild the request with the
    // offset we actually hold so the server replays exactly what we missed.
    const scheduleReconnect = () => {
      if (disposed || exited) return;
      events?.close();
      events = null;
      clearTimeout(reconnectTimer);
      const delay = Math.min(15_000, 500 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    // Background cards (deck neighbors, hidden side-terminal tabs, closed side
    // panels) must not hold a live SSE: every mounted panel opens one and the
    // WebView caps concurrent connections per host, so background streams
    // starve the foreground ones and connections visibly "drop". Pausing keeps
    // the offset; resuming replays exactly the missed range from the backlog.
    let live = true;
    const setLive = (on: boolean) => {
      if (disposed || exited || on === live) return;
      live = on;
      if (on) {
        reconnectAttempt = 0;
        resyncing = false;
        setStatus("connecting");
        connect();
        return;
      }
      if (inputRaf) { cancelAnimationFrame(inputRaf); flushInput(); }
      connected = false;
      terminal.options.disableStdin = true;
      clearTimeout(reconnectTimer);
      events?.close();
      events = null;
      appLog("debug", "sse", "pause", { card: cardId, term: id });
      setStatus((current) => current === "connecting" || current === "ready" ? "paused" : current);
    };
    liveControlRef.current = setLive;
    const enqueueOutput = (event: Extract<TerminalEvent, { type: "output" }>) => {
      oscTrace("sse-recv", event.data, { card: cardId, term: id });
      hideConptyCursor();
      if (focusReportingRef.current && event.data.includes("\x1b[?1004h")) {
        focusArmedRef.current = true;
        sendFocusReport(inQueueRef.current);
      }
      if (event.data.includes("\x1b[?1004l")) focusArmedRef.current = false;
      bytesWritten += event.data.length;
      if (event.data.length > 0 && !hasOutputRef.current) {
        hasOutputRef.current = true;
        setStartupStage("ready");
      }
      outputQueue = outputQueue.then(() => new Promise<void>((resolve) => {
        if (disposed) { resolve(); return; }
        // Both reset=true (full backlog) and reset=false (incremental catch-up)
        // are historical. Live backend output omits reset entirely.
        writing = true;
        replaying = event.reset !== undefined;
        if (event.reset) { terminal.reset(); composerColors?.reset(); }
        replyPolicy.observeOutput(event.data);
        terminal.write(composerColors?.feed(event.data) ?? event.data, () => {
          renderedOffset = event.offset;
          writing = false;
          replaying = false;
          snapshotDirty = true;
          if (!disposed && checkpointDue) saveSnapshot();
          scheduleSnapshot();
          resolve();
        });
      }));
      callbacksRef.current.onOutput?.(event.data);
      offset = event.offset;
      publishProbe("ready");
    };
    const connect = () => {
      if (disposed || restoringSnapshot || exited || !live || !navigator.onLine) return;
      events?.close();
      // Always hand the server the offset we actually hold. Omitting it when
      // `offset === undefined` is correct (nothing read yet, full replay is what
      // we want), but once we have an offset it must ride along on *every*
      // reconnect — the browser drops its internal lastEventId when we close the
      // stream, so `?after=` is the only cursor the server can trust. Without it
      // a resume after a pause degrades into a reset that replays just the
      // backlog, and anything trimmed in the meantime is lost with no signal.
      events = new EventSource(`/api/terminal/${encodeURIComponent(id)}/events${offset === undefined ? "" : `?after=${offset}`}`);
      events.onmessage = (message) => {
        const event = JSON.parse(message.data) as TerminalEvent;
        sseMessages += 1;
        if (event.type === "output") {
          reconnectAttempt = 0;
          if (event.reset) {
            // Full replay: the server trimmed past our cursor (or this is the
            // first attach). Wipe and redraw instead of splicing.
            lastReset = true;
            resyncing = false;
            if (typeof event.dropped === "number" && event.dropped > 0) {
              // The redraw is not a superset of what we had — bytes are gone for
              // good. Say so; a silent wipe reads as "nothing happened".
              dropped += event.dropped;
              appLog("warn", "sse", `replay lost ${event.dropped}B cursor=${offset ?? "none"}`, { card: cardId, term: id });
            }
            enqueueOutput(event);
            return;
          }
          const from = event.from ?? offset ?? event.offset;
          if (offset !== undefined && event.offset <= offset) {
            skipped += 1;
            publishProbe("ready");
            return;
          }
          if (offset !== undefined && from !== offset) {
            // Byte gap (dropped SSE consumer) or partial overlap: never render
            // the hole — reconnect so the server replays the missing range.
            gaps += 1;
            if (!resyncing) {
              resyncing = true;
              appLog("warn", "sse", `gap resync from=${from} have=${offset} got=${event.offset}`, { card: cardId, term: id });
              publishProbe("resync");
              scheduleReconnect();
            }
            return;
          }
          enqueueOutput(event);
        } else {
          exited = true;
          connected = false;
          terminal.options.disableStdin = true;
          clearTimeout(reconnectTimer);
          events?.close();
          setExitCode(event.type === "exit" ? event.exitCode : null);
          setStatus("exited");
        }
      };
      events.onopen = () => {
        connected = true;
        resyncing = false;
        if (inputFailed) return;
        terminal.options.disableStdin = sessionReadOnly;
        setStatus("ready");
        if (!hasOutputRef.current) {
          setStartupStage("waiting_output");
        }
        fitAndResize();
        if (!sessionReadOnly) writer.resize(terminal.cols, terminal.rows);
        if (container.offsetWidth && container.offsetHeight) terminal.focus();
        publishProbe("ready");
      };
      events.onerror = () => {
        if (disposed || exited) return;
        connected = false;
        terminal.options.disableStdin = true;
        appLog("warn", "sse", `error after=${offset ?? "none"} attempt=${reconnectAttempt}`, { card: cardId, term: id });
        setStatus("connecting");
        if (!hasOutputRef.current && reconnectAttempt >= 2) {
          setStartupStage("error");
        }
        scheduleReconnect();
      };
    };

    startRef.current = (async () => {
      await restoreSnapshot;
      if (disposed) return;
      fitAndResize();
      if (restored || reconnectKey > 0 || snapshot) {
        // Restoring a tab must never silently launch a replacement shell for local processes,
        // but remote sessions (sshHost) with tmux should re-attach to their existing remote session.
        try {
          const info = await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
          sessionReadOnly ||= info.readOnly === true;
        } catch (error) {
          if (sshHost) {
            await terminalRequest("/api/terminal", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows, sshHost, ...(cardId ? { cardId } : {}) }),
            });
          } else {
            throw error;
          }
        }
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows, ...(sshHost ? { sshHost } : {}), ...(cardId ? { cardId } : {}) }),
        });
      }
      if (!disposed && !hasOutputRef.current) {
        setStartupStage("connecting");
      }
      connect();
    })().catch((reason: Error) => {
      if (disposed || isTerminalAbortError(reason)) return;
      if (restored) {
        callbacksRef.current.onUnavailable?.();
        return;
      }
      setError(reason.message);
      setStatus("error");
      if (!hasOutputRef.current) {
        setStartupStage("error");
        setShowProgress(true);
      }
    });

    const pageHide = () => {
      connected = false;
      terminal.options.disableStdin = true;
      clearTimeout(reconnectTimer);
      events?.close();
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        reconnectAttempt = 0;
        resyncing = false;
        connect();
      }
    };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      clearTimeout(snapshotTimer);
      if (closingRef.current) dropTerminalSnapshot(id);
      else saveSnapshot();
      liveControlRef.current = null;
      if (focusReportingRef.current && focusArmedRef.current && !inQueueRef.current) writer.write("\x1b[O");
      clearTimeout(conptyRevealTimer);
      clearTimeout(reconnectTimer);
      if (inputRaf) cancelAnimationFrame(inputRaf);
      if (pendingInput) writer.write(pendingInput);
      pendingInput = "";
      events?.close();
      void writer.stop();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      window.removeEventListener(TERMINAL_APPEARANCE_EVENT, appearanceChanged);
      window.removeEventListener("storage", appearanceChanged);
      container.removeEventListener("paste", paste, true);
      container.removeEventListener("dragover", dragOver);
      container.removeEventListener("dragleave", dragLeave);
      container.removeEventListener("drop", drop);
      clipboard.dispose();
      searchResults.dispose();
      searchRef.current = null;
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      gpuLoss?.dispose();
      gpu?.dispose();
      container.removeEventListener("wheel", preserveDeckGesture, true);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, sshHost, restored, reconnectKey, readOnly, themeProfile, remote, harnessKind]);

  useEffect(() => { liveControlRef.current?.(active); }, [active]);

  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    sendFocusReport(inQueue);
  }, [inQueue, sendFocusReport]);

  useEffect(() => {
    if (!tab.closing) return;
    dropTerminalSnapshot(id);
    let cancelled = false;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    void (async () => {
      try { await startRef.current; } catch { /* Start already failed; still drop the tab. */ }
      await writerRef.current?.stop();
      try {
        await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
      } catch (reason) {
        if (!isTerminalAbortError(reason)) throw reason;
      }
      if (!cancelled) callbacksRef.current.onClosed();
    })().catch((reason: Error) => {
      if (cancelled) return;
      if (isTerminalAbortError(reason)) {
        callbacksRef.current.onClosed();
        return;
      }
      setError(reason.message);
      setStatus("error");
      callbacksRef.current.onCloseError();
    });
    return () => { cancelled = true; };
  }, [id, tab.closing]);

  return (
    <section className={`terminal-panel${dragging ? " terminal-file-drag" : ""}${embedded ? " terminal-panel-embedded" : ""}`} data-terminal-theme={liveThemeProfile(themeProfile, remote)} suppressHydrationWarning aria-label={t("terminal.title")}>
      {!embedded && <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={cwd}>{cwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>}
      <button type="button" className="terminal-find-toggle" onClick={() => setSearchOpen(true)} title={t("terminal.find")} aria-label={t("terminal.find")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg></button>
      {searchOpen && <div className="terminal-find" role="search" onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); find(event.shiftKey); }
      }}>
        <input ref={searchInput} aria-label={t("terminal.find")} placeholder={t("terminal.find")} value={searchQuery} aria-invalid={searchInvalid} onChange={(event) => setSearchQuery(event.target.value)} />
        <span role="status">{searchInvalid ? t("terminal.invalidRegex") : `${matches.resultIndex + 1}/${matches.resultCount}`}</span>
        <button type="button" aria-label={t("terminal.matchCase")} title={t("terminal.matchCase")} aria-pressed={caseSensitive} onClick={() => setCaseSensitive(value => !value)}>Aa</button>
        <button type="button" aria-label={t("terminal.regex")} title={t("terminal.regex")} aria-pressed={regex} onClick={() => setRegex(value => !value)}>.*</button>
        <button type="button" aria-label={t("terminal.previousMatch")} title={t("terminal.previousMatch")} onClick={() => find(true)}>↑</button>
        <button type="button" aria-label={t("terminal.nextMatch")} title={t("terminal.nextMatch")} onClick={() => find()}>↓</button>
        <button type="button" aria-label={t("files.cancel")} onClick={closeSearch}>×</button>
      </div>}
      {dragging && <div className="terminal-drop-hint">{t("terminal.dropFiles")}</div>}
      {showProgress && (
        <TerminalStartupProgress
          stage={startupStage}
          remote={remote}
          sshHost={sshHost}
          harnessKind={harnessKind}
          harnessName={harnessName}
          error={error}
          onRetry={() => { setError(null); setReconnectKey((key) => key + 1); }}
          startedAt={startTimeRef.current}
        />
      )}
      <div className="terminal-panel-messages">
        {clipboardPending !== null && <button type="button" onClick={() => void copyText(clipboardPending).then(() => setClipboardPending(null)).catch(() => setError(t("terminal.copyFailed")))}>{t("terminal.copyRemote")}</button>}
        {error && <div className="terminal-panel-error" role="alert">
          <span>{error.includes(" ") ? error : t(error)}</span>
          <button type="button" onClick={() => { setError(null); setReconnectKey((key) => key + 1); }} disabled={Boolean(tab.closing)}>{t("terminal.reconnect")}</button>
        </div>}
        {!embedded && status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
    </section>
  );
}
