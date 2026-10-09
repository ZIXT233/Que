import {useState} from 'react';
import {useI18n} from '@/hooks/useI18n';
import {persistentStorage} from '@/lib/persistent-storage';
import {ChatIcon} from './Icons';

function readDismissed(key: string): string[] {
  try {
    const value: unknown = JSON.parse(persistentStorage().getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

// Key this component by conversation identity. Store only dismissed receipt IDs,
// never conversation content or a replacement for the agent's history.
export function MissingReceiptsNotice({identity, receiptIds}: {identity: string; receiptIds: string[]}) {
  const {t} = useI18n();
  const storageKey = `queacp:dismissed-missing-receipts:${identity}`;
  const [dismissed, setDismissed] = useState(() => readDismissed(storageKey));
  const visible = receiptIds.filter(id => !dismissed.includes(id));
  if (!visible.length) return null;
  const dismiss = () => {
    const next = [...new Set([...readDismissed(storageKey), ...dismissed, ...visible])];
    setDismissed(next);
    try { persistentStorage().setItem(storageKey, JSON.stringify(next)); } catch { /* Still dismiss in this view if storage is unavailable. */ }
  };
  const label = t('acp.history.dismissMissingReceipts');
  return <div className="cq-acp-missing-receipts">
    <details className="cq-acp-activity">
      <summary>{t('acp.history.missingReceipts', {count: visible.length})}</summary>
      <p>{t('acp.history.missingReceiptsHelp')}</p>
    </details>
    <div className="fc-message-actions">
      <button type="button" title={label} aria-label={label} onClick={dismiss}><ChatIcon name="close"/></button>
    </div>
  </div>;
}
