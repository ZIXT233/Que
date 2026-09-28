import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { acpStartupLabel } from '@/lib/acp-labels';
import { harnessName, providerIconId } from '@/lib/harness/catalog';
import { ProviderIcon } from './ProviderIcon';

/** No synthetic percentage: acpx reports lifecycle stages, not download bytes. */
export function AcpStartup({ agent, stage }: { agent: string; stage: string }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [agent]);
  return <div className="cq-acp-start" role="status" aria-live="polite">
    <div className="cq-acp-start-icon" aria-hidden="true"><ProviderIcon id={providerIconId(agent)} size={24} /></div>
    <div className="cq-acp-start-copy">
      <h3>{t('acp.start.title', { name: harnessName(agent) })}</h3>
      <p><span className="cq-acp-spinner" aria-hidden="true" />{acpStartupLabel(stage, t)}<span className="cq-acp-elapsed" aria-live="off">{seconds}s</span></p>
      {seconds >= 20 && <small>{t('acp.start.slow')}</small>}
    </div>
  </div>;
}
