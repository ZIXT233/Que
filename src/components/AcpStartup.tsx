import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { acpStartupLabel } from '@/lib/acp-labels';
import { harnessName, providerIconId } from '@/lib/harness/catalog';
import { ProviderIcon } from './ProviderIcon';

export type StartLogEntry = { at: number; text: string };

/**
 * No synthetic percentage: acpx reports lifecycle stages, not download bytes.
 * Below them, what connecting did so far, step by step, with the time each came.
 */
export function AcpStartup({ agent, stage, log = [] }: { agent: string; stage: string; log?: StartLogEntry[] }) {
  const { t } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [agent]);
  const lines = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => { const box = lines.current; if (box) box.scrollTop = box.scrollHeight; }, [log.length]);
  const first = log[0]?.at;
  return <div className="cq-acp-start" role="status" aria-live="polite">
    <div className="cq-acp-start-head">
      <div className="cq-acp-start-icon" aria-hidden="true"><ProviderIcon id={providerIconId(agent)} size={24} /></div>
      <div className="cq-acp-start-copy">
        <h3>{t('acp.start.title', { name: harnessName(agent) })}</h3>
        <p><span className="cq-acp-spinner" aria-hidden="true" />{acpStartupLabel(stage, t)}<span className="cq-acp-elapsed" aria-live="off">{seconds}s</span></p>
        {seconds >= 20 && <small>{t('acp.start.slow')}</small>}
      </div>
    </div>
    {log.length > 0 && <ol ref={lines} className="cq-acp-start-log" aria-live="off">
      {log.map((entry, i) => <li key={i}><time>{((entry.at - first) / 1000).toFixed(1)}s</time><span>{entry.text}</span></li>)}
    </ol>}
  </div>;
}
