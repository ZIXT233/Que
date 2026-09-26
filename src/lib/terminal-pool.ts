import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import {
  documentCanvasDark,
  harnessTerminalTheme,
  resolveTerminalThemeProfile,
  terminalThemeHostFromDocument,
  windowsPtyOptions,
  type TerminalThemeProfile,
} from "./terminal-theme";
import {
  readTerminalAppearance,
  terminalFontFamily,
  terminalFontSize,
  TERMINAL_APPEARANCE_EVENT,
  TERMINAL_APPEARANCE_KEY,
  type TerminalAppearance,
} from "./terminal-appearance";
import { CodexComposerColors, codexComposerTheme } from "./codex-composer-colors";
import { TerminalReplyPolicy, isTerminalProtocolReply } from "./terminal-replies";

import { enhancedTerminalKey, decodeTerminalClipboard } from "./terminal-enhancements";
import { isFileDrag, droppedFiles, dropFilesError } from "./file-drop";
import { copyText } from "./clipboard";
import { createTerminalWriter, isRetryableTerminalRequestError, isTerminalAbortError, terminalRequest, TerminalRequestError } from "./terminal-client";
import { setXtermProbe } from "./terminal-probe";
import { TerminalOutputQueue } from "./terminal-output-queue";
import { TerminalPerformanceProbe } from "./terminal-performance";
import { appLog, oscTrace } from "./app-log";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "./image-attachments";
import type { TerminalEvent } from "./terminal-manager";
import type { TerminalStartupStage } from "../components/TerminalStartupProgress";

export type TerminalConnectionStatus = "connecting" | "ready" | "exited" | "error" | "paused";

export interface TerminalSessionParams {
  id: string;
  cwd: string;
  sshHost?: string;
  restored?: boolean;
  remote?: boolean;
  themeProfile?: TerminalThemeProfile;
  harnessKind?: string;
  conptyCursorHide?: boolean;
  cardId?: string;
  /** Manual frontend reconnect: behaves like a restore, but shows startup progress. */
  restarted?: boolean;
  /** Show the startup overlay until first output arrives. */
  showStartup?: boolean;
}

export interface TerminalSessionState {
  status: TerminalConnectionStatus;
  error: string | null;
  exitCode: number | null;
  startupStage: TerminalStartupStage;
  showStartup: boolean;
  clipboardPending: string | null;
  dragging: boolean;
  startedAt: number;
}

export interface TerminalSessionSink {
  onUpdate(state: TerminalSessionState): void;
  onOutput?(data: string): void;
  onClosed?(): void;
  onCloseError?(): void;
  onUnavailable?(): void;
  onOpenSearch?(): void;
  onSearchResults?(result: { resultIndex: number; resultCount: number }): void;
}

export interface TerminalSessionViewOptions {
  /** Selected for presentation; not DOM attachment or OS keyboard focus. */
  active: boolean;
  focusReporting: boolean;
  readOnly: boolean;
}

interface SessionView {
  container: HTMLElement;
  sink: { current: TerminalSessionSink };
  options: TerminalSessionViewOptions;
}

export function liveThemeProfile(themeProfile: TerminalThemeProfile | undefined, remote: boolean | undefined): TerminalThemeProfile | undefined {
  if (typeof document === "undefined") return themeProfile === "grok" ? "grok" : undefined;
  return resolveTerminalThemeProfile(themeProfile, terminalThemeHostFromDocument(remote, document.documentElement, navigator));
}

/**
 * A terminal session owns the xterm instance, its DOM host, the SSE stream and
 * the input writer for one terminal id. Views (TerminalPanel mounts) attach and
 * detach their container around it; while a session lives, the buffer is never
 * rebuilt, so moving a card between the deck, the inspection overlay and the
 * working list does not rebuild the terminal. A session that is actually
 * released rebuilds by replaying the server's SSE backlog.
 *
 * Several views can hold the same session (a suspended deck card underneath an
 * inspection overlay). The host element lives in the most recently attached
 * view; when that view detaches, the host rebinds to the next view on the
 * stack. The final selected view decides stream demand, including inactive
 * views that remain mounted in a queue or in the provider's parking area.
 */
export class TerminalSession {
  readonly id: string;
  readonly startedAt = Date.now();
  readonly host: HTMLDivElement;
  readonly search: SearchAddon;
  /** The current startup attempt; close waits for it before deleting the PTY. */
  started: Promise<void>;

  private params: TerminalSessionParams;
  private terminal: Terminal;
  private fit: FitAddon;
  private perf: TerminalPerformanceProbe;


  private writer: ReturnType<typeof createTerminalWriter>;
  private replyPolicy: TerminalReplyPolicy;
  private composerColors?: CodexComposerColors;
  private appearance: TerminalAppearance;
  private conptyHost: boolean;
  private gpu?: { dispose(): void };
  private gpuLoss?: { dispose(): void };
  private gpuLoading = false;
  private gpuGeneration = 0;
  private inactiveGpuTimer?: ReturnType<typeof setTimeout>;
  private viewReconcileQueued = false;
  private presented = false;
  private reportedFocus: boolean | undefined;
  private fitTimer = 0;
  private conptyCursorHidden = false;
  private conptyRevealTimer: ReturnType<typeof setTimeout> | undefined;

  private state: TerminalSessionState;
  private views: SessionView[] = [];

  private events: EventSource | null = null;
  private offset: number | undefined;

  private connected = false;
  private exited = false;
  private inputFailed = false;
  private serverReadOnly = false;
  private live = false;
  private replaying = true;
  private outputQueue = new TerminalOutputQueue<{
    data: string; reset?: boolean; ticket: ReturnType<TerminalPerformanceProbe["enqueue"]>;
  }>((batch, done) => {
    if (this.destroyed) { done(); return; }
    for (const item of batch) this.perf.start(item.ticket);
    const prepareAt = performance.now();
    this.replaying = batch[0].reset !== undefined;
    if (batch[0].reset) { this.terminal.reset(); this.composerColors?.reset(); }
    const raw = batch.map(item => item.data).join("");
    this.replyPolicy.observeOutput(raw);
    const data = this.composerColors?.feed(raw) ?? raw;
    const prepareMs = performance.now() - prepareAt;
    for (const item of batch) this.perf.prepared(item.ticket, prepareMs);
    this.terminal.write(data, () => {
      for (let i = 0; i < batch.length; i++) this.perf.complete(batch[i].ticket, i === batch.length - 1);
      this.replaying = false;
      if (!this.destroyed) this.sendFocusReport();
      done();
    });
  });
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private resyncing = false;
  private lastReset = false;
  private sseMessages = 0;
  private bytesWritten = 0;
  private skipped = 0;
  private gaps = 0;
  private droppedBytes = 0;
  private hasOutput = false;
  private pendingInput = "";
  private inputRaf = 0;
  private focusArmed = false;
  private closing = false;
  private destroyed = false;
  private startReady = false;
  private startFailed = false;
  private startPending = false;
  private retryStart = false;
  private startupDismissTimer?: ReturnType<typeof setTimeout>;

  constructor(params: TerminalSessionParams) {
    this.params = { ...params };
    this.id = params.id;
    const { id, remote, themeProfile, harnessKind, cardId } = params;

    const needsStartup = params.showStartup === true;
    this.hasOutput = !needsStartup;
    this.state = {
      status: "connecting",
      error: null,
      exitCode: null,
      startupStage: needsStartup ? "preparing" : "ready",
      showStartup: needsStartup,
      clipboardPending: null,
      dragging: false,
      startedAt: this.startedAt,
    };

    this.conptyHost = !remote && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
    this.replyPolicy = new TerminalReplyPolicy(this.conptyHost && document.documentElement.dataset.conptyFallback !== "true");
    this.appearance = readTerminalAppearance();
    this.composerColors = harnessKind === "codex" && this.appearance.codexAdaptiveBackground ? new CodexComposerColors() : undefined;

    this.host = document.createElement("div");
    this.host.className = "terminal-xterm-host";

    this.terminal = new Terminal({
      cursorBlink: !this.conptyHost,
      allowProposedApi: true,
      fontFamily: this.liveFont(),
      fontSize: this.liveFontSize(),
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
      windowsPty: windowsPtyOptions(this.conptyHost, document.documentElement),
      theme: this.liveTheme(),
    });

    this.fit = new FitAddon();
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.host);
    this.perf = new TerminalPerformanceProbe(() => ({
      live: this.live, presented: this.presented, visibility: document.visibilityState,
      renderer: this.gpu ? "webgl" : "dom", cols: this.terminal.cols, rows: this.terminal.rows,
      buffer: this.terminal.buffer.active.type,
      viewportY: this.terminal.buffer.active.viewportY, baseY: this.terminal.buffer.active.baseY,
    }), summary => {
      appLog("debug", "terminal-perf", JSON.stringify(summary), { card: this.params.cardId, term: this.id });
      this.publishProbe(this.state.status);
    });
    this.perf.watchRenderer(this.terminal);
    this.disposables.push(this.terminal.parser.registerCsiHandler({ final: "J" }, params => {
      if (typeof params[0] === "number") this.perf.clear(params[0]);
      return false;
    }));
    this.refreshAppearance();

    const appearanceChanged = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== TERMINAL_APPEARANCE_KEY && event.key !== null) return;
      this.appearance = event instanceof CustomEvent ? event.detail as TerminalAppearance : readTerminalAppearance();
      this.refreshAppearance();
    };
    window.addEventListener(TERMINAL_APPEARANCE_EVENT, appearanceChanged);
    window.addEventListener("storage", appearanceChanged);
    const themeObserver = new MutationObserver(this.refreshAppearance);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-desktop-platform", "data-terminal-bg", "style"] });
    this.themeObserver = themeObserver;
    this.appearanceChanged = appearanceChanged;

    this.host.addEventListener("wheel", this.preserveDeckGesture, { capture: true, passive: true });
    this.search = new SearchAddon();
    this.terminal.loadAddon(this.search);
    this.disposables.push(this.search.onDidChangeResults((result) => this.view?.sink.current.onSearchResults?.(result)));

    this.disposables.push(this.terminal.parser.registerOscHandler(52, (payload) => {
      if (this.replaying || this.destroyed || !document.hasFocus() || !this.host.contains(document.activeElement)) return true;
      const text = decodeTerminalClipboard(payload);
      if (text !== null) void copyText(text).catch(() => { if (!this.destroyed) this.patch({ clipboardPending: text }); });
      return true;
    }));
    // Modern ConPTY transports OSC replies. Answer live application queries,
    // including CLIs launched inside a shell; never answer historical output.
    // The inbox fallback retains its fixed palette and conservative policy.
    const swallowColorQueries = this.conptyHost && liveThemeProfile(themeProfile, remote) === "campbell";
    appLog("debug", "osc", `panel-mount swallow=${swallowColorQueries} harnessKind=${harnessKind ?? "none"} conpty=${this.conptyHost}`, { card: cardId, term: id });
    for (const ident of [4, 10, 11, 12]) {
      this.disposables.push(this.terminal.parser.registerOscHandler(ident, (data) => data.includes("?") && (this.replaying || swallowColorQueries)));
    }
    // Observe complete mode sequences in parser order. A replay can contain
    // enable/disable/enable together, and live chunks can split a sequence.
    for (const enabled of [true, false]) {
      this.disposables.push(this.terminal.parser.registerCsiHandler({ prefix: "?", final: enabled ? "h" : "l" }, (params) => {
        if (params.includes(1004)) {
          this.focusArmed = enabled;
          this.reportedFocus = undefined;
        }
        return false; // Let xterm apply the mode too.
      }));
    }

    this.writer = createTerminalWriter(id, (reason) => {
      if (this.destroyed) return;
      this.inputFailed = true;
      this.terminal.options.disableStdin = true;
      this.patch({ error: reason.message, status: "error" });
    });

    this.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing || event.keyCode === 229) return true;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const key = event.key.toLowerCase();
      if ((mac ? event.metaKey : event.ctrlKey) && key === "f") {
        event.preventDefault(); event.stopPropagation();
        this.view?.sink.current.onOpenSearch?.();
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && this.terminal.hasSelection()) return false;
      const data = enhancedTerminalKey(event, mac);
      if (data !== null) {
        event.preventDefault(); event.stopPropagation();
        this.sendInput(data);
        return false;
      }
      return true;
    });
    this.host.addEventListener("paste", this.onPaste, true);
    this.host.addEventListener("dragover", this.onDragOver);
    this.host.addEventListener("dragleave", this.onDragLeave);
    this.host.addEventListener("drop", this.onDrop);
    this.disposables.push(this.terminal.onData((data) => {
      oscTrace("xterm-onData", data, { card: cardId, term: id });
      this.sendInput(data);
    }));
    this.disposables.push(this.terminal.onBinary((data) => {
      if (this.destroyed || !this.connected || this.exited || this.inputFailed || this.readOnlyEffective() || this.terminal.options.disableStdin) return;
      // Legacy mouse coordinates are bytes, not UTF-8 text. Preserve their
      // order relative to any Windows keyboard input awaiting an animation frame.
      if (this.inputRaf) { cancelAnimationFrame(this.inputRaf); this.flushInput(); }
      this.writer.writeBinary(data);
    }));
    this.disposables.push(this.terminal.onResize(({ cols, rows }) => {
      if (this.connected && !this.exited && !this.inputFailed && !this.readOnlyEffective()) this.writer.resize(cols, rows);
    }));
    const resizeObserver = new ResizeObserver(this.fitAndResize);
    resizeObserver.observe(this.host);
    this.resizeObserver = resizeObserver;

    window.addEventListener("pagehide", this.pageHide);
    window.addEventListener("pageshow", this.pageShow);
    window.addEventListener("offline", this.pageHide);
    window.addEventListener("online", this.connect);

    this.started = this.start();
  }

  // ---------------------------------------------------------------- views

  private get view(): SessionView | undefined {
    return this.views[this.views.length - 1];
  }

  get attached(): boolean {
    return this.views.length > 0;
  }

  private emit() {
    this.view?.sink.current.onUpdate({ ...this.state });
  }

  private patch(partial: Partial<TerminalSessionState>) {
    Object.assign(this.state, partial);
    this.emit();
  }

  attach(container: HTMLElement, sink: { current: TerminalSessionSink }, options: TerminalSessionViewOptions): () => void {
    const entry: SessionView = { container, sink, options: { ...options } };
    this.views.push(entry);
    this.bindView(entry);
    touch(this);
    return () => this.detach(entry);
  }

  detach(entry: SessionView) {
    const index = this.views.indexOf(entry);
    if (index < 0) return;
    const wasTop = index === this.views.length - 1;
    this.views.splice(index, 1);
    if (!wasTop) return;
    // Flush input, but let the completed view handoff decide focus and stream.
    if (this.inputRaf) { cancelAnimationFrame(this.inputRaf); this.inputRaf = 0; }
    if (this.pendingInput) { this.writer.write(this.pendingInput); this.pendingInput = ""; }
    const next = this.view;
    if (next) {
      // appendChild moves the existing node: the terminal surface itself
      // migrates to the next view without losing a single cell.
      this.bindView(next);
      return;
    }
    this.reconcileView();
    this.host.remove();
    touch(this);
  }

  private bindView(entry: SessionView) {
    entry.container.appendChild(this.host);
    this.emit();
    this.refreshAppearance();
    this.fitAndResize();
    this.reconcileView();
  }

  setViewOptions(sink: { current: TerminalSessionSink }, next: Partial<TerminalSessionViewOptions>) {
    const entry = this.views.find((view) => view.sink === sink);
    if (!entry) return;
    const previous = entry.options;
    entry.options = { ...previous, ...next };
    if (entry !== this.view) return;
    this.reconcileView();
  }

  /** The only view-driven owner of stream demand, focus and GPU lifetime. */
  private reconcileView() {
    if (this.viewReconcileQueued || this.destroyed) return;
    this.viewReconcileQueued = true;
    queueMicrotask(() => {
      this.viewReconcileQueued = false;
      if (this.destroyed) return;
      const active = this.view?.options.active === true;
      const changed = active !== this.presented;
      this.presented = active;
      this.sendFocusReport();
      this.setLive(active);
      this.syncStdin();
      if (!changed) return;
      clearTimeout(this.inactiveGpuTimer);
      if (active) { this.loadGpu(); this.refreshPlacement(); this.focus(); }
      else this.inactiveGpuTimer = setTimeout(() => {
        if (!this.destroyed && !this.presented) this.disposeGpu();
      }, 300);
    });
  }

  focus() {
    if (this.destroyed || !this.attached) return;
    this.terminal.focus();
  }

  /** A persistent portal moved without mounting a new terminal view. */
  refreshPlacement() {
    if (this.destroyed || !this.view) return;
    this.refreshAppearance();
    this.fitAndResize();
  }

  clearClipboardPending() {
    this.patch({ clipboardPending: null });
  }

  setViewError(message: string) {
    this.patch({ error: message });
  }

  /** Closing the tab: stop input, delete the PTY, then report back. */
  async close() {
    this.closing = true;
    this.terminal.options.disableStdin = true;
    try { await this.started; } catch { /* Start already failed; still drop the tab. */ }
    await this.writer.stop();
    try {
      await terminalRequest(`/api/terminal/${encodeURIComponent(this.id)}`, { method: "DELETE", keepalive: true });
      this.currentSink()?.onClosed?.();
      discardTerminalSession(this.id);
    } catch (reason) {
      if (isTerminalAbortError(reason)) {
        this.currentSink()?.onClosed?.();
        discardTerminalSession(this.id);
        return;
      }
      this.patch({ error: reason instanceof Error ? reason.message : String(reason), status: "error" });
      this.currentSink()?.onCloseError?.();
    }
  }

  /** Dispose everything; the next attach rebuilds from the SSE backlog. */
  release() {
    if (this.destroyed) return;
    this.teardown();
  }

  /** The server side is already gone: dispose without rebuilding state. */
  discard() {
    if (this.destroyed) return;
    this.teardown();
  }

  private currentSink() {
    return this.view?.sink.current ?? null;
  }

  // ---------------------------------------------------------------- options

  matches(params: TerminalSessionParams) {
    return this.params.sshHost === params.sshHost
      && this.params.remote === params.remote
      && this.params.harnessKind === params.harnessKind;
  }

  /** Exited terminals retain their final screen; broken connections can rebuild. */
  get reusable() {
    return !this.destroyed && !this.inputFailed && !this.startFailed;
  }

  updateMutableParams(params: TerminalSessionParams) {
    this.params.cwd = params.cwd;
    this.params.themeProfile = params.themeProfile;
    this.params.conptyCursorHide = params.conptyCursorHide;
    this.params.cardId = params.cardId;
  }

  private readOnlyEffective() {
    return this.serverReadOnly || this.view?.options.readOnly === true;
  }

  private syncStdin() {
    this.terminal.options.disableStdin = !(this.presented && this.connected && !this.exited && !this.closing && !this.inputFailed && !this.readOnlyEffective());
  }

  // ---------------------------------------------------------------- theme

  private liveTheme() {
    const dark = documentCanvasDark(document.documentElement);
    const profile = liveThemeProfile(this.params.themeProfile, this.params.remote);
    const theme = harnessTerminalTheme(dark, profile, this.appearance[dark ? "dark" : "light"]);
    return this.composerColors ? codexComposerTheme(theme, profile === "campbell" || profile === "grok" || dark) : theme;
  }

  private liveFont() {
    return terminalFontFamily(this.appearance.font, getComputedStyle(this.host).getPropertyValue("--font-mono").trim() || "monospace");
  }

  private liveFontSize() {
    // Follow the settings font slider 1:1 (chat baseline 14px ↔ terminal 13px),
    // so one control scales both surfaces.
    const chat = Number.parseFloat(getComputedStyle(this.host).getPropertyValue("--chat-content-font-size"));
    return terminalFontSize(chat);
  }

  private refreshAppearance = () => {
    if (!this.host.isConnected) return;
    const theme = this.liveTheme();
    if (JSON.stringify(theme) !== JSON.stringify(this.terminal.options.theme)) this.terminal.options.theme = theme;
    this.host.closest<HTMLElement>(".terminal-panel")?.style.setProperty("--terminal-bg", theme.background!);
    const size = this.liveFontSize();
    const font = this.liveFont();
    if (size !== this.terminal.options.fontSize || font !== this.terminal.options.fontFamily) {
      this.terminal.options.fontSize = size;
      this.terminal.options.fontFamily = font;
      this.fitAndResize();
      void document.fonts.load(`${size}px ${font}`).then(() => {
        if (!this.destroyed) {
          this.fitAndResize();
          this.terminal.refresh(0, this.terminal.rows - 1);
        }
      });
    }
  };

  private appearanceChanged: (event: Event) => void = () => {};

  // ---------------------------------------------------------------- input

  private sendFocusReport() {
    if (!this.focusArmed || this.destroyed || this.closing || this.exited || this.inputFailed
      || !this.connected || this.replaying || this.readOnlyEffective()) return;
    const focused = this.view?.options.focusReporting === true && this.presented;
    if (focused === this.reportedFocus) return;
    if (!this.view?.options.focusReporting && this.reportedFocus !== true) return;
    this.reportedFocus = focused;
    this.writer.write(focused ? "\x1b[I" : "\x1b[O");
  }

  private flushInput = () => {
    this.inputRaf = 0;
    const data = this.pendingInput;
    this.pendingInput = "";
    if (data && this.connected && !this.exited && !this.inputFailed && !this.readOnlyEffective()) this.writer.write(data, true);
  };

  private sendInput(data: string) {
    if (this.exited || this.inputFailed || this.readOnlyEffective()) return;
    // Replies share the input channel. Filter replay and the already-answered
    // native startup handshake, not normal live application probes.
    if (this.replyPolicy.suppress(data, this.replaying, this.view?.options.focusReporting === true)) return;
    if (!this.connected || this.terminal.options.disableStdin) return;
    if (isTerminalProtocolReply(data)) { this.writer.reply(data); return; }
    if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data)) { this.writer.write(data); return; }
    if (!this.conptyHost) { this.writer.write(data, true); return; }
    // One HTTP POST per animation frame instead of one per keystroke.
    this.pendingInput += data;
    if (!this.inputRaf) this.inputRaf = requestAnimationFrame(this.flushInput);
  }

  private onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.connected || this.exited || this.inputFailed || this.readOnlyEffective() || this.terminal.options.disableStdin) return;
    if (files.length > MAX_ATTACHED_IMAGES || files.some((file) => file.size > MAX_ATTACHED_IMAGE_BYTES)) {
      this.patch({ error: "Paste up to 10 images, each 10 MB or smaller." });
      return;
    }
    this.patch({ error: null });
    if (this.inputRaf) { cancelAnimationFrame(this.inputRaf); this.flushInput(); }
    this.writer.pasteImages(files, this.terminal.modes.bracketedPasteMode);
  };

  private onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer || !isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const writable = this.connected && !this.exited && !this.inputFailed && !this.readOnlyEffective() && !this.terminal.options.disableStdin;
    event.dataTransfer.dropEffect = writable ? "copy" : "none";
    this.patch({ dragging: writable });
  };

  private onDragLeave = (event: DragEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.host.contains(event.relatedTarget)) this.patch({ dragging: false });
  };

  private onDrop = (event: DragEvent) => {
    if (!event.dataTransfer || !isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    this.patch({ dragging: false });
    if (!this.connected || this.exited || this.inputFailed || this.readOnlyEffective() || this.terminal.options.disableStdin) return;
    try {
      const files = droppedFiles(event.dataTransfer);
      const reason = dropFilesError(files);
      if (reason) throw new Error(reason);
      if (files.length) {
        this.patch({ error: null });
        if (this.inputRaf) { cancelAnimationFrame(this.inputRaf); this.flushInput(); }
        this.writer.pasteFiles(files, this.terminal.modes.bracketedPasteMode);
        this.terminal.focus();
      }
    } catch (reason) {
      this.patch({ error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  // Let native horizontal gestures reach the card deck without xterm turning
  // them into terminal input or cancelling them. Vertical terminal scrolling
  // and detached terminals keep their existing behavior.
  private preserveDeckGesture = (event: WheelEvent) => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) && this.host.closest(".cq-deck-scroller")) {
      event.stopPropagation();
    }
  };

  // ---------------------------------------------------------------- layout

  private fitAndResize = () => {
    if (this.destroyed || this.fitTimer) return;
    // Reparenting and header portals can change layout several times in one
    // commit. Only send the final dimensions, not intermediate empty headers.
    // xterm clears/resizes the canvas synchronously, then draws in its own RAF.
    // Running fit inside our RAF exposes the cleared canvas until the next frame.
    // A task coalesces layout changes while letting xterm draw at the next paint.
    this.fitTimer = window.setTimeout(() => {
      this.fitTimer = 0;
      if (this.destroyed || !this.host.isConnected || !this.host.offsetWidth || !this.host.offsetHeight) return;
      this.fit.fit();
      if (this.connected && !this.exited && !this.inputFailed && !this.readOnlyEffective()) {
        this.writer.resize(this.terminal.cols, this.terminal.rows);
      }
    });
  };

  private hideConptyCursor() {
    if (!this.conptyHost || this.gpu || this.params.conptyCursorHide === false) return;
    // Reveal only after output goes quiet. A short window strobes the cursor
    // while streaming TUIs (Codex spinner) emit chunks faster than the timer.
    clearTimeout(this.conptyRevealTimer);
    if (!this.conptyCursorHidden) {
      this.conptyCursorHidden = true;
      this.host.classList.add("is-conpty-redraw");
    }
    this.conptyRevealTimer = setTimeout(() => {
      this.conptyCursorHidden = false;
      if (!this.destroyed) this.host.classList.remove("is-conpty-redraw");
    }, 250);
  }

  // WebGL custom glyphs fill block cells exactly; DOM font glyphs leave
  // vertical seams on Windows. Parked sessions release the context so idle
  // cards cannot exhaust the browser's WebGL context budget.
  private loadGpu() {
    if (this.gpu || this.gpuLoading || this.destroyed || !this.view?.options.active) return;
    this.gpuLoading = true;
    const generation = this.gpuGeneration;
    void import("@xterm/addon-webgl").then(({ WebglAddon }) => {
      if (generation !== this.gpuGeneration || this.destroyed || !this.view?.options.active || this.gpu) return;
      const addon = new WebglAddon();
      try {
        this.terminal.loadAddon(addon);
        this.gpu = addon;
        this.perf.watchRenderer(this.terminal);
        clearTimeout(this.conptyRevealTimer);
        this.conptyCursorHidden = false;
        this.host.classList.remove("is-conpty-redraw");
        this.gpuLoss = addon.onContextLoss(() => {
          this.gpuLoss?.dispose(); this.gpuLoss = undefined;
          this.gpu?.dispose(); this.gpu = undefined;
          this.perf.watchRenderer(this.terminal);
          this.terminal.refresh(0, this.terminal.rows - 1);
        });
        this.terminal.refresh(0, this.terminal.rows - 1);
      } catch { addon.dispose(); }
    }).catch(() => { /* DOM rendering remains available. */ }).finally(() => {
      if (generation === this.gpuGeneration) this.gpuLoading = false;
    });
  }

  private disposeGpu() {
    this.gpuGeneration++;
    this.gpuLoading = false;
    this.gpuLoss?.dispose();
    this.gpuLoss = undefined;
    this.gpu?.dispose();
    this.gpu = undefined;
    if (!this.destroyed) this.perf.watchRenderer(this.terminal);
  }

  // ---------------------------------------------------------------- stream

  private publishProbe(statusName: string) {
    setXtermProbe(this.id, {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      sseMessages: this.sseMessages,
      bytesWritten: this.bytesWritten,
      performance: this.perf.snapshot(),
      lastOffset: this.offset,
      lastReset: this.lastReset,
      gaps: this.gaps,
      dropped: this.droppedBytes,
      status: `${statusName}${this.skipped ? ` skip=${this.skipped}` : ""}${this.gaps ? ` gaps=${this.gaps}` : ""}${this.droppedBytes ? ` dropped=${this.droppedBytes}B` : ""}`,
    });
  }

  // Native EventSource retry would reuse the URL captured at connect time,
  // including a stale `after` cursor. Always rebuild the request with the
  // offset we actually hold so the server replays exactly what we missed.
  private scheduleReconnect() {
    if (this.destroyed || this.exited || this.closing || this.inputFailed || !this.live) return;
    this.connected = false;
    this.syncStdin();
    this.events?.close();
    this.events = null;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(this.connect, delay);
  }

  // Parked sessions must not hold a live SSE: every attached panel opens one
  // and the WebView caps concurrent connections per host, so background streams
  // starve the foreground ones and connections visibly "drop". Pausing keeps
  // the offset; resuming replays exactly the missed range from the backlog.
  private setLive(on: boolean) {
    if (this.destroyed || this.exited) return;
    if (on === this.live) {
      // A session that was never live still reports "paused", matching what a
      // mount-then-pause cycle used to leave behind.
      if (!on && (this.state.status === "connecting" || this.state.status === "ready")) this.patch({ status: "paused" });
      return;
    }
    this.live = on;
    if (on) {
      this.reconnectAttempt = 0;
      this.resyncing = false;
      this.patch({ status: "connecting" });
      this.connect();
      return;
    }
    if (this.inputRaf) { cancelAnimationFrame(this.inputRaf); this.flushInput(); }
    this.connected = false;
    this.terminal.options.disableStdin = true;
    clearTimeout(this.reconnectTimer);
    this.events?.close();
    this.events = null;
    appLog("debug", "sse", "pause", { card: this.params.cardId, term: this.id });
    if (this.state.status === "connecting" || this.state.status === "ready") this.patch({ status: "paused" });
  }

  private enqueueOutput(event: Extract<TerminalEvent, { type: "output" }>, jsonMs = 0) {
    const ticket = this.perf.enqueue(event.data.length, event.offset, event.reset, jsonMs);
    oscTrace("sse-recv", event.data, { card: this.params.cardId, term: this.id });
    this.hideConptyCursor();
    this.bytesWritten += event.data.length;
    if (event.data.length > 0 && !this.hasOutput) {
      this.hasOutput = true;
      this.patch({ startupStage: "ready" });
      // TerminalStartupProgress fades out over ~700ms; keep the flag until the
      // fade completes so reattaching views don't replay the overlay.
      clearTimeout(this.startupDismissTimer);
      this.startupDismissTimer = setTimeout(() => this.patch({ showStartup: false }), 1200);
    }
    this.outputQueue.enqueue({ data: event.data, reset: event.reset, ticket });
    this.currentSink()?.onOutput?.(event.data);
    this.offset = event.offset;
    this.publishProbe("ready");
  }

  private connect = () => {
    if (this.destroyed || this.exited || this.closing || this.inputFailed || !this.live || !navigator.onLine) return;
    clearTimeout(this.reconnectTimer);
    if (!this.startReady) {
      if (this.retryStart && !this.startPending) this.started = this.start();
      return;
    }
    this.connected = false;
    this.syncStdin();
    this.events?.close();
    // Always hand the server the offset we actually hold. Omitting it when
    // `offset === undefined` is correct (nothing read yet, full replay is what
    // we want), but once we have an offset it must ride along on *every*
    // reconnect — the browser drops its internal lastEventId when we close the
    // stream, so `?after=` is the only cursor the server can trust. Without it
    // a resume after a pause degrades into a reset that replays just the
    // backlog, and anything trimmed in the meantime is lost with no signal.
    const events = new EventSource(`/api/terminal/${encodeURIComponent(this.id)}/events${this.offset === undefined ? "" : `?after=${this.offset}`}`);
    this.events = events;
    const current = () => !this.destroyed && !this.exited && this.live && this.events === events;
    events.onmessage = (message) => {
      if (!current()) return;
      const jsonAt = performance.now();
      const event = JSON.parse(message.data) as TerminalEvent;
      const jsonMs = performance.now() - jsonAt;
      this.sseMessages += 1;
      if (event.type === "output") {
        this.reconnectAttempt = 0;
        if (event.reset) {
          // Full replay: the server trimmed past our cursor (or this is the
          // first attach). Wipe and redraw instead of splicing.
          this.lastReset = true;
          this.resyncing = false;
          if (typeof event.dropped === "number" && event.dropped > 0) {
            // The redraw is not a superset of what we had — bytes are gone for
            // good. Say so; a silent wipe reads as "nothing happened".
            this.droppedBytes += event.dropped;
            appLog("warn", "sse", `replay lost ${event.dropped}B cursor=${this.offset ?? "none"}`, { card: this.params.cardId, term: this.id });
          }
          this.enqueueOutput(event, jsonMs);
          return;
        }
        const from = event.from ?? this.offset ?? event.offset;
        if (this.offset !== undefined && event.offset <= this.offset) {
          this.skipped += 1;
          this.publishProbe("ready");
          return;
        }
        if (this.offset !== undefined && from !== this.offset) {
          // Byte gap (dropped SSE consumer) or partial overlap: never render
          // the hole — reconnect so the server replays the missing range.
          this.gaps += 1;
          if (!this.resyncing) {
            this.resyncing = true;
            appLog("warn", "sse", `gap resync from=${from} have=${this.offset} got=${event.offset}`, { card: this.params.cardId, term: this.id });
            this.publishProbe("resync");
            this.scheduleReconnect();
          }
          return;
        }
        this.enqueueOutput(event, jsonMs);
      } else {
        this.exited = true;
        this.connected = false;
        this.terminal.options.disableStdin = true;
        clearTimeout(this.reconnectTimer);
        this.events?.close();
        this.events = null;
        this.patch({ exitCode: event.type === "exit" ? event.exitCode : null, status: "exited" });
      }
    };
    events.onopen = () => {
      if (!current()) return;
      this.connected = true;
      this.resyncing = false;
      if (this.inputFailed) return;
      this.syncStdin();
      this.patch({ status: "ready" });
      this.sendFocusReport();
      if (!this.hasOutput) this.patch({ startupStage: "waiting_output" });
      // The detached window may have changed the PTY while we were paused.
      // Our xterm can still have its old size, so onResize need not fire and
      // the writer must not suppress the next fit's explicit size update.
      this.writer.invalidateSize();
      this.fitAndResize();
      if (this.host.offsetWidth && this.host.offsetHeight) this.terminal.focus();
      this.publishProbe("ready");
    };
    events.onerror = () => {
      if (!current()) return;
      this.connected = false;
      this.terminal.options.disableStdin = true;
      appLog("warn", "sse", `error after=${this.offset ?? "none"} attempt=${this.reconnectAttempt}`, { card: this.params.cardId, term: this.id });
      this.patch({ status: "connecting" });
      if (!this.hasOutput && this.reconnectAttempt >= 2) {
        this.patch({ startupStage: "error" });
      }
      this.scheduleReconnect();
    };
  };

  private async start() {
    const { id, cwd, sshHost, restored, cardId } = this.params;
    this.startPending = true;
    this.retryStart = false;
    let checkingExisting = false;
    try {
      this.fitAndResize();
      if (restored || this.params.restarted) {
        // Restoring a tab must never silently launch a replacement shell for local processes,
        // but remote sessions (sshHost) with tmux should re-attach to their existing remote session.
        try {
          checkingExisting = true;
          const info = await terminalRequest(`/api/terminal/${encodeURIComponent(id)}`);
          checkingExisting = false;
          this.serverReadOnly ||= info.readOnly === true;
        } catch (error) {
          // Network failures do not prove the PTY is gone. In particular, do
          // not let onUnavailable delete a running side terminal on a 5xx.
          if (!(error instanceof TerminalRequestError) || error.status !== 404) throw error;
          checkingExisting = false;
          if (this.destroyed || this.closing) return;
          if (sshHost && !this.readOnlyEffective()) {
            await terminalRequest("/api/terminal", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id, cwd, cols: this.terminal.cols, rows: this.terminal.rows, sshHost, ...(cardId ? { cardId } : {}) }),
            });
          } else {
            if (restored) this.currentSink()?.onUnavailable?.();
            throw error;
          }
        }
      } else {
        await terminalRequest("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, cwd, cols: this.terminal.cols, rows: this.terminal.rows, ...(sshHost ? { sshHost } : {}), ...(cardId ? { cardId } : {}) }),
        });
      }
      if (this.destroyed || this.closing) return;
      this.startFailed = false;
      this.patch({ error: null, status: this.live ? "connecting" : "paused" });
      if (!this.hasOutput) {
        this.patch({ startupStage: "connecting" });
      }
      this.startReady = true;
      this.connect();
    } catch (reason) {
      if (this.destroyed || this.closing) return;
      // Only retry the read-only existence check. A failed create may already
      // have launched a process; never automatically repeat that mutation.
      this.retryStart = checkingExisting && isRetryableTerminalRequestError(reason);
      this.startFailed = !this.retryStart;
      const message = reason instanceof Error ? reason.message : String(reason);
      this.patch({ error: message, status: "error" });
      if (!this.hasOutput) {
        this.patch({ startupStage: "error", showStartup: true });
      }
      if (this.retryStart) this.scheduleReconnect();
    } finally {
      this.startPending = false;
    }
  }

  private pageHide = () => {
    this.connected = false;
    this.terminal.options.disableStdin = true;
    clearTimeout(this.reconnectTimer);
    this.events?.close();
    this.events = null;
    if (!this.exited && !this.inputFailed) this.patch({ status: this.live ? "connecting" : "paused" });
  };

  private pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) {
      this.reconnectAttempt = 0;
      this.resyncing = false;
      this.connect();
    }
  };

  // ---------------------------------------------------------------- teardown

  private teardown() {
    this.destroyed = true;
    this.outputQueue.dispose();
    this.perf.dispose();
    while (this.views.length) this.detach(this.views[this.views.length - 1]);
    clearTimeout(this.inactiveGpuTimer);
    clearTimeout(this.fitTimer);
    clearTimeout(this.conptyRevealTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.startupDismissTimer);
    if (this.inputRaf) cancelAnimationFrame(this.inputRaf);
    this.pendingInput = "";
    this.events?.close();
    void this.writer.stop();
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    window.removeEventListener(TERMINAL_APPEARANCE_EVENT, this.appearanceChanged);
    window.removeEventListener("storage", this.appearanceChanged);
    this.host.removeEventListener("paste", this.onPaste, true);
    this.host.removeEventListener("dragover", this.onDragOver);
    this.host.removeEventListener("dragleave", this.onDragLeave);
    this.host.removeEventListener("drop", this.onDrop);
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables = [];
    window.removeEventListener("pagehide", this.pageHide);
    window.removeEventListener("pageshow", this.pageShow);
    window.removeEventListener("offline", this.pageHide);
    window.removeEventListener("online", this.connect);
    this.disposeGpu();
    this.host.removeEventListener("wheel", this.preserveDeckGesture, true);
    this.host.remove();
    this.terminal.dispose();
  }

  private disposables: { dispose(): void }[] = [];
  private resizeObserver?: ResizeObserver;
  private themeObserver?: MutationObserver;
}

// ------------------------------------------------------------------ pool

const pool = new Map<string, TerminalSession>();
// Only fully detached sessions are evicted; rebuilding one costs a one-time
// SSE backlog replay, never data loss — the PTY keeps running.
const MAX_PARKED_SESSIONS = 32;

function touch(session: TerminalSession) {
  if (!pool.has(session.id)) return;
  pool.delete(session.id);
  pool.set(session.id, session);
}

function evictParkedSessions() {
  const parked = [...pool.values()].filter((session) => !session.attached);
  while (parked.length > MAX_PARKED_SESSIONS) {
    const victim = parked.shift();
    if (!victim) break;
    pool.delete(victim.id);
    victim.release();
  }
}

/**
 * Reuse the live session for this terminal id, or create one. A session whose
 * creation parameters no longer match — or one that already died — is released
 * and rebuilt, matching what a fresh mount used to do.
 */
export function acquireTerminalSession(params: TerminalSessionParams): TerminalSession {
  const existing = pool.get(params.id);
  if (existing) {
    if (existing.matches(params) && existing.reusable) {
      existing.updateMutableParams(params);
      touch(existing);
      return existing;
    }
    pool.delete(params.id);
    existing.release();
  }
  const session = new TerminalSession(params);
  pool.set(session.id, session);
  evictParkedSessions();
  return session;
}

/** Dispose the frontend session; the PTY keeps running. */
export function releaseTerminalSession(id: string) {
  const session = pool.get(id);
  if (!session) return;
  pool.delete(id);
  session.release();
}

/** The server-side terminal is already deleted: dispose without rebuilding. */
export function discardTerminalSession(id: string) {
  const session = pool.get(id);
  if (!session) return;
  pool.delete(id);
  session.discard();
}

export function peekTerminalSession(id: string) {
  return pool.get(id);
}
