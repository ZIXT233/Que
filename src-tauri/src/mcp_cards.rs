//! Card lifecycle operations shared by MCP agents with all-card access.
use crate::{api::AppState,error::{AppError,AppResult},models::{CardQueue,QueueCard}};
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
  if card.prompt_sources.as_ref().map(|p|&p["flatMcpCreate"]["fingerprint"])!=Some(&json!(fingerprint)) {return Err(AppError::msg("requestId was already used for another creation"));}
  return Ok(());
 }
 let ws=queue.workspaces.as_ref().and_then(|items|items.iter().find(|w|w.id==workspace)).ok_or_else(||AppError::msg("Workspace not found; use list_workspaces"))?;
 let card:QueueCard=serde_json::from_value(json!({"id":id,"cwd":ws.runtime_cwd,"workspaceId":ws.id,"nickname":nickname,"phase":"attention","createdAt":crate::queue::now_ms(),"harness":{"kind":kind,"terminalId":id,"state":"not_running","remote":ws.kind=="ssh"},"promptSources":{"flatMcpCreate":{"key":key,"fingerprint":fingerprint}}}))?;
 queue.cards.push(card);queue.order.push(id.into());Ok(())
}
pub async fn create(state:&AppState,source:&str,body:&Value)->AppResult<Value> {
 let workspace=required(body,"workspaceId")?;let kind=required(body,"kind")?;
 let nickname=body["nickname"].as_str();
 if nickname.is_some_and(|v|v.chars().count()>48||v.chars().any(char::is_control)){return Err(AppError::msg("Invalid nickname"));}
 let (key,fingerprint)=identity(source,body)?;let id=created_id(&key);
 let queue=state.queue.read_snapshot()?;
 let ws=queue.workspaces.as_ref().and_then(|ws|ws.iter().find(|w|w.id==workspace)).ok_or_else(||AppError::msg("Workspace not found; use list_workspaces"))?;
 let ws=crate::workspace_rc::effective_workspace(&queue,ws);
 let catalog=state.harness.request(&ws,&state.bin_dir,json!({"action":"catalog"})).await?;
 if !catalog.as_array().is_some_and(|items|items.iter().any(|item|item["id"]==kind)){return Err(AppError::msg("Harness not available; use list_harnesses"));}
 state.queue.with_queue(false,|q|insert_card(q,&id,workspace,kind,nickname,&key,&fingerprint)).await?;
 let queue=state.queue.read_snapshot()?;let card=queue.cards.iter().find(|c|c.id==id).unwrap();
 if card.archived_at.is_some(){return Ok(json!({"cardId":id,"sessionId":id,"delivery":"archived","note":"This creation request already produced an archived card; use a new requestId only for a new card."}));}
 if !state.harness.is_live(&id) {
  if let Err(e)=crate::api::launch_harness(state,&json!({"id":id}),"harness_resume").await {
   return Ok(json!({"cardId":id,"sessionId":id,"delivery":"created","state":"not_started","error":e.to_string(),"next":"Retry create_card with the same requestId and arguments; no duplicate card will be created."}));
  }
 }
 Ok(json!({"cardId":id,"sessionId":id,"delivery":"started","next":"Use send_message for the user-authorized task, then get_turn_status to verify completion."}))
}
pub async fn archive(state:&AppState,source:&str,body:&Value)->AppResult<Value> {
 let id=required(body,"cardId")?;let(key,fingerprint)=identity(source,body)?;
 if id==source {return Err(AppError::msg("Cannot archive the calling card itself"));}
 let _lifecycle_guard=crate::api::try_acquire_launch(state,id)?;
 let queue=state.queue.read_snapshot()?;
 let card=queue.cards.iter().find(|c|c.id==id).ok_or_else(||AppError::msg("Card not found"))?;
 if let Some(prior)=card.prompt_sources.as_ref().and_then(|p|p["flatMcpArchives"].get(&key)) {
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
  if !meta["flatMcpArchives"].is_object(){meta["flatMcpArchives"]=json!({});}
  meta["flatMcpArchives"][&key]=json!(fingerprint);Ok(())
 }).await?;
 Ok(json!({"cardId":id,"delivery":"archived","historyPreserved":true}))
}
#[cfg(test)] mod tests {
 use super::*;
 #[test] fn creation_is_durable_and_does_not_reuse_draft(){
  let mut q=CardQueue::empty();let cwd="/tmp/flat-card-test";
  q.workspaces=Some(vec![serde_json::from_value(json!({"id":"ws","name":"test","kind":"local","cwd":cwd,"runtimeCwd":cwd})).unwrap()]);
  q.cards.push(serde_json::from_value(json!({"id":"draft","cwd":cwd,"phase":"draft","createdAt":1})).unwrap());
  insert_card(&mut q,"new","ws","codex",None,"key","fp").unwrap();
  let mut q:CardQueue=serde_json::from_str(&serde_json::to_string(&q).unwrap()).unwrap();
  insert_card(&mut q,"new","ws","codex",None,"key","fp").unwrap();
  assert!(insert_card(&mut q,"new","ws","claude",None,"key","other").is_err());
  crate::queue::pin_draft(&mut q);assert_eq!(q.cards.len(),2);assert!(q.order.contains(&"new".to_string()));
  assert!(insert_card(&mut q,"bad","missing","codex",None,"key","fp").is_err());
 }
 #[test] fn requests_are_scoped_to_source(){let b=json!({"tool":"create_card","requestId":"one"});assert_ne!(identity("a",&b).unwrap().0,identity("b",&b).unwrap().0);}
}
