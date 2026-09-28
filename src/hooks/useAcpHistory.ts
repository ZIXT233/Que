import { useEffect } from 'react';

export type AcpHistoryEntry = {
  recordId: string;
  nativeSessionId?: string;
  title: string;
  cwd: string;
  agent: string;
  updatedAt: string;
  cardId?: string;
};

export function useAcpHistory(
  workspaceId: string | null,
  enabled: boolean,
  onResult: (entries: AcpHistoryEntry[]) => void,
  onError: (error: string) => void,
  onLoading: (loading: boolean) => void,
) {
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    const controller = new AbortController();
    onLoading(true);
    onError('');
    void fetch(`/api/acp-history?workspace=${encodeURIComponent(workspaceId)}`, {
      signal: controller.signal,
    }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw Error(data.error || '无法读取 acpx 会话');
      // A response may finish after the dialog closes, even if fetch was aborted.
      if (!controller.signal.aborted) onResult(data);
    }).catch(error => {
      if (!controller.signal.aborted) onError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) onLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId, enabled, onResult, onError, onLoading]);
}

/** An unarchived card already has an entry in the current workspace UI. */
export function filterHistoryEntries(
  entries: AcpHistoryEntry[],
  cards: { id: string; archivedAt?: number; harness?: unknown }[],
  search: string,
) {
  const active = new Set(cards.filter(card => card.archivedAt == null && card.harness).map(card => card.id));
  const query = search.trim().toLocaleLowerCase();
  return entries.filter(entry => (!entry.cardId || !active.has(entry.cardId)) && `${entry.title} ${entry.agent}`.toLocaleLowerCase().includes(query));
}
