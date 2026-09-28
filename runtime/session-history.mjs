import fs from 'node:fs/promises';
import path from 'node:path';
import {createFileSessionStore} from 'acpx/runtime';

function parseToolContent(value) {try{return typeof value==='string'?JSON.parse(value):undefined;}catch{return undefined;}}

// Payload is a fallback only when the canonical acpx record does not contain
// this message. Never throw it away merely because an old messageId exists.
export function turnReceipt(turn, persistedMessageIds) {
  return {id:turn.id,messageId:turn.messageId,hiddenPrefixLength:turn.hiddenPrefixLength,
    fingerprint:turn.fingerprint,sender:turn.sender,source:turn.source,state:turn.state,withdrawn:turn.withdrawn,
    pending:turn.messageId && persistedMessageIds.has(turn.messageId) ? undefined : {text:turn.text,attachments:turn.attachments},
    result:turn.result?{status:turn.result.status,stopReason:turn.result.stopReason,error:turn.result.error}:undefined};
}

export function projectRecord(record, receipts = []) {
  const turns=[];
  let turn;
  for(const message of record.messages || []) {
    if(message.User) {
      const user=message.User, receipt=receipts.find(r=>r.messageId===user.id);
      turn={id:receipt?.id || user.id,messageId:user.id,hiddenPrefixLength:receipt?.hiddenPrefixLength,text:(user.content||[]).filter(c=>'Text' in c).map(c=>c.Text).join('\n').slice(receipt?.hiddenPrefixLength || 0),attachments:[],blocks:[],sender:receipt?.sender,source:receipt?.source || (receipt?.sender?'agent':'user'),state:receipt?.state === 'unknown' && !receipt.fingerprint && !receipt.result ? 'history' : receipt?.state || 'history',fingerprint:receipt?.fingerprint,withdrawn:receipt?.withdrawn,result:receipt?.result};
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
  for(const receipt of receipts) if(!turns.some(t=>t.id===receipt.id))turns.push({id:receipt.id,fingerprint:receipt.fingerprint,text:receipt.pending?.text || '',attachments:receipt.pending?.attachments || [],sender:receipt.sender,source:receipt.source,withdrawn:receipt.withdrawn,blocks:[],result:receipt.result,state:['completed','failed','cancelled'].includes(receipt.state)?receipt.state:'unknown'});
  return turns;
}

export function sessionHistory(stateDir) {
  const store=createFileSessionStore({stateDir});
  return {
    store,
    async list(cwd) {
      let names;
      try {names=await fs.readdir(path.join(stateDir,'sessions'));}catch(error){if(error.code==='ENOENT')return [];throw error;}
      const records=[];
      for(const name of names.filter(n=>n.endsWith('.json'))) {
        let id;try{id=decodeURIComponent(name.slice(0,-5));}catch{continue;}
        const record=await store.load(id);
        if(record && (!cwd || path.resolve(record.cwd)===path.resolve(cwd)))records.push(record);
      }
      return records.sort((a,b)=>String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
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
      if (block?.content !== undefined) result.flat_content_json=JSON.stringify(block.content);
      if (block?.status) result.flat_status=block.status;
    }
  }
  return record;
}
