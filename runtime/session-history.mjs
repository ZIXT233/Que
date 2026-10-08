import fs from 'node:fs/promises';
import path from 'node:path';
import {createFileSessionStore} from 'acpx/runtime';

function parseToolContent(value) {try{return typeof value==='string'?JSON.parse(value):undefined;}catch{return undefined;}}

// Payload is a fallback only when the canonical acpx record does not contain
// this message. Never throw it away merely because an old messageId exists.
export function turnReceipt(turn, persistedMessageIds) {
  return {id:turn.id,messageId:turn.messageId,hiddenPrefixLength:turn.hiddenPrefixLength,
    fingerprint:turn.fingerprint,sender:turn.sender,source:turn.source,state:turn.state,withdrawn:turn.withdrawn,at:turn.at,endedAt:turn.endedAt,
    pending:turn.messageId && persistedMessageIds.has(turn.messageId) ? undefined : {text:turn.text,attachments:turn.attachments},
    result:turn.result?{status:turn.result.status,stopReason:turn.result.stopReason,error:turn.result.error}:undefined};
}

export function projectRecord(record, receipts = []) {
  const turns=[];
  let turn;
  // Long histories: look receipts up by message id instead of scanning per message.
  const byMessage=new Map();
  for(const r of receipts) if(r.messageId!==undefined && !byMessage.has(r.messageId))byMessage.set(r.messageId,r);
  for(const message of record.messages || []) {
    if(message.User) {
      const user=message.User, receipt=byMessage.get(user.id);
      turn={id:receipt?.id || user.id,messageId:user.id,hiddenPrefixLength:receipt?.hiddenPrefixLength,text:(user.content||[]).filter(c=>'Text' in c).map(c=>c.Text).join('\n').slice(receipt?.hiddenPrefixLength || 0),attachments:[],blocks:[],sender:receipt?.sender,source:receipt?.source || (receipt?.sender?'agent':'user'),state:receipt?.state === 'unknown' && !receipt.fingerprint && !receipt.result ? 'history' : receipt?.state || 'history',fingerprint:receipt?.fingerprint,withdrawn:receipt?.withdrawn,result:receipt?.result,at:receipt?.at,endedAt:receipt?.endedAt};
      for(const content of user.content||[]) { const media=content.Image||content.Audio;if(media)turn.attachments.push({mediaType:media.mime_type,data:media.source}); }
      turns.push(turn);
    }
    if(message.Agent) {
      if(!turn) {turn={id:`history:${turns.length}`,text:'',attachments:[],blocks:[],state:'history'};turns.push(turn);}
      for(const content of message.Agent.content||[]) {
        if('Text' in content)turn.blocks.push({type:'text_delta',stream:'message',text:content.Text});
        if(content.Thinking)turn.blocks.push({type:'text_delta',stream:'thought',text:content.Thinking.text});
        if(content.ToolUse) { const tool=content.ToolUse,result=message.Agent.tool_results?.[tool.id];turn.blocks.push({type:'tool_call',toolCallId:tool.id,title:tool.name,rawInput:tool.input||tool.raw_input,rawOutput:result?.output ?? result?.content?.Text ?? result?.content,content:parseToolContent(result?.flat_content_json) || (Array.isArray(result?.output)?result.output:undefined),status:result?.flat_status || (result?.is_error?'failed':tool.is_input_complete?'completed':'unknown')}); }
      }
    }
  }
  // A submitted request may not have reached acpx before a crash. Keep its receipt
  // as unknown rather than silently permitting a duplicate submission.
  const known=new Set(turns.map(t=>t.id));
  for(const receipt of receipts) if(!known.has(receipt.id)){known.add(receipt.id);turns.push({id:receipt.id,fingerprint:receipt.fingerprint,text:receipt.pending?.text || '',attachments:receipt.pending?.attachments || [],sender:receipt.sender,source:receipt.source,withdrawn:receipt.withdrawn,blocks:[],result:receipt.result,at:receipt.at,endedAt:receipt.endedAt,state:['completed','failed','cancelled'].includes(receipt.state)?receipt.state:'unknown'});}
  return turns;
}

/** Run `task` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while(next < items.length) { const index = next++; results[index] = await task(items[index], index); }
  }));
  return results;
}

const summarize = r => ({acpxRecordId:r.acpxRecordId,cwd:r.cwd,title:r.title,name:r.name,lastUsedAt:r.lastUsedAt,acpSessionId:r.acpSessionId,agentArgv:r.agentArgv,agentCommand:r.agentCommand});

export function sessionHistory(stateDir, {store=createFileSessionStore({stateDir})}={}) {
  // Listing must not re-read every transcript: remember each record's summary
  // until its file changes. A transcript can be many megabytes.
  const summaries=new Map();
  return {
    store,
    async list(cwd) {
      const dir=path.join(stateDir,'sessions');
      let names;
      try {names=await fs.readdir(dir);}catch(error){if(error.code==='ENOENT')return [];throw error;}
      names=names.filter(n=>n.endsWith('.json'));
      const live=new Set(names);
      for(const name of summaries.keys())if(!live.has(name))summaries.delete(name);
      const found=await mapLimit(names,8,async name=>{
        let id;try{id=decodeURIComponent(name.slice(0,-5));}catch{return undefined;}
        let stat;try{stat=await fs.stat(path.join(dir,name));}catch{summaries.delete(name);return undefined;}
        const stamp=`${stat.mtimeMs}:${stat.size}`;
        let entry=summaries.get(name);
        if(entry?.stamp!==stamp){
          const record=await store.load(id);
          // A file without an id and workspace is not a usable session record.
          entry={stamp,summary:record?.acpxRecordId && typeof record.cwd==='string' ? summarize(record) : undefined};
          summaries.set(name,entry);
        }
        return entry.summary;
      });
      return found.filter(r=>r && (!cwd || path.resolve(r.cwd)===path.resolve(cwd)))
        .sort((a,b)=>String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
    }
  };
}

// Preserve rendered ACP content inside the existing acpx record, not a second history file.
export function preserveToolContent(record, turns) {
  let turn;
  for (const message of record.messages || []) {
    if(message.User) turn=turns.find(t=>t.messageId===message.User.id);
    const blocks=new Map((turn?.blocks||[]).filter(b=>b.type==='tool_call').map(b=>[b.toolCallId,b]));
    for (const [id,result] of Object.entries(message.Agent?.tool_results || {})) {
      const block=blocks.get(id);
      // A finished tool call never changes again: serialize its content once.
      if (block && result.flat_content_json !== undefined && result.flat_status === block.status && ['completed','failed'].includes(block.status)) continue;
      if (block?.content !== undefined) result.flat_content_json=JSON.stringify(block.content);
      if (block?.status) result.flat_status=block.status;
    }
  }
  return record;
}
