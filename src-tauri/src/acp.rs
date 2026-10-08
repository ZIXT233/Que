use crate::{error::{AppError, AppResult}, live::LiveBus, models::{HarnessSession, QueueWorkspace}, terminal::TerminalHub};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::{Arc, atomic::{AtomicU8, Ordering}}, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, sync::{broadcast, mpsc, oneshot, watch}};

fn is_stale_snapshot(values: &HashMap<String, Value>, id: &str, next: &Value) -> bool {
    values.get(id).is_some_and(|previous| next["ownerEpoch"].is_string() && next["ownerEpoch"] == previous["ownerEpoch"]
        && matches!((next["revision"].as_u64(), previous["revision"].as_u64()), (Some(a), Some(b)) if a < b))
}
// Snapshots carry the whole conversation, so move them into the cache.
fn accept_snapshot(values: &mut HashMap<String, Value>, id: &str, next: Value) -> bool {
    if is_stale_snapshot(values, id, &next) { return false; }
    values.insert(id.into(), next);
    true
}

#[derive(Debug, PartialEq)]
pub(crate) enum DeltaOutcome { Applied, Stale, Gap }

/// Apply an owner `delta` (see runtime/session-wire.mjs) to a cached session.
/// `Stale` means the snapshot already includes it; `Gap` means it cannot be applied
/// and a full snapshot must be requested. A rejected delta never changes the cache:
/// ops run on copies of the touched turns, which replace the originals only on success.
/// tests/acp/delta-vectors.json pins this to the UI applier in src/lib/acp-delta.ts.
pub(crate) fn apply_delta(snapshot: &mut Value, delta: &Value) -> DeltaOutcome {
    use DeltaOutcome::*;
    let Some(revision) = snapshot["revision"].as_u64() else { return Gap };
    if !snapshot["ownerEpoch"].is_string() || snapshot["ownerEpoch"] != delta["epoch"] { return Gap; }
    let (Some(base), Some(rev), Some(ops)) = (delta["base"].as_u64(), delta["rev"].as_u64(), delta["ops"].as_array()) else { return Gap };
    if rev <= revision { return Stale; }
    if base != revision { return Gap; }
    let Some(turns) = snapshot["turns"].as_array() else { return Gap };
    let mut touched: HashMap<String, Value> = HashMap::new();
    let mut sets: Vec<(&str, &Value)> = Vec::new();
    for op in ops {
        let kind = op["op"].as_str();
        if kind == Some("set") {
            match op["key"].as_str() { Some(key @ ("context" | "commands")) => sets.push((key, &op["value"])), _ => return Gap }
            continue;
        }
        if !matches!(kind, Some("append" | "block")) { return Gap; }
        let (Some(turn_id), Some(index)) = (op["turn"].as_str(), op["block"].as_u64().map(|v| v as usize)) else { return Gap };
        if !touched.contains_key(turn_id) {
            let Some(turn) = turns.iter().find(|turn| turn["id"] == turn_id) else { return Gap };
            touched.insert(turn_id.to_string(), turn.clone());
        }
        let Some(blocks) = touched.get_mut(turn_id).and_then(|turn| turn["blocks"].as_array_mut()) else { return Gap };
        if kind == Some("block") {
            if index > blocks.len() { return Gap; }
            if index == blocks.len() { blocks.push(op["value"].clone()); } else { blocks[index] = op["value"].clone(); }
        } else {
            let (Some(text), Some(Value::String(current))) = (op["text"].as_str(), blocks.get_mut(index).map(|block| &mut block["text"])) else { return Gap };
            current.push_str(text);
        }
    }
    let sets: Vec<(String, Value)> = sets.into_iter().map(|(key, value)| (key.to_string(), value.clone())).collect();
    if let Some(turns) = snapshot["turns"].as_array_mut() {
        for turn in turns.iter_mut() {
            if let Some(updated) = turn["id"].as_str().and_then(|id| touched.remove(id)) { *turn = updated; }
        }
    }
    for (key, value) in sets { snapshot[key.as_str()] = value; }
    snapshot["revision"] = json!(rev);
    Applied
}

fn publish_snapshot(updates: &broadcast::Sender<AcpUpdate>, id: &str, snapshot: &Value) {
    if updates.receiver_count() > 0 { let _ = updates.send(AcpUpdate{id:id.into(),event:"snapshot",data:snapshot.to_string()}); }
}

/// A change to a cached session, as sent to UI subscribers (`snapshot` or `delta`).
#[derive(Clone, Debug)]
pub struct AcpUpdate { pub id: String, pub event: &'static str, pub data: String }

/// Take the next newline-terminated JSON line from `buffer`. A snapshot line can
/// span many reads, so `scanned` remembers where the search for its end resumes.
fn take_line(buffer: &mut Vec<u8>, scanned: &mut usize) -> Option<serde_json::Result<Value>> {
    let Some(offset) = buffer[*scanned..].iter().position(|b| *b == b'\n') else {
        *scanned = buffer.len();
        return None;
    };
    let end = *scanned + offset;
    let parsed = serde_json::from_slice(&buffer[..end]);
    buffer.drain(..=end);
    *scanned = 0;
    Some(parsed)
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
struct Link { generation: String, machine: String, input: mpsc::UnboundedSender<Vec<u8>>, pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>, read_timeouts: Arc<AtomicU8>,
    // The owner is this link's child: stopping closes its stdin, and `exited`
    // flips once it (and therefore its agents) are gone.
    stop: Arc<watch::Sender<bool>>, exited: watch::Receiver<bool> }
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
    updates: broadcast::Sender<AcpUpdate>,
    remote_mcp: Arc<Mutex<Option<mpsc::Sender<RemoteMcpRequest>>>>,
}
impl AcpRuntime {
    pub fn new(live: LiveBus) -> Self { Self { snapshots: Default::default(), generations:Default::default(), links: Default::default(), connecting:Default::default(), remote_mcp:Default::default(), updates: broadcast::channel(512).0, live } }
    /// Every change to any cached session, in order. A lagged receiver must resend a snapshot.
    pub fn updates(&self) -> broadcast::Receiver<AcpUpdate> { self.updates.subscribe() }
    pub fn cached(&self, id: &str) -> Option<Value> { self.snapshots.lock().get(id).cloned() }
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
    /// Stops every owner and waits (bounded) for them and their agents to exit.
    /// Nothing an owner started may outlive the app.
    pub async fn shutdown(&self) {
        let links: Vec<Link> = self.links.lock().await.drain().map(|(_, link)| link).collect();
        self.generations.lock().clear();
        let waits = links.into_iter().map(|link| {
            let _ = link.stop.send(true);
            let mut exited = link.exited;
            async move { let _ = exited.wait_for(|exited| *exited).await; }
        });
        let _ = tokio::time::timeout(Duration::from_secs(8), futures::future::join_all(waits)).await;
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
        let (stop, mut stopped) = watch::channel(false);
        let (exited_tx, exited) = watch::channel(false);
        // Owner stdin closes on stop even while other clones of `input` live on.
        let (owner_input, mut owner_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            loop { tokio::select! {
                _ = stopped.wait_for(|stop| *stop) => break,
                data = rx.recv() => match data { Some(data) => if owner_input.send(data).is_err() { break }, None => break },
            }}
        });
        let bundle = bin.join("flat-acp.mjs");
        if let Some(host) = &workspace.ssh_host {
            use sha2::{Digest, Sha256};
            let bytes = tokio::fs::read(&bundle).await?;
            let hash = hex::encode(Sha256::digest(&bytes));
            let remote = format!("$HOME/.flat/runtime/{hash}.mjs");
            let install = format!("umask 077; mkdir -p \"$HOME/.flat/runtime\"; cat > \"{remote}.tmp\" && mv \"{remote}.tmp\" \"{remote}\"");
            tokio::time::timeout(Duration::from_secs(15),crate::ssh::ssh_exec_stdin(host, &install, &bytes)).await.map_err(|_|AppError::msg("远程连接超时，请重试"))??;
            // The remote owner lives in tmux and outlives this connection; see the script.
            let command = crate::ssh::ssh_login_command(&include_str!("../../resources/remote-owner.sh").replace("@BUNDLE@", &remote));
            let host = host.clone();
            tokio::spawn(async move {
                let errors=output.clone();
                if let Err(error)=crate::remote::acp_channel(&host,&command,owner_rx,output).await {
                    let _=errors.send(format!("{}\n",json!({"transportError":error.to_string()})).into_bytes());
                }
                let _=exited_tx.send(true);
            });
        } else {
            let env = crate::harness::local_environment(false).await?;
            let node = which::which_in("node", env.get("PATH"), ".").map_err(|_| AppError::msg("需要 Node.js 22.13 或更新版本"))?;
            use crate::winproc::NoWindow;
            let mut child = tokio::process::Command::new(node).no_window().arg(&bundle).envs(env).env("FLAT_ACP_ROOT", crate::paths::data_dir().join("acp"))
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
                    data = owner_rx.recv() => match data { Some(data) => if stdin.write_all(&data).await.is_err() { break; }, None => break },
                    size = stdout.read(&mut buffer) => match size { Ok(n) if n > 0 => { if output.send(buffer[..n].to_vec()).is_err() { break; } }, _ => break }
                }}
                // EOF asks the owner to stop its agents; one that hangs is killed.
                drop(stdin);
                let drain = async { while matches!(stdout.read(&mut buffer).await, Ok(n) if n > 0) {} };
                if tokio::time::timeout(Duration::from_secs(6), async { drain.await; child.wait().await }).await.is_err() { let _ = child.kill().await; }
                let _ = exited_tx.send(true);
            });
        }
        let pending = Arc::new(Mutex::new(HashMap::<String, oneshot::Sender<Value>>::new()));
        let generation=uuid::Uuid::new_v4().to_string();
        self.generations.lock().insert(machine.clone(),generation.clone());
        let link = Link { generation:generation.clone(),machine:machine.clone(),input, pending: pending.clone(),read_timeouts:Arc::new(AtomicU8::new(0)), stop:Arc::new(stop), exited };
        self.links.lock().await.insert(machine.clone(), link.clone());
        if workspace.kind=="ssh" {
            if let Some(sender)=self.remote_mcp.lock().as_ref() {
                let _=sender.try_send(RemoteMcpRequest{machine:machine.clone(),generation:generation.clone(),message:json!({"event":"mcp_connect"}),reply:link.input.clone()});
            }
        }
        let snapshots = self.snapshots.clone(); let live = self.live.clone(); let generations=self.generations.clone(); let updates=self.updates.clone();
        let remote_mcp=self.remote_mcp.clone();let reverse_input=link.input.clone();let is_remote=workspace.kind=="ssh";
        tokio::spawn(async move {
            let mut transport_error="连接已断开，执行结果尚未确认".to_string();
            let mut buffer = Vec::new();
            let mut scanned = 0;
            let mut seen = std::collections::HashSet::new();
            while let Some(bytes) = out.recv().await {
                buffer.extend(bytes);
                while let Some(parsed) = take_line(&mut buffer, &mut scanned) {
                    if let Ok(mut value) = parsed {
                        if let Some(error)=value["transportError"].as_str() {transport_error=error.to_string();continue;}
                        let current=generations.lock();
                        if current.get(&machine)!=Some(&generation) {continue;}
                        if let Some(id) = value["id"].as_str().filter(|_| value["event"] == "snapshot").map(str::to_string) {
                            let snapshot = value["snapshot"].take();
                            let mut cache = snapshots.lock();
                            if accept_snapshot(&mut cache,&id,snapshot) {
                                publish_snapshot(&updates,&id,&cache[&id]);
                                live.notify("acp");
                            }
                            seen.insert(id);
                        } else if let Some(id) = value["id"].as_str().filter(|_| value["event"] == "delta").map(str::to_string) {
                            // Streaming text changes no queue state, so deltas do not wake the queue.
                            let outcome = snapshots.lock().get_mut(&id).map_or(DeltaOutcome::Gap, |cache| apply_delta(cache,&value));
                            match outcome {
                                DeltaOutcome::Applied => if updates.receiver_count() > 0 { let _ = updates.send(AcpUpdate{id:id.clone(),event:"delta",data:value.to_string()}); },
                                DeltaOutcome::Stale => {}
                                DeltaOutcome::Gap => { let _ = reverse_input.send(format!("{}\n",json!({"action":"resync","id":id})).into_bytes()); }
                            }
                            seen.insert(id);
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
            { let cache = snapshots.lock(); for id in &seen { if let Some(snapshot) = cache.get(id) { publish_snapshot(&updates,id,snapshot); } } }
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
            if links.get(&link.machine).is_some_and(|current|current.generation==link.generation) {
                // An unresponsive owner still holds its data; stop it so a fresh one can start.
                if let Some(stale)=links.remove(&link.machine) { let _=stale.stop.send(true); }
            }
        }
        let mut value = match response {
            Ok(value) => value.map_err(|_| AppError::msg("连接中断，操作结果未确认"))?,
            Err(_) => {
                // Name the step that hung; "timed out" alone gives the user nothing to act on.
                let stage = body["id"].as_str().and_then(|id| self.snapshots.lock().get(id).and_then(|s| s["stage"].as_str().map(str::to_string)));
                let step = match stage.as_deref() {
                    Some("installing") => "，卡在下载 Agent 适配器（npx），请检查网络或预先全局安装该适配器",
                    Some("spawning") => "，卡在启动 Agent 进程",
                    Some("connecting") => "，Agent 已启动但没有完成连接，可能需要先在终端里登录该 CLI",
                    Some("preparing") => "，卡在准备 Agent 环境（工作区启动脚本）",
                    _ => "",
                };
                return Err(AppError::msg(format!("请求等待超时{step}；不会自动重发消息，请先检查会话")));
            }
        };
        if let Some(error) = value["error"].as_str() { return Err(AppError::msg(error)); }
        let current=self.generations.lock();
        if current.get(&link.machine)!=Some(&link.generation) {return Err(AppError::msg("连接已更换，旧响应已丢弃；请先检查会话状态"));}
        let result = value["result"].take();
        if let Some(id) = result["id"].as_str().filter(|_| result["turns"].is_array()) {
            let mut values=self.snapshots.lock();
            if is_stale_snapshot(&values,id,&result) {return Ok(values[id].clone());}
            values.insert(id.into(),result.clone());
        }
        Ok(result)
    }
    pub async fn launch(&self, id: &str, kind: &str, workspace: &QueueWorkspace, resume: Option<HarnessSession>, _: &TerminalHub, _: &crate::settings::SettingsStore, bin: &Path, _: bool) -> AppResult<HarnessSession> {
        let host_access = resume.as_ref().and_then(|h| h.host_access);
        self.request(workspace, bin, json!({"action":"ensure","id":id,"agent":kind,"cwd":workspace.cwd,"env":workspace.session_env,"hostAccess":host_access})).await?;
        serde_json::from_value(json!({"kind":kind,"terminalId":id,"state":"attention","version":"acpx 0.19.3","remote":workspace.kind == "ssh"})).map_err(Into::into)
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn a_slow_operation_does_not_retire_the_shared_connection() {
        let (input,_)=mpsc::unbounded_channel();
        let (stop,_)=watch::channel(false);let (_,exited)=watch::channel(false);
        let link=Link {generation:"one".into(),machine:"local".into(),input,pending:Default::default(),read_timeouts:Default::default(),stop:Arc::new(stop),exited};
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
        assert!(accept_snapshot(&mut values,"card",current.clone()));
        assert!(!accept_snapshot(&mut values,"card",json!({"ownerEpoch":"one","revision":7,"state":"starting","turns":[]})));
        assert_eq!(values["card"],current);
        assert!(accept_snapshot(&mut values,"card",json!({"ownerEpoch":"two","revision":0,"state":"not_running"})));
    }
    #[test]
    fn delta_vectors_match_the_ui_applier() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!("../../tests/acp/delta-vectors.json")).unwrap();
        assert!(vectors.len() > 10);
        for vector in vectors {
            let mut snapshot = vector["before"].clone();
            let outcome = apply_delta(&mut snapshot, &vector["delta"]);
            match vector["after"].as_str() {
                Some("stale") => assert_eq!(outcome, DeltaOutcome::Stale, "{}", vector["name"]),
                Some("gap") => assert_eq!(outcome, DeltaOutcome::Gap, "{}", vector["name"]),
                _ => { assert_eq!(outcome, DeltaOutcome::Applied, "{}", vector["name"]); assert_eq!(snapshot, vector["after"], "{}", vector["name"]); continue; }
            }
            assert_eq!(snapshot, vector["before"], "{}: a rejected delta leaves the cache untouched", vector["name"]);
        }
    }
    #[test]
    fn a_delta_that_fails_midway_changes_nothing() {
        let before = json!({"ownerEpoch":"e","revision":1,"turns":[{"id":"t","blocks":[{"type":"text_delta","text":"ab"}]}]});
        let mut snapshot = before.clone();
        let delta = json!({"epoch":"e","base":1,"rev":2,"ops":[{"op":"append","turn":"t","block":0,"text":"cd"},{"op":"append","turn":"t","block":5,"text":"!"}]});
        assert_eq!(apply_delta(&mut snapshot, &delta), DeltaOutcome::Gap);
        assert_eq!(snapshot, before, "the first op must not leak when a later op is rejected");
    }
    #[test]
    fn lines_are_reassembled_across_reads_without_rescanning() {
        let (mut buffer, mut scanned) = (Vec::new(), 0);
        let line = format!("{}\n", json!({"id":"card","snapshot":{"turns":["x".repeat(5000)]}}));
        let (head, tail) = line.as_bytes().split_at(3000);
        buffer.extend_from_slice(head);
        assert!(take_line(&mut buffer, &mut scanned).is_none());
        assert_eq!(scanned, 3000, "bytes already searched are not searched again");
        buffer.extend_from_slice(tail);
        let parsed = take_line(&mut buffer, &mut scanned).expect("complete line").expect("valid JSON");
        assert_eq!(parsed["snapshot"]["turns"][0].as_str().map(str::len), Some(5000));
        assert!(buffer.is_empty() && scanned == 0);
        assert!(take_line(&mut buffer, &mut scanned).is_none());
    }
    #[test]
    fn several_lines_in_one_read_and_a_bad_line_do_not_stall_the_stream() {
        let (mut buffer, mut scanned) = (b"{\"a\":1}\nnot json\n{\"b\":2}\n{\"c\"".to_vec(), 0);
        assert_eq!(take_line(&mut buffer, &mut scanned).unwrap().unwrap()["a"], 1);
        assert!(take_line(&mut buffer, &mut scanned).unwrap().is_err(), "a corrupt line is skipped, not fatal");
        assert_eq!(take_line(&mut buffer, &mut scanned).unwrap().unwrap()["b"], 2);
        assert!(take_line(&mut buffer, &mut scanned).is_none());
        buffer.extend_from_slice(b":3}\n");
        assert_eq!(take_line(&mut buffer, &mut scanned).unwrap().unwrap()["c"], 3);
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
