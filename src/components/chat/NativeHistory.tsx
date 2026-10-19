import { useI18n } from '@/hooks/useI18n';
import { useEffect, useRef, useState } from 'react';
import { ProviderIcon } from '../ProviderIcon';
import { Icon } from '../QueueIcon';
import { harnessName, providerIconId, type HarnessCatalogEntry } from '@/lib/harness/catalog';
import type { AcpHistoryEntry } from '@/hooks/useAcpHistory';

export function NativeHistory({workspace, onOpen, activeIds, search, onSearchChange, opening}: {workspace?:string; onOpen:(entry:AcpHistoryEntry)=>void;activeIds:string[];search:string;onSearchChange:(search:string)=>void;opening?:string|null}) {
  const {t}=useI18n();
  const [catalog,setCatalog]=useState<HarnessCatalogEntry[]>([]);
  const [agent,setAgent]=useState('');
  const [entries,setEntries]=useState<AcpHistoryEntry[]>([]);
  const [cursor,setCursor]=useState<string>();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef<AbortController|null>(null);
  const picker=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const c=new AbortController();
    setAgent('');setEntries([]);setError('');setCatalog([]);
    void fetch('/api/acp-catalog'+(workspace?'?workspace='+encodeURIComponent(workspace):''),{signal:c.signal})
      .then(async r=>{if(!r.ok)throw Error(t('acp.history.catalogFailed'));return r.json();})
      .then(items=>{if(c.signal.aborted)return;setCatalog(items);})
      .catch(e=>{if(!c.signal.aborted)setError(e.message);});
    return()=>{c.abort();pending.current?.abort();};
  },[workspace]);
  useEffect(()=>{
    const close=(e:PointerEvent)=>{if(picker.current&&!picker.current.contains(e.target as Node))picker.current.open=false;};
    document.addEventListener('pointerdown',close);
    return()=>document.removeEventListener('pointerdown',close);
  },[]);
  async function load(id:string,next?:string){
    pending.current?.abort();const c=new AbortController();pending.current=c;
    setAgent(id);setBusy(true);setError('');if(picker.current)picker.current.open=false;
    let collected=next?entries:[],pageCursor=next;const seen=new Set<string>();
    if(!next){onSearchChange('');setEntries([]);setCursor(undefined);}
    try {
      for(let pageIndex=0;pageIndex<100;pageIndex++){
        const r=await fetch(`/api/acp-history?${workspace?'workspace='+encodeURIComponent(workspace)+'&':''}agent=${encodeURIComponent(id)}${pageCursor?'&cursor='+encodeURIComponent(pageCursor):''}`,{signal:c.signal});
        const page=await r.json();if(!r.ok)throw Error(page.error||t('acp.history.failed'));if(c.signal.aborted)return;
        if(!page.supported){setError(t('acp.history.unsupported'));return;}
        collected=[...collected,...page.sessions].filter((v,i,a)=>a.findIndex(x=>x.recordId===v.recordId)===i);
        setEntries(collected);pageCursor=page.nextCursor;setCursor(pageCursor);
        if(!pageCursor)break;
        if(seen.has(pageCursor))throw Error(t('acp.history.failed'));
        seen.add(pageCursor);
        // Fill the list even when pages are small or contain only already-open cards.
        if(collected.filter(e=>!activeIds.includes(e.cardId||'')).length >= (next?entries.length+50:50))break;
      }
    }catch(e){if(!c.signal.aborted)setError((e as Error).message);}finally{if(!c.signal.aborted)setBusy(false);}
  }
  const visible=entries.filter(e=>!activeIds.includes(e.cardId||'')&&`${e.title} ${e.agent} ${e.cwd}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="fc-native-history">
    <details ref={picker} className="fc-agent-picker" onKeyDown={e=>{if(e.key==='Escape'&&picker.current){picker.current.open=false;picker.current.querySelector('summary')?.focus();}}}>
      <summary className="fc-history-selector" aria-label={t('history.chooseHarness')}>
        {agent ? <ProviderIcon id={providerIconId(agent)} size={20}/> : <Icon name="stack" size={20}/>}
        <span className="fc-history-selector-label">{agent?harnessName(agent):t('history.chooseHarness')}<small>{t(workspace ? 'history.workspaceMode' : 'history.agentScope')}</small></span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="fc-agent-picker-options">{catalog.map(a=><button type="button" key={a.id} aria-pressed={agent===a.id} onClick={()=>void load(a.id)}><ProviderIcon id={providerIconId(a.id)} size={20}/><span className="fc-agent-picker-label">{harnessName(a.id)}</span>{agent===a.id&&<span>✓</span>}</button>)}</div>
    </details>
    {agent&&<>
      <input className="fc-history-search" aria-label={t('queue.搜索会话或项目…')} placeholder={t('queue.搜索会话或项目…')} value={search} onChange={event=>onSearchChange(event.target.value)}/>
      <div className="cq-history-list">{visible.map(e=><button key={e.recordId} disabled={!!opening} aria-busy={opening===e.recordId} onClick={()=>onOpen(e)}><span>{e.title}{opening===e.recordId ? " · 正在打开…" : ""}</span><small title={e.cwd}>{e.cwd}</small></button>)}</div>
      {busy&&<p role="status">{t('acp.history.loading')}</p>}
      {!busy&&!error&&!visible.length&&<p role="status">没有匹配的历史会话。</p>}
      {cursor&&!busy&&<button className="fc-history-more" onClick={()=>void load(agent,cursor)}>{t('acp.history.more')}</button>}
    </>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
