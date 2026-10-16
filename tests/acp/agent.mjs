import readline from 'node:readline';
import fs from 'node:fs';
if(process.env.QUEACP_TEST_PID_FILE)fs.appendFileSync(process.env.QUEACP_TEST_PID_FILE,process.pid+'\n');
// Simulates an agent that ignores losing its client and must be killed.
if(process.env.QUEACP_TEST_IGNORE_EOF){setInterval(()=>{},1000);process.stdout.on('error',()=>{});}
let model='small', respond;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const notify = update => send({method:'session/update',params:{sessionId:'test-session',update}});
readline.createInterface({input:process.stdin}).on('line', async line => {
  const message=JSON.parse(line), {id, method,params}=message;
  if (!method) {respond?.(message.result ?? {error:message.error});return;}
  if(process.env.QUEACP_TEST_EMPTY_ROLLOUT && ['session/load','session/resume'].includes(method) && !fs.existsSync(process.env.QUEACP_TEST_EMPTY_ROLLOUT)) {
    // Codex reports a missing rollout; Devin just says the session is unknown.
    if(process.env.QUEACP_TEST_LOAD_ERROR==='not-found'){send({id,error:{code:-32602,message:'Session not found'}});return;}
    send({id,error:{code:-32603,message:'Internal error',data:{details:'no rollout found for thread id '+params.sessionId}}});return;
  }
  if(method==='session/load' && params.sessionId==='locked-native') {
    send({id,error:{code:-32603,message:'Internal error',data:{details:'thread locked-native already has an active writer'}}});return;
  }
  if(process.env.QUEACP_TEST_MCP_FILE && ['session/new','session/load'].includes(method))fs.writeFileSync(process.env.QUEACP_TEST_MCP_FILE,JSON.stringify(params.mcpServers));
  let result={};
  if(method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},resume:{}},promptCapabilities:{image:true,audio:true}},authMethods:[]};
  if(method==='session/new'||method==='session/load')result={sessionId:'test-session',models:{currentModelId:model,availableModels:[{modelId:'small',name:'Small'},{modelId:'large',name:'Large'}]},configOptions:[{id:'mode',name:'权限模式',category:'mode',type:'select',currentValue:'ask',options:[{value:'ask',name:'每次询问'},{value:'auto',name:'自动模式'}]}]};
  if(method==='session/load' && params.sessionId==='native-one') {
    send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:'Earlier user question'}}}});
    send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Earlier agent answer'}}}});
  }
  if(method==='session/list')result={sessions:[{sessionId:params.cursor?'native-two':'native-one',cwd:params.cwd||process.cwd(),title:params.cursor?'Second native':'First native',updatedAt:new Date().toISOString()}],...params.cursor?{}:{nextCursor:'page-two'}};
  if(method==='session/list'&&!params.cwd)result.sessions.push({sessionId:'other-workspace',cwd:'/tmp/another-workspace',title:'Other workspace'});
  if(method==='session/set_model'){model=params.modelId;}
  if(method==='session/set_config_option')result={configOptions:[{id:'mode',name:'权限模式',category:'mode',type:'select',currentValue:params.value,options:[{value:'ask',name:'每次询问'},{value:'auto',name:'自动模式'}]}]};
  if(method==='session/prompt'){
    // A permission request after the turn has ended: no turn can show it.
    if(params.prompt[0].text==='after-turn-request'){
      send({id,result:{stopReason:'end_turn'}});
      setTimeout(()=>{respond=answer=>fs.writeFileSync(process.env.QUEACP_TEST_LATE_FILE,JSON.stringify(answer));
        send({id:98,method:'session/request_permission',params:{sessionId:'test-session',toolCall:{toolCallId:'late1',title:'后台写入文件',kind:'edit'},options:[{optionId:'yes',kind:'allow_once',name:'允许一次'},{optionId:'no',kind:'reject_once',name:'拒绝'}]}});},300);
      return;
    }
    if(params.prompt[0].text.includes('mid-turn-config')){
      notify({sessionUpdate:'config_option_update',configOptions:[{id:'mode',name:'权限模式',category:'mode',type:'select',currentValue:'auto',options:[{value:'ask',name:'每次询问'},{value:'auto',name:'自动模式'}]}]});
      await new Promise(resolve=>setTimeout(resolve,8000));
      notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'finished'}});
      send({id,result:{stopReason:'end_turn'}});return;
    }
    if(params.prompt[0].text.includes('stream-many')){
      for(let i=0;i<3000;i++){notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`token${i} `}});if(i%100===0)await new Promise(resolve=>setImmediate(resolve));}
      send({id,result:{stopReason:'end_turn'}});return;
    }
    if(process.env.QUEACP_TEST_EMPTY_ROLLOUT)fs.writeFileSync(process.env.QUEACP_TEST_EMPTY_ROLLOUT,'persisted');
    if(params.prompt[0].text==='host-terminal-check') {
      const call=(method,params)=>new Promise(resolve=>{respond=resolve;send({id:98,method,params:{sessionId:'test-session',...params}})});
      const terminal=await call('terminal/create',{command:process.execPath,args:['-e','process.stdout.write("host-terminal-ok")']});
      let text='host-terminal-denied';
      if(terminal.terminalId){await call('terminal/wait_for_exit',{terminalId:terminal.terminalId});const out=await call('terminal/output',{terminalId:terminal.terminalId});text=out.output;await call('terminal/release',{terminalId:terminal.terminalId});}
      notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});send({id,result:{stopReason:'end_turn'}});return;
    }

    if(params.prompt[0].text.includes('file-check')) notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(params.prompt)}});
    notify({sessionUpdate:'available_commands_update',availableCommands:[{name:'compact',description:'整理上下文'}]});
    notify({sessionUpdate:'session_info_update',title:'Fixture native title'});
    notify({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'检查当前任务。'}});
    notify({sessionUpdate:'tool_call',toolCallId:'read1',title:'查看项目文件',kind:'read',status:'in_progress'});
    if(params.prompt[0].text.includes('permission')){
      await new Promise(resolve=>{respond=resolve;send({id:99,method:'session/request_permission',params:{sessionId:'test-session',toolCall:{toolCallId:'write1',title:'修改示例文件',kind:'edit'},options:[{optionId:'yes',kind:'allow_once',name:'允许一次'},{optionId:'no',kind:'reject_once',name:'拒绝'}]}})});
    }
    await new Promise(r=>setTimeout(r,params.prompt[0].text==='watch-hold'?1500:250));
    notify({sessionUpdate:'tool_call_update',toolCallId:'read1',status:'completed',content:[{type:'content',content:{type:'text',text:'文件读取完成'}},{type:'diff',path:'example.ts',oldText:'before',newText:'after'}]});
    notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`任务已处理。当前模型：${model}。\n\n原来的卡片队列继续承载这段会话。`}});
    notify({sessionUpdate:'usage_update',used:1200,size:32000});
    result={stopReason:'end_turn'};
  }
  // JSON-RPC needs a result member; without one the client waits for its timeout.
  if(id!==undefined)send({id,result:result??null});
});
