import {useEffect,useRef,useState} from 'react';
import {copyText} from '@/lib/clipboard';
import {useI18n} from '@/hooks/useI18n';
import {ChatIcon} from './Icons';

export function MessageActions({text,onQuote}:{text:string;onQuote?:(text:string)=>void}) {
  const {t}=useI18n();
  const [status,setStatus]=useState<'idle'|'copied'|'error'>('idle');
  const timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  if(!text.trim())return null;
  const copy=async()=>{
    try {await copyText(text);setStatus('copied');}catch{setStatus('error');}
    clearTimeout(timer.current);timer.current=setTimeout(()=>setStatus('idle'),2000);
  };
  const label=t(status==='copied'?'message.copied':status==='error'?'message.copyFailed':'message.copy');
  return <div className="fc-message-actions" role="group" aria-label={t('message.actions')}>
    <button type="button" title={label} aria-label={label} onClick={()=>void copy()}><ChatIcon name={status==='copied'?'check':'copy'}/></button>
    {onQuote&&<button type="button" title={t('message.quote')} aria-label={t('message.quote')} onClick={()=>onQuote(text)}><ChatIcon name="quote"/></button>}
    <span className="fc-action-status" role="status">{status==='error'?t('message.copyFailed'):status==='copied'?t('message.copied'):''}</span>
  </div>;
}
