import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
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
import { ActivityGroup, ActivityItems, groupActivityBlocks } from './chat/ActivityGroup';
import { CardMessage } from './chat/CardMessage';
import { Disclosure } from './chat/Disclosure';
import { ImageViewer } from './chat/ImageViewer';
import { createPortal } from 'react-dom';
import { AcpStartup, type StartLogEntry } from './AcpStartup';
import { peekSessionSnapshot, subscribeSessionEvents, useSessionStreamHealthy } from '@/lib/session-store';
import type { QueueCard } from '@/lib/card-queue';
import '../styles/acp.css';

type Block = { type: string; direction?: 'in' | 'out'; from?: { cardId: string; name: string }; to?: { cardId: string; name: string }[]; all?: boolean; text?: string; stream?: string; toolCallId?: string; title?: string; status?: string; content?: unknown; rawInput?: unknown; rawOutput?: unknown; entries?: { content: string; status: string }[]; id?: string; kind?: string; state?: string; request?: any; answer?: any };
type Turn = { withdrawn?: boolean; source?: 'event' | 'user' | 'agent'; sender?:{cardId:string;name:string;epoch:string}; at?: number; endedAt?: number; id: string; text: string; state: string; blocks: Block[]; attachments: { mediaType: string; data: string; name?: string }[]; result?: { stopReason?: string; error?: { message: string } } };
/** How many turns a conversation opens with, and adds each time the user scrolls up. */
const TURN_WINDOW = 15;
/** A card behind the front one in the deck is a preview: its last turns only. */
const PREVIEW_TURNS = 3;
type Snapshot = { ownerEpoch?:string;revision?:number; hostAccess?: boolean; promptCapabilities?: { image?: boolean; audio?: boolean }; state: string; stage?: string; startLog?: StartLogEntry[]; error?: string; turns: Turn[]; commands?: { name: string; description?: string }[]; context?: { used?: number; size?: number }; status?: { models?: { currentModelId?: string; availableModelIds: string[]; availableModels?: { modelId: string; name: string }[] }; availableCommands?: { name: string; description?: string }[]; usage?: SessionUsage; details?: { configOptions?: Config[] } } };
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
    error: '', connectionError: '', sending: false, controlBusy: false, follow: true, readingAt: 0, shownFrom: -1,
    mutationActive: {current: false},
    admission: {current: null as Admission | null},
  };
}, value => value.sending || value.controlBusy || !!value.admission.current);
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
  if (block.state === 'refused') return <div className="cq-acp-decision-receipt">已拒绝：{q?.toolCall?.title || '权限请求'}（当时没有进行中的对话，Que 不会代你同意）</div>;
  if (block.state !== 'pending') return <div className="cq-acp-decision-receipt">{block.state === 'expired' ? '请求已失效' : block.kind === 'permission' ? ({ allow_once:'已允许一次',allow_always:'已允许后续同类操作',reject_once:'已拒绝一次',reject_always:'已拒绝后续同类操作',cancel:'已取消' } as Record<string,string>)[block.answer?.outcome] : '已回复询问'}</div>;
  if (block.kind === 'permission') return <PermissionCard request={q} disabled={disabled} onAnswer={answer} />;
  const schema = q.requestedSchema || {};
  const submit = (event: FormEvent) => { event.preventDefault(); answer({action:'accept',content:values}); };
  return <form className="cq-acp-approval" onSubmit={submit}><strong>{q.message || '需要补充信息'}</strong>{Object.entries(schema.properties || {}).map(([key, raw]) => {
    const field = raw as any, required = schema.required?.includes(key);
    return <label key={key}>{field.title || key}{field.description && <small>{field.description}</small>}{field.enum ? <select required={required} value={values[key] ?? ''} onChange={e => setValues(v => ({...v,[key]:e.target.value}))}><option value="">请选择</option>{field.enum.map((v: string) => <option key={v}>{v}</option>)}</select> : field.type === 'boolean' ? <input type="checkbox" checked={!!values[key]} onChange={e => setValues(v => ({...v,[key]:e.target.checked}))} /> : <input required={required} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} value={values[key] ?? ''} onChange={e => setValues(v => ({...v,[key]:field.type === 'number' || field.type === 'integer' ? Number(e.target.value) : e.target.value}))} />}</label>;
  })}<div><button type="button" disabled={disabled} onClick={() => answer({action:'decline'})}>不提供</button><button type="submit" disabled={disabled}>提交</button></div></form>;
}
/**
 * One turn of the transcript. Turns are structurally shared between snapshots,
 * so a turn that did not change keeps its object and is not rendered again when
 * another one streams; a long conversation stays cheap to update.
 *
 * A finished turn that is not the last one shows what was said — the request,
 * messages between cards, and its closing answer — and folds the steps that led
 * there (thinking, tools, plans, text between them) into one line.
 */
const TurnView = memo(function TurnView({ turn, folded, archived, controlBusy, onQuote, onAnswer }: {
  turn: Turn; folded: boolean; archived: boolean; controlBusy: boolean;
  onQuote: (text: string) => void; onAnswer: (decisionId: string | undefined, answer: unknown) => void;
}) {
  const quote = archived ? undefined : onQuote;
  const groups = groupActivityBlocks(turn.blocks);
  const isAnswer = (group: typeof groups[number]) => group.block?.type === 'text_delta' && group.block.stream !== 'thought';
  let answerFrom = groups.length;
  while (answerFrom > 0 && isAnswer(groups[answerFrom - 1])) answerFrom--;
  const stepOf = (group: typeof groups[number], index: number) => folded && index < answerFrom && group.block?.type !== 'message';
  const steps = groups.filter(stepOf);
  const stepCount = steps.reduce((count, step) => count + (step.activities?.length ?? 1), 0);
  const render = ({ block: b, activities, index: i }: typeof groups[number]) => activities ? <ActivityGroup key={i} blocks={activities} running={busyTurn(turn)}/>
    : !b ? null
    : b.type === 'message' ? <CardMessage key={i} direction={b.direction === 'out' ? 'out' : 'in'} peers={b.direction === 'out' ? (b.to || []) : b.from ? [b.from] : []} all={b.all} text={b.text || ''}/>
    : b.type === 'text_delta' ? b.stream === 'thought'
      ? <Disclosure key={i} className="cq-acp-activity" summary="思考过程"><MarkdownMessage content={b.text || ''} role="assistant"/></Disclosure>
      : <MarkdownMessage key={i} content={b.text || ''} role="assistant"/>
    : b.type === 'decision' ? <Decision key={b.id} block={b} disabled={controlBusy || archived} answer={answer => void onAnswer(b.id, answer)}/>
    : b.entries ? <ul key={i} className="cq-acp-plan">{b.entries.map((e, j) => <li key={j} data-state={e.status}>{e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '◉' : '○'} {e.content}</li>)}</ul>
    : null;
  return <article className="cq-acp-turn">
    {hasUserContent(turn) && turn.sender && <div className="cq-acp-msg-group"><CardMessage direction="in" peers={[turn.sender]} text={turn.text}/><MessageActions text={turn.text} onQuote={quote}/></div>}
    {hasUserContent(turn) && !turn.sender && <div className="cq-acp-user-group"><div className="cq-acp-user">
      {turn.source === 'event' ? <Disclosure summary="工作会话通知"><pre>{turn.text}</pre></Disclosure> : <MarkdownMessage content={turn.text} role="user" />}
      {turn.attachments?.map((a, i) => a.mediaType.startsWith('image/') ? <img key={i} alt="已发送的图片" src={`data:${a.mediaType};base64,${a.data}`}/>
        : a.mediaType === 'text/plain' ? <Disclosure key={i} summary={a.name || '文本文件'}><pre>{a.data}</pre></Disclosure>
        : <audio key={i} controls src={`data:${a.mediaType};base64,${a.data}`}/>)}
    </div><MessageActions text={turn.text} onQuote={quote}/></div>}
    <div className="cq-acp-response">
      {steps.length > 0 && <Disclosure className="cq-acp-activity fc-activity-group cq-acp-steps" summary={<span className="fc-activity-label">过程 · {stepCount} 步</span>}>
        <div className="fc-activity-items">{steps.map(step => step.activities ? <ActivityItems key={step.index} blocks={step.activities}/> : render(step))}</div>
      </Disclosure>}
      {groups.filter((group, index) => !stepOf(group, index)).map(render)}
    </div>
    {!busyTurn(turn) && <MessageActions text={turn.blocks.filter(b => b.type === 'text_delta' && b.stream !== 'thought').map(b => b.text || '').join('\n\n')} onQuote={quote}/>}
    {turnLabel[turn.state] && <div className="cq-acp-turn-state" role="status">{turn.blocks.some(b => b.type === 'decision' && b.state === 'pending') ? '等待你的确认' : turnLabel[turn.state]}</div>}
    {turn.result?.error && <p role="alert" className="cq-acp-error">{turn.result.error.message}</p>}
    {turn.result?.stopReason && !['end_turn','cancelled'].includes(turn.result.stopReason) && <p className="cq-acp-turn-state">结束原因：{turn.result.stopReason}</p>}
  </article>;
});

export function AcpConversation({ card, active, onResume }: {card: QueueCard; active: boolean; onResume: () => Promise<void>}) {
  const {t}=useI18n();
  const viewKey=JSON.stringify([card.id, card.workspaceId, card.cwd, card.harness?.kind]);
  const view = useConversationView(viewKey);
  const {mutationActive, admission} = view.value;
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
  const [viewing, setViewing] = useState<{src:string;alt:string}>();
  const [error,setError] = view.field('error');
  const [connectionError,setConnectionError] = view.field('connectionError');
  const [sending,setSending] = view.field('sending');
  const [controlBusy,setControlBusy] = view.field('controlBusy');
  const [follow,setFollow] = view.field('follow');
  const [readingAt,setReadingAt] = view.field('readingAt');
  const [shownFrom,setShownFrom] = view.field('shownFrom');
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const draftNow=useRef({text:draft,quote,attachments});draftNow.current={text:draft,quote,attachments};
  const archived = card.archivedAt !== undefined;
  useEffect(() => { if(quote) sessionStorage.setItem(`queacp:quote:${card.id}`,quote); else sessionStorage.removeItem(`queacp:quote:${card.id}`); },[card.id,quote]);
  useEffect(() => { sessionStorage.setItem(`queacp:draft:${card.id}`, draft); }, [card.id,draft]);
  // A card shown elsewhere (a tile) already has its conversation in the shared
  // store: open with it, before the first paint, instead of a loading state.
  useLayoutEffect(() => {
    if (snapshot) return;
    const known = peekSessionSnapshot(card.id);
    if (known) setSnapshot(known as unknown as Snapshot);
  }, [card.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The conversation follows its card on the app's one session stream: its
  // current state first, then ordered deltas (see runtime/session-wire.mjs). A
  // delta that does not fit means a missed event, repaired by reading one full
  // snapshot. It folds them into its own state, which also holds the turns it
  // just sent.
  useEffect(() => {
    if (!active) return;
    let closed=false, resyncing=false, frame:ReturnType<typeof setTimeout>|undefined;
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
    const stop=subscribeSessionEvents(card.id,event=>{queue.push(event as unknown as StreamEvent<Snapshot>);frame??=setTimeout(flush,16);});
    void resync();
    return()=>{closed=true;clearTimeout(frame);stop();};
  },[active,card.id,setSnapshot]);
  const streamHealthy=useSessionStreamHealthy();
  useEffect(()=>{ if(active)setConnectionError(streamHealthy?'':'暂时无法刷新会话状态，正在重试…'); },[active,streamHealthy,setConnectionError]);
  // Where the transcript stands is the user's choice alone: following the end,
  // or the place they scrolled up to. Only their own scrolling (wheel, touch,
  // scrollbar, keys) changes it; a scroll caused by layout — a card mounting
  // again elsewhere, content arriving late, the box resizing — never does.
  // Following, it stays at the end however the size changes; otherwise it keeps
  // its place, and a card opened again returns to it.
  const following = useRef(follow); following.current = follow;
  const userScrolling = useRef(false);
  const toEnd = useCallback(() => {
    const box = scroll.current;
    if (!box || !following.current) return;
    userScrolling.current = false;
    box.scrollTop = box.scrollHeight;
  }, []);
  useLayoutEffect(toEnd, [snapshot, follow, toEnd]);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !snapshot || !scroll.current) return;
    restored.current = true;
    if (!following.current) { userScrolling.current = false; scroll.current.scrollTop = readingAt; }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const box = scroll.current, body = content.current;
    if (!box || !body) return;
    const observer = new ResizeObserver(toEnd);
    observer.observe(box); observer.observe(body);
    return () => observer.disconnect();
  }, [toEnd]);
  const userScroll = () => { userScrolling.current = true; };
  const scrolled = (box: HTMLDivElement) => {
    // Moved by something else while following: back to the end, at once.
    if (!userScrolling.current) { toEnd(); return; }
    setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
    setReadingAt(box.scrollTop);
    if (box.scrollTop < 400) earlier();
  };
  // A long conversation opens with its last turns only; earlier ones are added
  // as the user scrolls up to them, the page held still where it was.
  const shownTurns=(snapshot?.turns || []).filter(turn=>turn.state!=='queued'&&!turn.withdrawn&&!missingReceipt(turn));
  const first=shownFrom<0 ? Math.max(0, shownTurns.length-TURN_WINDOW) : Math.min(shownFrom, shownTurns.length);
  const start=active ? first : Math.max(first, shownTurns.length-PREVIEW_TURNS);
  const anchor=useRef<number|null>(null);
  const earlier=()=>{
    const box=scroll.current;
    if(!box || first===0 || anchor.current!==null)return;
    anchor.current=box.scrollHeight-box.scrollTop;
    setShownFrom(Math.max(0, first-TURN_WINDOW));
  };
  useLayoutEffect(()=>{
    const box=scroll.current;
    // The window starts where it opened: new turns are added after it, never moving it.
    if(shownFrom<0 && snapshot){ setShownFrom(first); return; }
    if(!box)return;
    if(anchor.current!==null){ box.scrollTop=box.scrollHeight-anchor.current; anchor.current=null; setReadingAt(box.scrollTop); }
    // Too short to scroll up: nothing would ever ask for more.
    // A hidden view (no height) is not short: it would load the whole history.
    else if(active && first>0 && box.clientHeight>0 && box.scrollHeight<=box.clientHeight) setShownFrom(Math.max(0, first-TURN_WINDOW));
  },[first, shownFrom, snapshot, active]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // Handed to every turn: stable, so an unchanged turn is not rendered again.
  const latest=useRef({quoteMessage,command});latest.current={quoteMessage,command};
  const onQuote=useCallback((text:string)=>latest.current.quoteMessage(text),[]);
  const onAnswer=useCallback((decisionId:string|undefined,answer:unknown)=>void latest.current.command({action:'answer',decisionId,answer}),[]);
  const options=snapshot?.status?.details?.configOptions || [];
  const commands=snapshot?.commands || snapshot?.status?.availableCommands || [];
  // Transport startup is independent of whether history has already loaded.
  const loading=!snapshot && !connectionError;
  const disconnected=['not_running','error','unknown'].includes(snapshot?.state || '');
  const missingReceipts=turns.filter(turn=>!turn.withdrawn && missingReceipt(turn)).map(turn=>turn.id);
  const viewImage=(event:React.MouseEvent)=>{const image=(event.target as Element).closest('.cq-acp-user img, img.cq-acp-result-image');if(image instanceof HTMLImageElement)setViewing({src:image.src,alt:image.alt});};
  return <div className="cq-harness-body cq-acp">
    {viewing && createPortal(<ImageViewer src={viewing.src} alt={viewing.alt} onClose={()=>setViewing(undefined)}/>, document.body)}
    <div ref={scroll} className="cq-acp-transcript" onScroll={e=>scrolled(e.currentTarget)}
      onWheel={userScroll} onTouchMove={userScroll} onPointerDown={userScroll} onKeyDown={userScroll} onClick={viewImage}><div ref={content}>
      {loading && !connectionError && <div className="cq-acp-loading" role="status"><span className="cq-acp-spinner" aria-hidden="true"/>{t('acp.loading.history')}</div>}
      {snapshot && !connectionError && !loading && snapshot.state!=='starting' && !sending && !disconnected && !turns.length && <div className="cq-acp-welcome"><h3>开始处理这个任务</h3><p>消息、执行过程和需要你确认的操作会显示在这里。</p></div>}
      {active && first>0 && <button type="button" className="cq-acp-earlier" onClick={earlier}>显示更早的 {Math.min(first, TURN_WINDOW)} 轮</button>}
      {shownTurns.slice(start).map((turn,i,shown)=><TurnView key={turn.id} turn={turn} folded={i<shown.length-1 && !busyTurn(turn)} archived={archived} controlBusy={controlBusy} onQuote={onQuote} onAnswer={onAnswer}/>)}
      {/* Connecting: what it is doing, step by step, where the conversation will be. */}
      {snapshot?.state==='starting' && card.harness && <div className="cq-acp-connecting"><AcpStartup agent={card.harness.kind} stage={snapshot.stage || 'preparing'} log={snapshot.startLog}/></div>}
      <MissingReceiptsNotice key={viewKey} identity={viewKey} receiptIds={missingReceipts}/>
    </div></div>
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
