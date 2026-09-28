import { useI18n } from '@/hooks/useI18n';
import { MarkdownMessage } from '../MarkdownMessage';
import { ChatIcon } from './Icons';

type Option = { optionId: string; kind: string; name: string };
type Request = { toolCall?: { title?: string; rawInput?: unknown }; options: Option[] };

export function PermissionCard({request, disabled, onAnswer}: {
  request: Request;
  disabled: boolean;
  onAnswer: (answer: {outcome: string}) => void;
}) {
  const {t} = useI18n();
  const raw = request.toolCall?.rawInput;
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
  const plan = typeof input?.plan === 'string' ? input.plan : undefined;
  const ambiguous = new Set(request.options.filter(option => request.options.filter(other => other.kind === option.kind).length > 1).map(option => option.kind));
  const command = typeof input?.command === 'string' ? input.command : typeof input?.cmd === 'string' ? input.cmd : undefined;
  const title = request.toolCall?.title?.trim();
  return <section className="fc-permission" aria-label={t('decision.permission')} aria-busy={disabled}>
    <header className="fc-permission-heading">
      <span className="fc-permission-icon"><ChatIcon name={plan ? 'check' : 'shield'}/></span>
      <div><strong>{title || t('decision.permission')}</strong></div>
    </header>
    {command && !plan && <pre className="fc-permission-command">{command}</pre>}
    {plan ? <details className="fc-permission-details"><summary>{t('decision.viewPlan')}<ChatIcon name="chevron"/></summary><div className="fc-permission-preview"><MarkdownMessage content={plan} role="assistant"/></div></details>
      : raw != null && <details className="fc-permission-details"><summary>{t('decision.details')}<ChatIcon name="chevron"/></summary><pre>{typeof raw === 'string' ? raw : JSON.stringify(raw,null,2)}</pre></details>}
    {ambiguous.size > 0 && <p className="fc-permission-limit" role="note">{t('decision.ambiguousOptions')}</p>}
    <footer className="fc-permission-actions">{request.options.map(option => (
      <button type="button" key={option.optionId} disabled={disabled || ambiguous.has(option.kind)} className={option.kind === 'allow_once' ? 'is-primary' : option.kind.startsWith('reject') ? 'is-reject' : undefined}
        title={ambiguous.has(option.kind) ? t('decision.ambiguousOptions') : undefined}
        onClick={()=>onAnswer({outcome:option.kind})}>{option.name}</button>
    ))}</footer>
  </section>;
}
