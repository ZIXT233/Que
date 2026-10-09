use crate::{error::AppResult, models::{CardQueue, QueueCard, QueueWorkspace}};
use serde_json::json;
pub const WORKSPACE_ID:&str="queacp-butler";
pub fn root()->std::path::PathBuf {crate::paths::user_home().unwrap_or_default().join(".queacp/butler")}
pub fn install()->AppResult<()> {
 install_at(&root())
}
fn install_at(root:&std::path::Path)->AppResult<()> {
 std::fs::create_dir_all(root.join("notes"))?;
 for (name,content) in [("ROLE.md",include_str!("../../resources/butler/ROLE.md")),("AGENTS.md",include_str!("../../resources/butler/AGENTS.md"))] {
  if std::fs::read_to_string(root.join(name)).ok().as_deref()!=Some(content) {crate::paths::atomic_write(&root.join(name),content)?;}
 }
 use std::io::Write;
 for (name,content) in [("USER.md","# 用户偏好\n\n只记录用户明确表达的偏好和授权。\n"),("MEMORY.md","# 长期记忆\n\n记录日期、来源和已确认事实；细节索引到 notes/。\n"),("STATE.md","# 当前事项\n\n尚无已确认事项。使用 QueACP MCP 查询实时状态。\n")] {
  match std::fs::OpenOptions::new().write(true).create_new(true).open(root.join(name)) {Ok(mut f)=>f.write_all(content.as_bytes())?,Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>{},Err(e)=>return Err(e.into())}
 }
 Ok(())
}
/// A Butler card is any card in the Butler workspace. Like every card it is one
/// session: when that is done or broken it is archived and a new Butler card made.
pub fn is_card(card:&QueueCard)->bool {card.workspace_id.as_deref()==Some(WORKSPACE_ID) && std::path::Path::new(&card.cwd)==root()}
/// Returns the active Butler card, creating one when there is none.
pub fn ensure(queue:&mut CardQueue)->AppResult<String> {
 let cwd=root().to_string_lossy().into_owned();
 let workspaces=queue.workspaces.get_or_insert_with(Vec::new);
 if !workspaces.iter().any(|w|w.id==WORKSPACE_ID) {workspaces.push(QueueWorkspace{id:WORKSPACE_ID.into(),name:"Butler".into(),kind:"local".into(),cwd:cwd.clone(),runtime_cwd:cwd.clone(),ssh_host:None,terminal_rc:None,session_env:Default::default(),default_conversation_weight:None});}
 if let Some(card)=queue.cards.iter().find(|c|is_card(c) && c.archived_at.is_none()) {return Ok(card.id.clone());}
 let id=uuid::Uuid::new_v4().to_string();
 queue.cards.push(serde_json::from_value(json!({"id":id,"workspaceId":WORKSPACE_ID,"cwd":cwd,"nickname":"Butler","phase":"draft","createdAt":crate::queue::now_ms()}))?);
 queue.order.insert(0,id.clone());
 Ok(id)
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn installation_preserves_user_memory() {
  let dir=std::env::temp_dir().join(format!("queacp-butler-{}",uuid::Uuid::new_v4()));
  install_at(&dir).unwrap();
  std::fs::write(dir.join("MEMORY.md"),"user memory").unwrap();
  std::fs::write(dir.join("ROLE.md"),"old version").unwrap();
  install_at(&dir).unwrap();
  assert_eq!(std::fs::read_to_string(dir.join("MEMORY.md")).unwrap(),"user memory");
  assert!(std::fs::read_to_string(dir.join("ROLE.md")).unwrap().contains("QueACP MCP"));
  std::fs::remove_dir_all(dir).unwrap();
 }
 #[test] fn one_active_butler_card_and_a_new_one_after_archiving() {
  let mut q:CardQueue=crate::models::CardQueue::empty();
  let first=ensure(&mut q).unwrap();assert_eq!(ensure(&mut q).unwrap(),first);
  assert_eq!(q.cards.len(),1);assert_eq!(q.workspaces.as_ref().unwrap().len(),1);
  assert!(is_card(&q.cards[0]));
  // A card is one session: an archived Butler stays archived; the next one is new.
  q.cards[0].archived_at=Some(1);
  let second=ensure(&mut q).unwrap();
  assert_ne!(second,first);assert_eq!(q.cards.len(),2);assert!(q.cards[0].archived_at.is_some());
  q.cards[1].cwd="/tmp".into();assert!(!is_card(&q.cards[1]));
 }
}
