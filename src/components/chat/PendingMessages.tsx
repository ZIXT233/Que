import { useI18n } from '@/hooks/useI18n';
import { ChatIcon } from './Icons';
export function PendingMessages({ turns, disabled, onRemove, onEdit, editing }: {
  turns: { id: string; text: string; attachments?: { name?: string }[] }[];
  disabled: boolean;
  editing?: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!turns.length) return null;
  return <section className="fc-pending" aria-label={t('composer.pending')}>
    <ol>{turns.map(turn => <li key={turn.id}>
      <span className="fc-pending-mark" title={t('composer.pending')}><ChatIcon name="queue" /></span>
      <div className="fc-pending-content"><p title={turn.text}>{turn.text || t('composer.queuedAttachment')}</p>
        {!!turn.attachments?.length && <small>{turn.attachments.map(a => a.name || t('composer.queuedAttachment')).join(' · ')}</small>}
      </div>
      <button type="button" disabled={disabled || editing} aria-label={t('composer.editQueued')} title={t('composer.editQueued')} onClick={() => onEdit(turn.id)}><ChatIcon name="edit" /></button>
      <button type="button" disabled={disabled} aria-label={t('composer.removeQueued')} title={t('composer.removeQueued')} onClick={() => onRemove(turn.id)}><ChatIcon name="close" /></button>
    </li>)}</ol>
  </section>;
}
