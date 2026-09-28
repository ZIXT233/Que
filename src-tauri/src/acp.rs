use crate::{error::{AppError, AppResult}, live::LiveBus, models::{HarnessSession, QueueWorkspace}, terminal::TerminalHub};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::{Arc, atomic::{AtomicU8, Ordering}}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, sync::{mpsc, oneshot}};

fn accept_snapshot(values: &mut HashMap<String, Value>, id: &str, next: &Value) -> bool {
    if let Some(previous) = values.get(id) {
        if next["ownerEpoch"].is_string() && next["ownerEpoch"] == previous["ownerEpoch"]
            && matches!((next["revision"].as_u64(), previous["revision"].as_u64()), (Some(a), Some(b)) if a < b) {
            return false;
        }
    }
    values.insert(id.into(), next.clone());
    true
}

// HTTP cancellation must remove the RPC waiter even when request() is dropped
// before its timeout runs. It does not cancel or resend the agent's operation.
struct PendingRequest {
    id: String,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
}
impl Drop for PendingRequest {
    fn drop(&mut self) { self.pending.lock().remove(&self.id); }
}

fn disconnect_snapshots(
    generations:&Mutex<HashMap<String,String>>, snapshots:&Mutex<HashMap<String,Value>>,
    machine:&str, generation:&str, ids:&std::collections::HashSet<String>, error:&str,
) -> bool {
    let mut current=generations.lock();
    if current.get(machine).map(String::as_str)!=Some(generation) {return false;}
    let mut values=snapshots.lock();
    for id in ids {if let Some(snapshot)=values.get_mut(id) {
        snapshot["state"]=json!("unknown");snapshot["error"]=json!(error);
        // A broken transport is not evidence that the owner stopped its turns.
    }}
    current.remove(machine);
    true
}

#[derive(Clone)]
struct Link { generation: String, machine: String, input: mpsc::UnboundedSender<Vec<u8>>, pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>, read_timeouts: Arc<AtomicU8> }
impl Link {
    fn timed_out(&self, action: &str) -> bool {
        // Slow mutations are not failed transports. Only repeated failed
        // liveness reads justify replacing a shared machine connection.
        matches!(action, "read" | "list" | "health") && self.read_timeouts.fetch_add(1, Ordering::Relaxed) >= 2
    }
}
pub(crate) struct RemoteMcpRequest {
    pub machine: String,
    pub generation: String,
    pub message: Value,
    pub reply: mpsc::UnboundedSender<Vec<u8>>,
}
#[derive(Clone)]
pub struct AcpRuntime {
    snapshots: Arc<Mutex<HashMap<String, Value>>>,
    generations: Arc<Mutex<HashMap<String,String>>>,
    links: Arc<tokio::sync::Mutex<HashMap<String, Link>>>,
    connecting: Arc<Mutex<HashMap<String,Arc<tokio::sync::Mutex<()>>>>>,
    live: LiveBus,
    remote_mcp: Arc<Mutex<Option<mpsc::Sender<RemoteMcpRequest>>>>,
}
impl AcpRuntime {
    pub fn new(live: LiveBus) -> Self { Self { snapshots: Default::default(), generations:Default::default(), links: Default::default(), connecting:Default::default(), remote_mcp:Default::default(), live } }
    pub(crate) fn remote_requests(&self) -> mpsc::Receiver<RemoteMcpRequest> {
        let (sender, receiver) = mpsc::channel(128);
        *self.remote_mcp.lock() = Some(sender);
        receiver
    }
    pub(crate) fn current_link(&self, machine: &str, generation: &str) -> bool {
        self.generations.lock().get(machine).is_some_and(|value| value == generation)
    }
    pub fn is_live(&self, id: &str) -> bool {
        self.snapshots.lock().get(id).is_some_and(|s| matches!(s["state"].as_str(), Some("working" | "attention" | "starting")))
    }
    pub fn epoch(&self, id: &str) -> String {
        self.snapshots.lock().get(id).and_then(|s| s["connectionId"].as_str()).unwrap_or_default().into()
    }
    pub fn snapshot(&self, session: &HarnessSession, _terminals: &TerminalHub, _workspace: Option<&QueueWorkspace>) -> HarnessSession {
        let mut result = session.clone();
        if let Some(s) = self.snapshots.lock().get(&session.terminal_id) {
            result.session_name = s["title"].as_str().filter(|t| !t.trim().is_empty()).map(str::to_string).or(result.session_name);
            result.state = s["state"].as_str().unwrap_or("unknown").into();
            result.provider_session_id = s["status"]["agentSessionId"].as_str().or(s["status"]["backendSessionId"].as_str()).map(str::to_string);
            if let Some(turns) = s["turns"].as_array() {
                result.first_prompt = turns.iter().filter(|t| t["source"] != "event" && t["source"] != "agent").find_map(|t| t["text"].as_str().filter(|text| !text.trim().is_empty())).map(str::to_string);
                result.reply_preview = turns.last().and_then(|t| t["blocks"].as_array()).map(|bs| bs.iter().filter(|b| b["type"] == "text_delta" && b["stream"] != "thought").filter_map(|b| b["text"].as_str()).collect::<String>());
            }
        } else { result.state = "not_running".into(); }
        result
    }
    pub fn debug_snapshot(&self, id: &str, _: &TerminalHub) -> Value { self.snapshots.lock().get(id).cloned().unwrap_or(Value::Null) }
    async fn link(&self, workspace: &QueueWorkspace, bin: &Path) -> AppResult<Link> {
        let machine = workspace.ssh_host.clone().unwrap_or_else(|| "local".into());
        if let Some(link) = self.links.lock().await.get(&machine).filter(|l| !l.input.is_closed()).cloned() {return Ok(link);}
        let setup=self.connecting.lock().entry(machine.clone()).or_default().clone();
        let _setup=setup.lock().await;
        if let Some(link) = self.links.lock().await.get(&machine).filter(|l| !l.input.is_closed()).cloned() {return Ok(link);}
        let (input, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let (output, mut out) = mpsc::unbounded_channel::<Vec<u8>>();
        let bundle = bin.join("flat-acp.mjs");
        if let Some(host) = &workspace.ssh_host {
            use sha2::{Digest, Sha256};
            let bytes = tokio::fs::read(&bundle).await?;
            let hash = hex::encode(Sha256::digest(&bytes));
            let remote = format!("$HOME/.flat/runtime/{hash}.mjs");
            let install = format!("umask 077; mkdir -p \"$HOME/.flat/runtime\"; cat > \"{remote}.tmp\" && mv \"{remote}.tmp\" \"{remote}\"");
            tokio::time::timeout(Duration::from_secs(15),crate::ssh::ssh_exec_stdin(host, &install, &bytes)).await.map_err(|_|AppError::msg("远程连接超时，请重试"))??;
            let command = crate::ssh::ssh_login_command(&format!("exec node \"{remote}\""));
            let host = host.clone();
            tokio::spawn(async move {
                let errors=output.clone();
                if let Err(error)=crate::remote::acp_channel(&host,&command,rx,output).await {
                    let _=errors.send(format!("{}\n",json!({"transportError":error.to_string()})).into_bytes());
                }
            });
        } else {
            let env = crate::harness::local_environment(false).await?;
            let node = which::which_in("node", env.get("PATH"), ".").map_err(|_| AppError::msg("需要 Node.js 22.13 或更新版本"))?;
            let mut child = tokio::process::Command::new(node).arg(&bundle).envs(env).env("FLAT_ACP_ROOT", crate::paths::data_dir().join("acp"))
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn()?;
            let mut stderr=child.stderr.take().unwrap();
            let error_output=output.clone();
            tokio::spawn(async move {
                let mut bytes=Vec::new();
                let mut chunk=[0u8;4096];
                while let Ok(n)=stderr.read(&mut chunk).await {
                    if n==0 {break;}
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.len()>8192 {bytes.drain(..bytes.len()-8192);}
                }
                if !bytes.is_empty() {let _=error_output.send(format!("{}\n",json!({"transportError":String::from_utf8_lossy(&bytes)})).into_bytes());}
            });
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            tokio::spawn(async move {
                let mut buffer = vec![0; 65536];
                loop { tokio::select! {
                    data = rx.recv() => match data { Some(data) => if stdin.write_all(&data).await.is_err() { break; }, None => break },
                    size = stdout.read(&mut buffer) => match size { Ok(n) if n > 0 => { if output.send(buffer[..n].to_vec()).is_err() { break; } }, _ => break }
                }}
                let _ = child.kill().await;
            });
        }
        let pending = Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));
        let generation=uuid::Uuid::new_v4().to_string();
        self.generations.lock().insert(machine.clone(),generation.clone());
        let link = Link { generation:generation.clone(),machine:machine.clone(),input, pending: pending.clone(),read_timeouts:Arc::new(AtomicU8::new(0)) };
        self.links.lock().await.insert(machine.clone(), link.clone());
        if workspace.kind=="ssh" {
            if let Some(sender)=self.remote_mcp.lock().as_ref() {
                let _=sender.try_send(RemoteMcpRequest{machine:machine.clone(),generation:generation.clone(),message:json!({"event":"mcp_connect"}),reply:link.input.clone()});
            }
        }
        let snapshots = self.snapshots.clone(); let live = self.live.clone(); let generations=self.generations.clone();
        let remote_mcp=self.remote_mcp.clone();let reverse_input=link.input.clone();let is_remote=workspace.kind=="ssh";
        tokio::spawn(async move {
            let mut transport_error="连接已断开，执行结果尚未确认".to_string();
            let mut buffer = Vec::new();
            let mut seen = std::collections::HashSet::new();
            while let Some(bytes) = out.recv().await {
                buffer.extend(bytes);
                while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = buffer.drain(..=end).collect();
                    if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                        if let Some(error)=value["transportError"].as_str() {transport_error=error.to_string();continue;}
                        let current=generations.lock();
                        if current.get(&machine)!=Some(&generation) {continue;}
                        if let Some(id) = value["id"].as_str().filter(|_| value["event"] == "session") {
                            if accept_snapshot(&mut snapshots.lock(),id,&value["snapshot"]) {live.notify("acp");}
                            seen.insert(id.to_string());
                        } else if value["event"] == "mcp_request" && is_remote {
                            let request_id=value["requestId"].clone();
                            let request=RemoteMcpRequest{machine:machine.clone(),generation:generation.clone(),message:value,reply:reverse_input.clone()};
                            let delivered=remote_mcp.lock().as_ref().is_some_and(|sender|sender.try_send(request).is_ok());
                            if !delivered {let _=reverse_input.send(format!("{}\n",json!({"action":"_mcp_result","requestId":request_id,"result":{"isError":true,"content":[{"type":"text","text":"Flat MCP relay is unavailable or busy; no retry was made"}]}})).into_bytes());}
                        } else if let Some(rpc) = value["rpc"].as_str() {
                            if let Some(sender) = pending.lock().remove(rpc) { let _ = sender.send(value); }
                        }
                    }
                }
            }
            for (_,sender) in pending.lock().drain() {let _=sender.send(json!({"error":transport_error}));}
            if !disconnect_snapshots(&generations,&snapshots,&machine,&generation,&seen,&transport_error) {return;}
            live.notify("acp");
        });
        Ok(link)
    }
    pub async fn request(&self, workspace: &QueueWorkspace, bin: &Path, mut body: Value) -> AppResult<Value> {
        body["env"] = json!(crate::workspace_rc::session_environment(workspace));
        body["terminalRc"] = json!(crate::workspace_rc::script(workspace).unwrap_or(""));
        if workspace.kind == "local" && matches!(body["action"].as_str(), Some("ensure" | "attach" | "host_access" | "send")) {
            body["mcpBridge"] = json!(crate::paths::data_dir().join("mcp").join("que-mcp.cjs"));
        }
        if workspace.kind == "ssh" && matches!(body["action"].as_str(),Some("ensure"|"attach"|"host_access"|"send"|"read"|"health")) {
            body["mcpRelay"]=json!(true);
            body.as_object_mut().map(|v|v.remove("mcpBridge"));
        }
        body.as_object_mut().map(|v|v.remove("butlerContext"));
        if workspace.id==crate::butler::WORKSPACE_ID && workspace.kind=="local" && std::path::Path::new(&workspace.cwd)==crate::butler::root() && body["id"]==crate::butler::CARD_ID && body["action"]=="send" {
            body["butlerContext"]=json!(include_str!("../../resources/butler/ROLE.md"));
        }
        let link = self.link(workspace, bin).await?;
        let id = uuid::Uuid::new_v4().to_string();
        body["rpc"] = json!(id);
        let (sender, receiver) = oneshot::channel(); link.pending.lock().insert(id.clone(), sender);
        let _pending = PendingRequest { id:id.clone(), pending:link.pending.clone() };
        let mut bytes = serde_json::to_vec(&body)?; bytes.push(b'\n');
        if link.input.send(bytes).is_err() { link.pending.lock().remove(&id); return Err(AppError::msg("会话连接已断开")); }
        let timeout=if matches!(body["action"].as_str(),Some("read" | "list" | "health")) {Duration::from_secs(15)} else {Duration::from_secs(180)};
        let response = tokio::time::timeout(timeout, receiver).await;
        link.pending.lock().remove(&id);
        if response.is_ok() {link.read_timeouts.store(0, Ordering::Relaxed);}
        if response.is_err() && link.timed_out(body["action"].as_str().unwrap_or_default()) {
            let mut links=self.links.lock().await;
            if links.get(&link.machine).is_some_and(|current|current.generation==link.generation) {links.remove(&link.machine);}
        }
        let value = response.map_err(|_| AppError::msg("请求等待超时；不会自动重发消息，请先检查会话"))?.map_err(|_| AppError::msg("连接中断，操作结果未确认"))?;
        if let Some(error) = value["error"].as_str() { return Err(AppError::msg(error)); }
        let current=self.generations.lock();
        if current.get(&link.machine)!=Some(&link.generation) {return Err(AppError::msg("连接已更换，旧响应已丢弃；请先检查会话状态"));}
        let result = value["result"].clone();
        if let Some(id) = result["id"].as_str().filter(|_| result["turns"].is_array()) {
            let mut values=self.snapshots.lock();
            if !accept_snapshot(&mut values,id,&result) {return Ok(values[id].clone());}
        }
        Ok(result)
    }
    pub async fn launch(&self, id: &str, kind: &str, workspace: &QueueWorkspace, _resume: Option<HarnessSession>, _: &TerminalHub, _: &crate::settings::SettingsStore, bin: &Path, _: bool) -> AppResult<HarnessSession> {
        self.request(workspace, bin, json!({"action":"ensure","id":id,"agent":kind,"cwd":workspace.cwd,"env":workspace.session_env})).await?;
        serde_json::from_value(json!({"kind":kind,"terminalId":id,"state":"attention","version":"acpx 0.19.3","remote":workspace.kind == "ssh"})).map_err(Into::into)
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn a_slow_operation_does_not_retire_the_shared_connection() {
        let (input,_)=mpsc::unbounded_channel();
        let link=Link {generation:"one".into(),machine:"local".into(),input,pending:Default::default(),read_timeouts:Default::default()};
        for action in ["model","config","send","ensure"] {assert!(!link.timed_out(action));}
        assert!(!link.timed_out("read"));
        assert!(!link.timed_out("read"));
        // Any completed RPC proves that the transport is responsive again.
        link.read_timeouts.store(0,Ordering::Relaxed);
        assert!(!link.timed_out("read"));
        assert!(!link.timed_out("read"));
        assert!(link.timed_out("read"));
    }
    #[test]
    fn older_rpc_snapshot_cannot_overwrite_newer_event() {
        let mut values=HashMap::new();
        let current=json!({"ownerEpoch":"one","revision":8,"state":"working","turns":[{"id":"accepted"}]});
        assert!(accept_snapshot(&mut values,"card",&current));
        assert!(!accept_snapshot(&mut values,"card",&json!({"ownerEpoch":"one","revision":7,"state":"starting","turns":[]})));
        assert_eq!(values["card"],current);
        assert!(accept_snapshot(&mut values,"card",&json!({"ownerEpoch":"two","revision":0,"state":"not_running"})));
    }
    #[test]
    fn cancelled_http_request_releases_waiter() {
        let pending=Arc::new(Mutex::new(HashMap::new()));
        let (sender,_receiver)=oneshot::channel();
        pending.lock().insert("request".into(),sender);
        {let _guard=PendingRequest{id:"request".into(),pending:pending.clone()};}
        assert!(pending.lock().is_empty());
    }
    #[test]
    fn stale_disconnect_does_not_overwrite_reconnected_snapshot() {
        let generations=Mutex::new(HashMap::from([("host".into(),"new".into())]));
        let snapshots=Mutex::new(HashMap::from([("card".into(),json!({"state":"working"}))]));
        let ids=std::collections::HashSet::from(["card".into()]);
        assert!(!disconnect_snapshots(&generations,&snapshots,"host","old",&ids,"old closed"));
        assert_eq!(snapshots.lock()["card"]["state"],"working");
        assert!(disconnect_snapshots(&generations,&snapshots,"host","new",&ids,"new closed"));
        assert_eq!(snapshots.lock()["card"]["state"],"unknown");
        assert_eq!(snapshots.lock()["card"]["error"],"new closed");
        assert!(!generations.lock().contains_key("host"),"a disconnected reverse channel is no longer authorized");
    }
}
