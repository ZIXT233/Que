import { CardRecap } from "./chat/CardRecap";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MarkdownMessage } from './MarkdownMessage';
import { PermissionCard } from './chat/PermissionCard';
import { useI18n } from '@/hooks/useI18n';
import { createRetainedConversationView } from '@/hooks/retainedConversationView';
import { admissionId, acknowledgeAdmission } from '@/lib/acp-admission';
import { shareStructure } from '@/lib/structural-share';
import { foldEvents, type StreamEvent } from '@/lib/acp-delta';
import { PendingMessages } from './chat/PendingMessages';
import { MessageActions } from './chat/MessageActions';
import { MissingReceiptsNotice } from './chat/MissingReceiptsNotice';
import { Composer } from './chat/Composer';
import type { Config, Usage as SessionUsage } from './chat/model';
import { ActivityGroup, groupActivityBlocks } from './chat/ActivityGroup';
import { withPeerMessages } from '@/lib/peer-messages';
import type { QueueCard } from '@/lib/card-queue';
import '../styles/acp.css';

type Block = { type: string; from?: { cardId: string; name: string }; text?: string; stream?: string; toolCallId?: string; title?: string; status?: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown; entries?: { content: string; status: string }[]; id?: string; kind?: string; state?: string; request?: any; answer?: any };
type Turn = { withdrawn?: boolean; source?: 'event' | 'user' | 'agent'; sender?:{cardId:string;name:string;epoch:string}; at?: number; endedAt?: number; id: string; text: string; state: string; blocks: Block[]; attachments: { mediaType: string; data: string; name?: string }[]; result?: { stopReason?: string; error?: { message: string } } };
type Snapshot = { ownerEpoch?:string;revision?:number; hostAccess?: boolean; promptCapabilities?: { image?: boolean; audio?: boolean }; state: string; stage?: string; error?: string; turns: Turn[]; commands?: { name: string; description?: string }[]; context?: { used?: number; size?: number }; status?: { models?: { currentModelId?: string; availableModelIds: string[]; availableModels?: { modelId: string; name: string }[] }; availableCommands?: { name: string; description?: string }[]; usage?: SessionUsage; details?: { configOptions?: Config[] } } };
const busyTurn = (t: Turn) => ['queued','running','cancelling'].includes(t.state);
type EditingDraft = {text:string;quote:string;attachments:Turn['attachments']; original:Turn; restoreId:string};
type Admission = {id:string;text:string;attachments:Turn['attachments']};
const useConversationView = createRetainedConversationView(key => {
  const [id] = JSON.parse(key) as string[];
  return {
    snapshot: undefined as Snapshot | undefined,
    draft: sessionStorage.getItem(`queacp:draft:${id}`) || '',
    quote: sessionStorage.getItem(`queacp:quote:${id}`) || '',
    attachments: [] as Turn['attachments'],
    editingDraft: null as EditingDraft | null,
    error: '', connectionError: '', sending: false, controlBusy: false, follow: true,
    mutationActive: {current: false},
    streamHealth: {failures: 0},
    admission: {current: null as Admission | null},
  };
}, value => value.sending || value.controlBusy || !!value.admission.current);
// Another card's message: on the Agent's side, since an Agent wrote it, and
// tinted so it is never mistaken for the user's own words.
function PeerBubble({ name, text }: { name: string; text: string }) {
  return <div className="cq-acp-peer"><small className="cq-acp-sender">来自 {name}</small><MarkdownMessage content={text} role="assistant"/></div>;
}
const hasUserContent = (turn: Turn) => !!turn.text?.trim() || !!turn.attachments?.length;
const missingReceipt = (turn: Turn) => turn.state === 'unknown' && !hasUserContent(turn)
  && !turn.blocks.length && !turn.result?.error;
const turnLabel: Record<string,string> = { queued: '已排队 · 等待当前回复结束', running: '正在处理', cancelling: '正在停止', cancelled: '已停止', failed: '未完成', unknown: '结果未确认' };
async function request(id: string, body?: object): Promise<any> {
  // The backend allows 180s for an operation, plus transport setup. Do not
  // report a failure while it is still legitimately awaiting the agent.
  const r = await fetch(`/api/acp/${encodeURIComponent(id)}`, body ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(200000) } : { cache: 'no-store', signal: AbortSignal.timeout(40000) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '会话请求失败');
  const sending=(body as {action?:string} | undefined)?.action==='send';
  if(!data || (sending ? typeof data.id!=='string' || !Array.isArray(data.blocks) : !Array.isArray(data.turns))) {
    throw new Error('会话服务返回格式不匹配；已保留输入，请检查连接后重试');
  }
  return data;
}
function Decision({ block, answer, disabled }: { block: Block; answer: (answer: unknown) => void; disabled: boolean }) {
  const [values, setValues] = useState<Record<string,any>>({});
  const q = block.request;
  if (block.state !== 'pending') return <div className="cq-acp-decision-receipt">{block.state === 'expired' ? '请求已失效' : block.kind === 'permission' ? ({ allow_once:'已允许一次',allow_always:'已允许后续同类操作',reject_once:'已拒绝一次',reject_always:'已拒绝后续同类操作',cancel:'已取消' } as Record<string,string>)[block.answer?.outcome] : '已回复询问'}</div>;
  if (block.kind === 'permission') return <PermissionCard request={q} disabled={disabled} onAnswer={answer} />;
  const schema = q.requestedSchema || {};
  const submit = (event: FormEvent) => { event.preventDefault(); answer({action:'accept',content:values}); };
  return <form className="cq-acp-approval" onSubmit={submit}><strong>{q.message || '需要补充信息'}</strong>{Object.entries(schema.properties || {}).map(([key, raw]) => {
    const field = raw as any, required = schema.required?.includes(key);
    return <label key={key}>{field.title || key}{field.description && <small>{field.description}</small>}{field.enum ? <select required={required} value={values[key] ?? ''} onChange={e => setValues(v => ({...v,[key]:e.target.value}))}><option value="">请选择</option>{field.enum.map((v: string) => <option key={v}>{v}</option>)}</select> : field.type === 'boolean' ? <input type="checkbox" checked={!!values[key]} onChange={e => setValues(v => ({...v,[key]:e.target.checked}))} /> : <input required={required} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={values[key] ?? ''} onChange={e => setValues(v => ({...v,[key]:field.type === 'number' || field.type === 'integer' ? Number(e.target.value) : e.target.value}))} />}</label>;
  })}<div><button type="button" disabled={disabled} onClick={() => answer({action:'decline'})}>不提供</button><button type="submit" disabled={disabled}>提交</button></div></form>;
}
export function AcpConversation({ card, active, onResume }: {card: QueueCard; active: boolean; onResume: () => Promise<void>}) {
  const {t}=useI18n();
  const viewKey=JSON.stringify([card.id, card.workspaceId, card.cwd, card.harness?.kind]);
  const view = useConversationView(viewKey);
  const {mutationActive, admission, streamHealth} = view.value;
  const [editingDraft,setEditingDraft] = view.field('editingDraft');
  const [snapshot,updateSnapshot] = view.field('snapshot');
  const setSnapshot=useCallback((next:Snapshot | ((previous:Snapshot | undefined)=>Snapshot | undefined))=>updateSnapshot(previous=>{
    const updated=typeof next==='function'?next(previous):next;
    if(previous?.ownerEpoch && updated?.ownerEpoch===previous.ownerEpoch
      && (updated.revision ?? 0)<(previous.revision ?? 0))return previous;
    // An unchanged poll keeps the previous reference, so nothing re-renders.
    return shareStructure(previous,updated);
  }),[updateSnapshot]);
  const [draft,setDraft] = view.field('draft');
  const [quote,setQuote] = view.field('quote');
  const [attachments,setAttachments] = view.field('attachments');
  const [error,setError] = view.field('error');
  const [connectionError,setConnectionError] = view.field('connectionError');
  const [sending,setSending] = view.field('sending');
  const [controlBusy,setControlBusy] = view.field('controlBusy');
  const [follow,setFollow] = view.field('follow');
  const scroll = useRef<HTMLDivElement>(null);
  const draftNow=useRef({text:draft,quote,attachments});draftNow.current={text:draft,quote,attachments};
  const archived = card.archivedAt !== undefined;
  useEffect(() => { if(quote) sessionStorage.setItem(`queacp:quote:${card.id}`,quote); else sessionStorage.removeItem(`queacp:quote:${card.id}`); },[card.id,quote]);
  useEffect(() => { sessionStorage.setItem(`queacp:draft:${card.id}`, draft); }, [card.id,draft]);
  // The conversation is a subscription: a snapshot first, then ordered deltas
  // (see runtime/session-wire.mjs). A delta that does not fit means a missed
  // event, repaired by fetching one full snapshot.
  useEffect(() => {
    if (!active) return;
    let closed=false, resyncing=false, source:EventSource|undefined, retry:ReturnType<typeof setTimeout>|undefined, frame:ReturnType<typeof setTimeout>|undefined;
    let queue:StreamEvent<Snapshot>[]=[];
    const resync=async()=>{
      if(resyncing)return;resyncing=true;
      try{const fresh=await request(card.id);if(!closed)setSnapshot(fresh);}catch{/* the stream keeps trying */}finally{resyncing=false;}
    };
    // Everything that arrives within a frame is applied together: a burst renders once.
    const flush=()=>{
      frame=undefined;
      const events=queue;queue=[];
      let gap=false;
      setSnapshot(previous=>{const folded=foldEvents(previous,events);gap=folded.gap;return folded.snapshot;});
      if(gap)void resync();
    };
    const enqueue=(event:StreamEvent<Snapshot>)=>{queue.push(event);frame??=setTimeout(flush,16);};
    const connect=()=>{
      const opened=new EventSource(`/api/acp/${encodeURIComponent(card.id)}/events`);
      source=opened;
      const parse=(event:Event)=>JSON.parse((event as MessageEvent).data);
      opened.addEventListener('snapshot',event=>{streamHealth.failures=0;setConnectionError('');enqueue({event:'snapshot',data:parse(event)});});
      opened.addEventListener('delta',event=>enqueue({event:'delta',data:parse(event)}));
      opened.onerror=()=>{
        if(closed||source!==opened)return;
        // A failed read says nothing about the turn or selected model: keep the last state.
        if(++streamHealth.failures>=3)setConnectionError('暂时无法刷新会话状态，正在重试…');
        // EventSource gives up on a refused stream; reopen it with a short backoff.
        if(opened.readyState===EventSource.CLOSED){source=undefined;retry=setTimeout(connect,Math.min(1000*streamHealth.failures,8000));}
      };
    };
    connect();
    return()=>{closed=true;clearTimeout(retry);clearTimeout(frame);source?.close();};
  },[active,card.id,setSnapshot,setConnectionError,streamHealth]);
  useEffect(() => { if(follow && scroll.current) scroll.current.scrollTop=scroll.current.scrollHeight; },[snapshot,follow]);
  const command=async(body:{action:string;[key:string]:unknown})=> {
    if(mutationActive.current)return;
    mutationActive.current=true;setControlBusy(true);
    try {
      const updated=await request(card.id,body);
      if(body.action==='send')setSnapshot(previous=>({...previous,state:'working',turns:previous?.turns.some(t=>t.id===updated.id)?previous.turns:[...(previous?.turns || []),updated]}));
      else setSnapshot(updated);
      setError('');setConnectionError('');
    } catch(e){setError((e as Error).message)}
    finally{mutationActive.current=false;setControlBusy(false)}
  };
  const compact = async () => {
    if (mutationActive.current || sending || archived || !snapshot || snapshot.turns.some(busyTurn)
        || !['attention','ready'].includes(snapshot.state)
        || !(snapshot.commands || snapshot.status?.availableCommands || []).some(command => command.name.replace(/^\//,'') === 'compact')) return;
    await command({action:'send',requestId:crypto.randomUUID(),text:'/compact',attachments:[]});
  };
  const editQueued=async(id:string)=>{
    const turn=snapshot?.turns.find(turn=>turn.id===id && turn.state==='queued');
    if(!turn || controlBusy || editingDraft)return;
    mutationActive.current=true;setControlBusy(true);
    try {
      await request(card.id,{action:'cancel',requestId:id,queuedOnly:true});
      setEditingDraft({...draftNow.current,original:turn,restoreId:crypto.randomUUID()});setDraft(turn.text);setQuote('');setAttachments(turn.attachments || []);
      setSnapshot(await request(card.id));setError('');
      requestAnimationFrame(()=>scroll.current?.parentElement?.querySelector('textarea')?.focus());
    }catch(e){setError((e as Error).message)}finally{mutationActive.current=false;setControlBusy(false)}
  };
  const cancelEdit=async()=>{
    if(!editingDraft || sending || mutationActive.current)return;
    const editing=editingDraft;
    mutationActive.current=true;setControlBusy(true);
    try {
      // Retain the ID across retries: a lost response must not enqueue twice.
      await request(card.id,{action:'send',requestId:editing.restoreId,text:editing.original.text,attachments:editing.original.attachments || []});
      setDraft(editing.text);setQuote(editing.quote);setAttachments(editing.attachments);setEditingDraft(null);
      setSnapshot(await request(card.id));setError('');
    }catch(e){setError((e as Error).message)}
    finally{mutationActive.current=false;setControlBusy(false)}
  };
  const send=async(draftOverride?:string)=>{
    const messageDraft=draftOverride ?? draft;
    if(sending || archived || (!messageDraft.trim() && !attachments.length)) return;
    const text=quote ? `${quote.split('\n').map(line=>`> ${line}`).join('\n')}\n\n${messageDraft}` : messageDraft;
    const current=admission.current;
    const message=current && current.text===text && JSON.stringify(current.attachments)===JSON.stringify(attachments) ? current : {id:'',text,attachments};
    // Persist admission across a card move; the stream keeps history visible during startup.
    admission.current=message;setSending(true);setFollow(true);
    try {
      if(!message.id)message.id=await admissionId(viewKey,text,attachments);
      const admitted:Turn=await request(card.id,{action:'send',requestId:message.id,text:message.text,attachments:message.attachments});
      setSnapshot(previous=>({
        ...previous,
        state:previous?.turns.some(turn=>turn.id===admitted.id)?previous.state:busyTurn(admitted)?'working':previous?.state || 'attention',
        turns:previous?.turns.some(turn=>turn.id===admitted.id) ? previous.turns : [...(previous?.turns || []),admitted],
      }));
      setDraft(v=>v===messageDraft?(editingDraft?.text || ''):v);
      setQuote(v=>v===quote?(editingDraft?.quote || ''):v);
      setAttachments(v=>v===attachments?(editingDraft?.attachments || []):v);
      setEditingDraft(null);admission.current=null;
      // A crash before clearing the draft must keep the receipt for a safe retry.
      if(sessionStorage.getItem(`queacp:draft:${card.id}`)===messageDraft)sessionStorage.setItem(`queacp:draft:${card.id}`,editingDraft?.text || '');
      acknowledgeAdmission(viewKey,message.id);setError('');setConnectionError('');
      // The admission response is sufficient. A later history read failing must
      // not make a successfully accepted message look like a failed submission.
    } catch(e) {setError((e as Error).message)}
    finally{setSending(false)}
  };
  const addFiles=async(files:FileList | File[])=>{
    try {
      const incoming=Array.from(files);if(incoming.length+attachments.length>4) throw Error('每条消息最多添加 4 个附件');
      const next=await Promise.all(incoming.map(async file=>{if (/\.(txt|md|csv|jsonl?|ya?ml|toml|xml|html|css|jsx?|tsx?|py|rs|go|c|h|cpp|java|sh|sql|log)$/i.test(file.name) || file.type.startsWith('text/')) { if(file.size>1024*1024)throw Error('文本文件需小于 1 MB'); const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(text.includes('\0'))throw Error('该文件不是 UTF-8 文本');return {mediaType:'text/plain',data:text,name:file.name}; }if(!snapshot?.promptCapabilities?.[file.type.split('/')[0] as 'image'|'audio'])throw Error('当前 Agent 不支持该附件类型');if(!/^(image|audio)\//.test(file.type)||file.size>8*1024*1024)throw Error('支持 8 MB 以内的图片和音频');const data=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file)});return {mediaType:file.type,data,name:file.name};}));setAttachments(v=>[...v,...next]);
    }catch(e){setError((e as Error).message)}
  };
  const turns=snapshot?.turns || [], running=turns.some(busyTurn);
  const stopTarget=turns.find(t=>t.state==='running'||t.state==='cancelling') || turns.find(t=>t.state==='queued');
  const quoteMessage=(text:string)=>{setQuote(text);requestAnimationFrame(()=>scroll.current?.parentElement?.querySelector('textarea')?.focus());};
  const options=snapshot?.status?.details?.configOptions || [];
  const commands=snapshot?.commands || snapshot?.status?.availableCommands || [];
  // Transport startup is independent of whether history has already loaded.
  const loading=!snapshot && !connectionError;
  const disconnected=['not_running','error','unknown'].includes(snapshot?.state || '');
  const missingReceipts=turns.filter(turn=>!turn.withdrawn && missingReceipt(turn)).map(turn=>turn.id);
  return <div className="cq-harness-body cq-acp">
    <CardRecap turns={turns}/>
    <div ref={scroll} className="cq-acp-transcript" onScroll={e=>{const n=e.currentTarget;setFollow(n.scrollHeight-n.scrollTop-n.clientHeight<80)}}>
      {loading && !connectionError && <div className="cq-acp-loading" role="status"><span className="cq-acp-spinner" aria-hidden="true"/>{t('acp.loading.history')}</div>}
      {snapshot && !connectionError && !loading && snapshot.state!=='starting' && !sending && !disconnected && !turns.length && <div className="cq-acp-welcome"><h3>开始处理这个任务</h3><p>消息、执行过程和需要你确认的操作会显示在这里。</p></div>}
      {turns.filter(turn=>turn.state!=='queued'&&!turn.withdrawn&&!missingReceipt(turn)).map(turn=><article key={turn.id} className="cq-acp-turn">{hasUserContent(turn) && turn.sender && <div className="cq-acp-peer-group"><PeerBubble name={turn.sender.name} text={turn.text}/><MessageActions text={turn.text} onQuote={archived?undefined:quoteMessage}/></div>}{hasUserContent(turn) && !turn.sender && <div className="cq-acp-user-group"><div className="cq-acp-user">{turn.source === 'event' ? <details><summary>工作会话通知</summary><pre>{turn.text}</pre></details> : <MarkdownMessage content={turn.text} role="user" />}{turn.attachments?.map((a,i)=>a.mediaType.startsWith('image/')?<img key={i} alt="已发送的图片" src={`data:${a.mediaType};base64,${a.data}`}/>:a.mediaType === 'text/plain'?<details key={i}><summary>{a.name || '文本文件'}</summary><pre>{a.data}</pre></details>:<audio key={i} controls src={`data:${a.mediaType};base64,${a.data}`}/>)}</div><MessageActions text={turn.text} onQuote={archived?undefined:quoteMessage}/></div>}
        <div className="cq-acp-response">{groupActivityBlocks(withPeerMessages(turn.blocks)).map(({block:b,activities,index:i})=> activities ? <ActivityGroup key={i} blocks={activities} running={busyTurn(turn)}/> : !b ? null : b.type==='peer_message' ? <PeerBubble key={i} name={b.from?.name || ''} text={b.text || ''}/> : b.type==='text_delta' ? b.stream==='thought'?<details key={i} className="cq-acp-activity"><summary>思考过程</summary><MarkdownMessage content={b.text || ''} role="assistant"/></details>:<MarkdownMessage key={i} content={b.text || ''} role="assistant"/> : b.type==='decision'?<Decision key={b.id} block={b} disabled={controlBusy || archived} answer={answer=>void command({action:'answer',decisionId:b.id,answer})}/> : b.entries?<ul key={i} className="cq-acp-plan">{b.entries.map((e,j)=><li key={j} data-state={e.status}>{e.status==='completed'?'✓':e.status==='in_progress'?'◉':'○'} {e.content}</li>)}</ul>:null)}</div>
        {!busyTurn(turn) && <MessageActions text={turn.blocks.filter(b=>b.type==='text_delta'&&b.stream!=='thought').map(b=>b.text||'').join('\n\n')} onQuote={archived?undefined:quoteMessage}/>}
        {turnLabel[turn.state] && <div className="cq-acp-turn-state" role="status">{turn.blocks.some(b=>b.type==='decision'&&b.state==='pending')?'等待你的确认':turnLabel[turn.state]}</div>}
        {turn.result?.error && <p role="alert" className="cq-acp-error">{turn.result.error.message}</p>}
        {turn.result?.stopReason && !['end_turn','cancelled'].includes(turn.result.stopReason) && <p className="cq-acp-turn-state">结束原因：{turn.result.stopReason}</p>}
      </article>)}
      <MissingReceiptsNotice key={viewKey} identity={viewKey} receiptIds={missingReceipts}/>
    </div>
    {!follow && <button className="cq-acp-latest" onClick={()=>setFollow(true)}>↓ 回到最新</button>}
    {(error||connectionError) && <div className="cq-acp-error" role="alert">{error||connectionError}</div>}
    {sending && (disconnected || snapshot?.state === "starting") && <div className="cq-acp-recovery" role="status">正在连接…</div>}
    {!archived && <PendingMessages editing={!!editingDraft} onEdit={id=>void editQueued(id)} turns={turns.filter(turn=>turn.state==='queued'&&!turn.withdrawn)} disabled={controlBusy || disconnected} onRemove={id=>void command({action:'cancel',requestId:id,queuedOnly:true})} />}
    {editingDraft && <div className="fc-editing-draft"><span>{t('composer.editingQueued')}</span><button disabled={sending || controlBusy} onClick={()=>void cancelEdit()}>{t('composer.cancelEdit')}</button></div>}
    {archived ? <div className="cq-acp-recovery"><span>已归档 · 对话历史已保留</span><button disabled={controlBusy} onClick={()=>{setControlBusy(true);void onResume().finally(()=>setControlBusy(false))}}>继续会话</button></div> : <Composer history={turns.filter(turn=>turn.source !== 'event' && turn.source !== 'agent' && !turn.withdrawn && turn.state !== 'queued').map(turn=>turn.text)} active={active} draft={draft} onDraft={setDraft} quote={quote} onRemoveQuote={()=>setQuote('')} attachments={attachments}
      onFiles={files=>void addFiles(files)} onRemove={index=>setAttachments(items=>items.filter((_,i)=>i!==index))}
      capabilities={snapshot?.promptCapabilities} commands={commands} options={options} models={snapshot?.status?.models}
      context={snapshot?.context} usage={snapshot?.status?.usage} busy={controlBusy || loading} sending={sending} running={running} disconnected={disconnected}
      hostAccess={snapshot?.hostAccess === true} onHostAccess={enabled=>void command({action:'host_access',enabled})} onCompact={()=>void compact()} onSend={text=>void send(text)} stopping={stopTarget?.state==='cancelling' && controlBusy} onStop={()=>{if(stopTarget&&!controlBusy)void command({action:'cancel',requestId:stopTarget.id});}} onConfig={(option,value)=>void command(option.id==='__legacy_model'?{action:'model',value}:{action:'config',key:option.id,value})}/>}
  </div>;
}
