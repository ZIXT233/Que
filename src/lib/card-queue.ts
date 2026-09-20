import type { SessionInfo } from "./types.ts";

export type CardPhase = "draft" | "working" | "attention";
export interface QueueWorkspace {
  id: string;
  name: string;
  kind: "local" | "ssh";
  cwd: string;
  sshHost?: string;
  runtimeCwd: string;
  defaultConversationWeight?: number;
}
export interface QueueCard {
  harness?: import("./harness/types").HarnessSession;
  promptSources?: import("./prompt-sources").PromptSourcesConfig;
  id: string;
  cwd: string;
  workspaceId?: string;
  session: SessionInfo | null;
  phase: CardPhase;
  manualPlacement?: { background: boolean; terminalId: string; observedState: string };
  createdAt: number;
  readyAt?: number;
  priorityWeight?: number;
  waitingSince?: number;
  turnKey?: string;
  urgentCall?: import("./urgent-call.ts").UrgentCall;
  turnTags?: string[];
  tagEvaluation?: { status: "pending" | "done" | "error"; error?: string; startedAt: number; definitions: import("./turn-priority").TurnTag[]; result?: unknown };
  tagHistory?: { turnKey: string; evaluatedAt: number; definitions: import("./turn-priority").TurnTag[]; result?: unknown; error?: string }[];
  archivedAt?: number;
  /** Unix ms deadline while the card is parked in "remind me later". */
  remindAt?: number;
  detached?: { owner: string; expiresAt: number };
  sideTerminals?: { id: string; cwd: string }[];
  sideTerminalOpen?: boolean;
  /**
   * A session Que never launched (Cursor IDE, another terminal). Composed client-side
   * from the `external` overlay so it rides the deck like any card — same size, same
   * slide — while staying out of `queue.json` and out of every scheduler decision.
   */
  externalNotice?: ExternalNotice;
}
/** One message of an external session's own record, in transcript order. */
export interface ExternalTurn {
  role: "user" | "assistant";
  text: string;
}

/** An attention call from a session Que never launched (Cursor IDE, another terminal). */
export interface ExternalNotice {
  /** Provider conversation id, or the workspace path when the CLI reports none. */
  id: string;
  kind: string;
  sessionId?: string;
  /** Last path segment of the workspace the session is working in. */
  project?: string;
  /** Full workspace directory, so the card can name the folder it is really in. */
  cwd?: string;
  /** Real session title from the provider's own store, when it can be read. */
  sessionName?: string;
  /** Latest user prompt: the ask whose turn just ended. */
  prompt?: string;
  /** Tail of the conversation, oldest first. Empty when only the hook reported it. */
  turns?: ExternalTurn[];
  /** "attention" while the session wants a human, "working" while it has the floor. */
  state: "attention" | "working";
  /** The reply itself; a notice has no terminal, so this is the card's content. */
  preview?: string;
  notification?: string;
  tool?: string;
  priorityWeight?: number;
  waitingSince?: number;
  at: number;
}

export function toExternalCard(notice: ExternalNotice): QueueCard {
  return {
    id: `external:${notice.id}`,
    cwd: notice.cwd ?? notice.project ?? "",
    session: null,
    phase: notice.state === "working" ? ("working" as const) : ("attention" as const),
    createdAt: notice.at,
    readyAt: notice.at,
    // The scheduler never sees these, but sorting must stay stable if it ever does.
    waitingSince: notice.waitingSince ?? notice.at,
    priorityWeight: notice.priorityWeight,
    externalNotice: notice,
  };
}

/**
 * Present an external notice as a card the deck can lay out. It carries no session
 * and no harness, so every queue action that keys off those stays inert; the id is
 * namespaced so it can never collide with a real card (or another overlay entry).
 * Only the ones that want a human belong on the deck.
 */
export function externalQueueCards(notices: ExternalNotice[] | undefined): QueueCard[] {
  return (notices ?? []).filter((notice) => notice.state === "attention").map(toExternalCard);
}

/**
 * Sessions working outside Que. They are not cards — there is no terminal to open and
 * nothing to type into — so the sidebar lists them as background entries.
 */
export function externalWorkingNotices(notices: ExternalNotice[] | undefined): ExternalNotice[] {
  return (notices ?? []).filter((notice) => notice.state === "working");
}

/** What the notice is about: the session's own name, else the ask, else the folder. */
export function externalNoticeTitle(notice: ExternalNotice): string | undefined {
  return notice.sessionName ?? notice.prompt ?? notice.project;
}

/**
 * Identity of one ask, not of one session: the same chat can come back with a newer
 * request, and that is a new arrival for the banner even though the card is the same.
 */
export function externalNoticeKey(notice: ExternalNotice): string {
  return `${notice.id}:${notice.at}`;
}

/**
 * Notices that were not in the previous snapshot. `null` means nothing has been
 * seen yet, which only arms the comparison: a first snapshot must never announce
 * the notices that were already on screen when the page loaded.
 */
export function newExternalNotices(previous: string[] | null, notices: ExternalNotice[] | undefined): ExternalNotice[] {
  if (!previous) return [];
  const before = new Set(previous);
  return (notices ?? []).filter((notice) => !before.has(externalNoticeKey(notice)));
}

export interface CardQueue {
  version: 1;
  revision: number;
  cards: QueueCard[];
  order: string[];
  turnTagsEnabled?: boolean;
  sortMode?: "fifo" | "score";
  turnTagDefinitions?: import("./turn-priority").TurnTag[];
  insertionPosition?: "top" | "bottom";
  workspaces?: QueueWorkspace[];
  /** Read-only overlay computed on every snapshot; never persisted with the queue. */
  external?: ExternalNotice[];
}
export const EMPTY_QUEUE: CardQueue = { version: 1, revision: 0, cards: [], order: [], sortMode: "score", turnTagsEnabled: false, insertionPosition: "bottom" };

export function startableHarnessCards(cards: QueueCard[]) {
  return cards.filter((card) => card.harness
    && card.archivedAt === undefined
    && (card.harness.state === "exited" || card.harness.state === "error"));
}
export const TAB_LEASE_MS = 120_000;

export function reconcileQueue(state: CardQueue, running: Set<string>, attention: Set<string>, now = Date.now()): CardQueue {
  const next: CardQueue = structuredClone(state);
  for (const card of next.cards) {
    if (card.detached && card.detached.expiresAt <= now) delete card.detached;
    if (!card.session && !card.harness) continue;
    const sessionId = card.session?.id ?? card.id;
    let phase: CardPhase = card.harness ? (card.harness.state === "working" ? "working" : "attention") : attention.has(sessionId) ? "attention" : running.has(sessionId) ? "working" : "attention";
    if (card.manualPlacement) {
      const h = card.harness;
      if (card.archivedAt === undefined && h && h.terminalId === card.manualPlacement.terminalId && h.state === card.manualPlacement.observedState && h.state !== "exited" && h.state !== "error") {
        phase = card.manualPlacement.background ? "working" : "attention";
      } else delete card.manualPlacement;
    }
    if (card.archivedAt !== undefined) {
      if (phase === "working" || attention.has(sessionId)) delete card.archivedAt;
      else { next.order = next.order.filter((id) => id !== card.id); continue; }
    }
    if (phase === "working") {
      next.order = next.order.filter((id) => id !== card.id);
      delete card.readyAt; delete card.waitingSince; delete card.turnKey;
      delete card.turnTags; delete card.tagEvaluation; delete card.urgentCall; delete card.remindAt;
    }
    else if (card.remindAt !== undefined) {
      if (card.remindAt <= now) {
        // Expired reminder: re-enter the queue at the sort-mode position.
        delete card.remindAt;
        if (next.sortMode === "score") card.waitingSince = now;
        card.readyAt ??= now;
        if (!next.order.includes(card.id)) {
          if (next.insertionPosition === "top") next.order.unshift(card.id);
          else next.order.push(card.id);
        }
      } else next.order = next.order.filter((id) => id !== card.id);
    }
    else if (!next.order.includes(card.id)) {
      card.readyAt ??= now;
      if (next.insertionPosition === "top") next.order.unshift(card.id);
      else next.order.push(card.id);
    }
    if (phase === "attention") card.readyAt ??= now;
    card.phase = phase;
  }
  next.order = [...new Set(next.order)].filter((id) => next.cards.some((card) => card.id === id && card.phase !== "working"));
  pinDraft(next);
  return next;
}

export function moveCard(state: CardQueue, id: string, position: "front" | "back"): void {
  const card = state.cards.find((item) => item.id === id);
  if (!card || card.phase === "working") return;
  delete card.archivedAt;
  state.order = state.order.filter((item) => item !== id);
  if (position === "front") state.order.unshift(id);
  else state.order.push(id);
  pinDraft(state);
}

export function releaseCard(card: QueueCard, owner: string): void {
  // A stale pagehide must never release a newer tab's claim.
  if (card.detached?.owner === owner) delete card.detached;
}

/** Keep one unsent composer outside the attention queue. */
export function pinDraft(state: CardQueue): void {
  const drafts = state.cards.filter((card) => !card.session && !card.harness);
  const draft = drafts.reduce<QueueCard | undefined>((latest, card) => !latest || card.createdAt > latest.createdAt ? card : latest, undefined);
  if (!draft) return;
  state.cards = state.cards.filter((card) => card.session || card.harness || card.id === draft.id);
  const ids = new Set(state.cards.filter((card) => card.session || card.harness).map((card) => card.id));
  state.order = state.order.filter((id) => ids.has(id));
}

export function archiveCard(state: CardQueue, id: string, now = Date.now()): void {
  const card = state.cards.find((item) => item.id === id);
  if (!card || (!card.session && !card.harness)) throw new Error("空白卡片无需归档");
  if (card.phase === "working" || card.detached) throw new Error("请先结束工作并收回卡片");
  card.archivedAt = now;
  state.order = state.order.filter((item) => item !== id);
}

export function filterHistoricalSessions(sessions: SessionInfo[], cards: QueueCard[], query = ""): SessionInfo[] {
  const activeIds = new Set(cards.flatMap((card) => card.session && card.archivedAt === undefined ? [card.session.id] : []));
  for (const card of cards) if (card.harness?.kind === "pi" && card.harness.providerSessionId) activeIds.add(card.harness.providerSessionId);
  const search = query.trim().toLowerCase();
  return sessions.filter((session) => !activeIds.has(session.id)
    && `${session.name} ${session.firstMessage} ${session.cwd}`.toLowerCase().includes(search));
}

/** Put a queue card into the "remind me later" parking list until remindAt. */
export function parkRemind(state: CardQueue, id: string, remindAt: number): void {
  const card = state.cards.find((item) => item.id === id);
  if (!card || (!card.session && !card.harness) || card.phase === "working" || card.archivedAt !== undefined) return;
  card.remindAt = remindAt;
  state.order = state.order.filter((item) => item !== id);
  pinDraft(state);
}

/** Wake a remind-later card and re-enter it at the position implied by the
 * active sort mode: score mode restarts the Wait clock; FIFO re-inserts at
 * the insertion edge. */
export function releaseRemind(state: CardQueue, id: string, now = Date.now()): void {
  const card = state.cards.find((item) => item.id === id);
  if (!card || card.remindAt === undefined) return;
  card.remindAt = undefined;
  if (state.sortMode === "score") card.waitingSince = now;
  card.readyAt ??= now;
  if (!state.order.includes(id)) {
    if (state.insertionPosition === "top") state.order.unshift(id);
    else state.order.push(id);
  }
  pinDraft(state);
}
