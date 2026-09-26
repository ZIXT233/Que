import { startableHarnessCards, type QueueCard, type QueueWorkspace } from "../card-queue";

type Failure = { card: QueueCard; error: unknown; skipped: boolean };
type Options = {
  getCards: () => QueueCard[];
  workspaces: QueueWorkspace[];
  launch: (action: string, data: { id: string }) => Promise<unknown>;
};

const connectionFailures = new Set([
  "TIMEOUT", "CONNECTION_FAILED", "REFUSED", "HOST_NOT_FOUND", "SOCKET_PATH",
  "HOST_TRUST_REQUIRED", "HOST_KEY", "AUTH_REQUIRED", "HOST_INVALID", "HOST_DELETED",
]);
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";

/** One batch per page, regardless of which card's recovery button was clicked. */
export function createHarnessBatchStarter() {
  let running: Promise<Failure[]> | undefined;
  return (options: Options): Promise<Failure[]> => {
    if (running) return running;
    running = Promise.resolve().then(() => startAll(options)).finally(() => { running = undefined; });
    return running;
  };
}

async function startAll({ getCards, workspaces, launch }: Options): Promise<Failure[]> {
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const groups = new Map<string, { remote: boolean; ids: string[] }>();
  const candidates = startableHarnessCards(getCards());
  for (const card of candidates) {
    const workspace = workspaceById.get(card.workspaceId ?? "");
    const remote = workspace?.kind === "ssh";
    const key = remote ? `ssh:${workspace.sshHost || workspace.id}` : "local";
    const group = groups.get(key) ?? { remote, ids: [] };
    group.ids.push(card.id);
    groups.set(key, group);
  }
  // Local starts have their own lane and never sit behind SSH timeouts. Keep
  // one launch per host in flight and cap the number of concurrent host lanes.
  const pending = [...groups.values()].sort((a, b) => Number(a.remote) - Number(b.remote));
  const failures = new Map<string, Failure>();
  const worker = async () => {
    for (let group = pending.shift(); group; group = pending.shift()) {
      let hostFailure: unknown;
      for (const id of group.ids) {
        // The batch may have waited while another window started or archived
        // this card. Never act on the original snapshot's stale state.
        const card = startableHarnessCards(getCards()).find(card => card.id === id);
        if (!card?.harness) continue;
        if (hostFailure) {
          failures.set(id, { card, error: hostFailure, skipped: true });
          continue;
        }
        try {
          await launch(card.harness.providerSessionId ? "harness_resume" : "harness_reopen", { id });
        } catch (error) {
          const code = errorCode(error);
          // Backend guards remain authoritative if a different window won
          // the race. Joining an existing start must not look like a failure.
          if (code === "HARNESS_STILL_RUNNING" || code === "HARNESS_LAUNCH_IN_PROGRESS") continue;
          failures.set(id, { card, error, skipped: false });
          // Do not spend another timeout on every card of an unreachable host.
          // CLI-specific failures still allow other cards on that host to start.
          if (group.remote && connectionFailures.has(code)) hostFailure = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  return candidates.flatMap(card => failures.has(card.id) ? [failures.get(card.id)!] : []);
}
