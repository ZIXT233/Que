//! Making and archiving cards from an Agent. A card the user allowed to manage
//! cards does both directly; any other card may ask for a new card, and the
//! user decides. Either way the new card is joined to the card that asked.
use crate::{api::AppState,error::{AppError,AppResult},models::CardQueue};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
fn required<'a>(body:&'a Value,key:&str)->AppResult<&'a str>{body[key].as_str().filter(|v|!v.trim().is_empty()).ok_or_else(||AppError::msg(format!("Missing {key}")))}
fn identity(source:&str,body:&Value)->AppResult<(String,String)> {
 let request=required(body,"requestId")?;
 if request.len()>128 {return Err(AppError::msg("requestId is too long"));}
 let key=hex::encode(Sha256::digest(format!("{source}:{}:{request}",required(body,"tool")?)));
 let fingerprint=hex::encode(Sha256::digest(serde_json::to_vec(body)?));
 Ok((key,fingerprint))
}
fn created_id(key:&str)->String {let hash=Sha256::digest(key.as_bytes());let mut bytes=[0u8;16];bytes.copy_from_slice(&hash[..16]);uuid::Uuid::from_bytes(bytes).to_string()}
fn insert_card(queue:&mut CardQueue,id:&str,workspace:&str,kind:&str,nickname:Option<&str>,key:&str,fingerprint:&str)->AppResult<()> {
 if let Some(card)=queue.cards.iter().find(|c|c.id==id) {
  if card.prompt_sources.as_ref().map(|p|&p["queMcpCreate"]["fingerprint"])!=Some(&json!(fingerprint)) {return Err(AppError::msg("requestId was already used for another creation"));}
  return Ok(());
 }
 let ws=queue.workspaces.as_ref().and_then(|items|items.iter().find(|w|w.id==workspace)).ok_or_else(||AppError::msg("Workspace not found; use list_workspaces"))?;
 let ws=ws.clone();
 crate::queue::new_card(queue,id,&ws,kind,nickname)?;
 // The request that made it, so a retry finds it instead of making another.
 if let Some(card)=queue.cards.iter_mut().find(|c|c.id==id) {card.prompt_sources=Some(json!({"queMcpCreate":{"key":key,"fingerprint":fingerprint}}));}
 Ok(())
}
/// A card asked for a new card; it waits for the user.
#[derive(Clone)]
struct Request {id:String,key:String,fingerprint:String,from:String,workspace:String,kind:String,nickname:Option<String>}
static REQUESTS:tokio::sync::Mutex<Vec<Request>>=tokio::sync::Mutex::const_new(Vec::new());

/// `from` is the asking card, if a card asks; `allowed` whether it may make cards itself.
pub async fn create(state:&AppState,source:&str,from:Option<&str>,allowed:bool,body:&Value)->AppResult<Value> {
 let workspace=required(body,"workspaceId")?;let kind=required(body,"kind")?;
 let nickname=body["nickname"].as_str();
 if nickname.is_some_and(|v|v.chars().count()>48||v.chars().any(char::is_control)){return Err(AppError::msg("Invalid nickname"));}
 let (key,fingerprint)=identity(source,body)?;let id=created_id(&key);
 let queue=state.queue.read_snapshot()?;
 let ws=queue.workspaces.as_ref().and_then(|ws|ws.iter().find(|w|w.id==workspace)).ok_or_else(||AppError::msg("Workspace not found; use list_workspaces"))?;
 let ws=crate::workspace_rc::effective_workspace(&queue,ws);
 let catalog=state.harness.request(&ws,&state.bin_dir,json!({"action":"catalog"})).await?;
 if !catalog.as_array().is_some_and(|items|items.iter().any(|item|item["id"]==kind)){return Err(AppError::msg("Harness not available; use list_harnesses"));}
 // Made already (allowed earlier): a retry finds it.
 let made=queue.cards.iter().any(|c|c.id==id);
 if !allowed && !made {
  let from=from.ok_or_else(||AppError::msg("Creating cards needs a card that the user allowed to manage cards"))?;
  let mut requests=REQUESTS.lock().await;
  match requests.iter().find(|r|r.key==key) {
   Some(r) if r.fingerprint!=fingerprint=>return Err(AppError::msg("requestId was already used for another creation")),
   Some(_)=>{},
   None=>{requests.push(Request{id:id.clone(),key,fingerprint,from:from.into(),workspace:workspace.into(),kind:kind.into(),nickname:nickname.map(str::to_string)});state.live.notify("channels");},
  }
  return Ok(json!({"delivery":"waitingForUser","note":"The user is asked whether to create this card. You get a message once they decide, with its cardId if they allow it; do not ask again. Finish your turn or call wait_messages."}));
 }
 make(state,&id,workspace,kind,nickname,&key,&fingerprint,from).await
}

#[allow(clippy::too_many_arguments)]
async fn make(state:&AppState,id:&str,workspace:&str,kind:&str,nickname:Option<&str>,key:&str,fingerprint:&str,from:Option<&str>)->AppResult<Value> {
 state.queue.with_queue(false,|q|insert_card(q,id,workspace,kind,nickname,key,fingerprint)).await?;
 let queue=state.queue.read_snapshot()?;let card=queue.cards.iter().find(|c|c.id==id).unwrap();
 if card.archived_at.is_some(){return Ok(json!({"cardId":id,"delivery":"archived","note":"This creation request already produced an archived card; use a new requestId only for a new card."}));}
 // The card that asked can reach what it made.
 if let Some(from)=from { if !crate::channels::open(&queue,from,id) { crate::channels::set(state,from,id,true).await?; } }
 if !state.harness.is_live(id) {
  if let Err(e)=crate::api::launch_harness(state,&json!({"id":id}),"harness_resume").await {
   return Ok(json!({"cardId":id,"delivery":"created","state":"not_started","error":e.to_string(),"next":"Retry create_card with the same requestId and arguments; no duplicate card will be created."}));
  }
 }
 Ok(json!({"cardId":id,"delivery":"started","next":"Send the user-authorized task with send_message. The card answers with a message to you, if it answers."}))
}

/// Requests waiting for the user, oldest first.
pub async fn requests(state:&AppState)->AppResult<Value> {
 let queue=state.queue.read_snapshot()?;
 let name=|id:&str|queue.cards.iter().find(|c|c.id==id)
  .map(|c|crate::session_view::card_name(c,&state.harness.debug_snapshot(&c.id,&state.terminals))).unwrap_or_else(||id.to_string());
 let workspace=|id:&str|queue.workspaces.as_ref().and_then(|ws|ws.iter().find(|w|w.id==id)).map(|w|w.name.clone()).unwrap_or_else(||id.to_string());
 Ok(json!(REQUESTS.lock().await.iter().map(|r|json!({"id":r.id,"from":{"cardId":r.from,"name":name(&r.from)},
  "workspace":workspace(&r.workspace),"kind":r.kind,"nickname":r.nickname})).collect::<Vec<_>>()))
}

/// The user's answer; the card that asked hears it as a message.
pub async fn decide(state:&AppState,id:&str,allow:bool)->AppResult<()> {
 let request={let mut requests=REQUESTS.lock().await;
  let at=requests.iter().position(|r|r.id==id).ok_or_else(||AppError::msg("This request was already answered"))?;
  requests.remove(at)};
 state.live.notify("channels");
 let text=if allow {
  match make(state,&request.id,&request.workspace,&request.kind,request.nickname.as_deref(),&request.key,&request.fingerprint,Some(&request.from)).await {
   Ok(result) if result["delivery"]=="started"=>format!("The user allowed the card you asked for: card {id} is started and joined to you. Send it the task with send_message."),
   Ok(result)=>format!("The user allowed the card you asked for: card {id} was created but did not start ({}). Retry create_card with the same requestId and arguments to start it.",result["error"].as_str().unwrap_or("unknown error")),
   Err(error)=>format!("The user allowed the card you asked for, but it could not be created: {error}"),
  }
 } else {
  "The user did not allow the card you asked for; it was not created. Do not ask again unless the user asks.".to_string()
 };
 crate::inbox::post(crate::inbox::Letter{id:uuid::Uuid::new_v4().to_string(),to:request.from,held:false,
  from:json!({"cardId":"","name":"Que"}),at:crate::queue::now_ms(),text}).await
}
pub async fn archive(state:&AppState,source:&str,body:&Value)->AppResult<Value> {
 let id=required(body,"cardId")?;let(key,fingerprint)=identity(source,body)?;
 if id==source {return Err(AppError::msg("Cannot archive the calling card itself"));}
 let _lifecycle_guard=crate::api::try_acquire_launch(state,id)?;
 let queue=state.queue.read_snapshot()?;
 let card=queue.cards.iter().find(|c|c.id==id).ok_or_else(||AppError::msg("Card not found"))?;
 if let Some(prior)=card.prompt_sources.as_ref().and_then(|p|p["queMcpArchives"].get(&key)) {
  if prior!=&json!(fingerprint){return Err(AppError::msg("requestId conflict"));}
  return Ok(json!({"cardId":id,"delivery":"archived","replayed":true}));
 }
 if card.detached.is_some(){return Err(AppError::msg("请先收回独立窗口中的卡片"));}
 if card.archived_at.is_none() && card.harness.is_some() {
  let ws=crate::api::acp_workspace(state,id).await?;
  // Owner closes only idle sessions and refuses running/queued turns atomically.
  state.harness.request(&ws,&state.bin_dir,json!({"action":"close","id":id})).await?;
 }
 state.queue.with_queue(false,|q| {
  let card=q.cards.iter_mut().find(|c|c.id==id).ok_or_else(||AppError::msg("Card not found"))?;
  if card.detached.is_some() || state.harness.is_live(id){return Err(AppError::msg("卡片状态已改变，请重试"));}
  card.phase=crate::models::CardPhase::Attention;
  if let Some(h)=card.harness.as_mut(){h.state="not_running".into();}
  crate::queue::archive_card(q,id)?;
  let card=q.cards.iter_mut().find(|c|c.id==id).unwrap();
  let meta=card.prompt_sources.get_or_insert_with(||json!({}));
  if !meta["queMcpArchives"].is_object(){meta["queMcpArchives"]=json!({});}
  meta["queMcpArchives"][&key]=json!(fingerprint);Ok(())
 }).await?;
 Ok(json!({"cardId":id,"delivery":"archived","historyPreserved":true}))
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn creation_is_durable_and_does_not_reuse_draft(){
  let mut q=CardQueue::empty();let cwd="/tmp/que-card-test";
  q.workspaces=Some(vec![serde_json::from_value(json!({"id":"ws","name":"test","kind":"local","cwd":cwd,"runtimeCwd":cwd})).unwrap()]);
  q.cards.push(serde_json::from_value(json!({"id":"draft","cwd":cwd,"phase":"draft","createdAt":1})).unwrap());
  insert_card(&mut q,"new","ws","codex",None,"key","fp").unwrap();
  let mut q:CardQueue=serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
  insert_card(&mut q,"new","ws","codex",None,"key","fp").unwrap();
  assert!(insert_card(&mut q,"new","ws","claude",None,"key","other").is_err());
  assert_eq!(q.cards.len(),2);assert!(q.order.contains(&"new".to_string()));
  assert!(insert_card(&mut q,"bad","missing","codex",None,"key","fp").is_err());
 }
 #[test] fn requests_are_scoped_to_source(){let b=json!({"tool":"create_card","requestId":"one"});assert_ne!(identity("a",&b).unwrap().0,identity("b",&b).unwrap().0);}
}
