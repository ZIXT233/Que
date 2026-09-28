//! Independent dictation service. Credentials and audio never enter ACP sessions.
use crate::error::{AppError, AppResult};
use axum::Json;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, time::Duration};
static SETTINGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_BASE64: usize = 10_000_000;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings { api_key: String, language: String }
fn read_settings() -> AppResult<Settings> {
    match std::fs::read(crate::paths::data_dir().join("speech.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}
fn public_settings(settings: &Settings) -> Value {
    json!({"configured": !settings.api_key.is_empty(), "language": if settings.language.is_empty() { "auto" } else { &settings.language }})
}
pub async fn settings() -> AppResult<Json<Value>> { Ok(Json(public_settings(&read_settings()?))) }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate { api_key: Option<String>, language: Option<String> }
pub async fn save_settings(Json(update): Json<SettingsUpdate>) -> AppResult<Json<Value>> {
    let _guard = SETTINGS_LOCK.lock().await;
    if update.language.as_deref().is_some_and(|language|!["auto", "zh", "en"].contains(&language)) { return Err(AppError::msg("speech.invalidLanguage")); }
    let mut settings = read_settings()?;
    if let Some(key) = update.api_key {
        let key = key.trim();
        if key.len() > 4096 || key.contains(['\r', '\n']) { return Err(AppError::msg("speech.invalidKey")); }
        settings.api_key = key.to_owned();
    }
    if let Some(language)=update.language {settings.language=language;}
    let dir = crate::paths::data_dir();
    std::fs::create_dir_all(&dir)?;
    // NamedTempFile is owner-only on Unix, including before the atomic rename.
    let mut file = tempfile::NamedTempFile::new_in(&dir)?;
    file.write_all(&serde_json::to_vec(&settings)?)?;
    file.persist(dir.join("speech.json")).map_err(|e| AppError::msg(e.error.to_string()))?;
    Ok(Json(public_settings(&settings)))
}
#[derive(Deserialize)]
pub struct Recording { audio: String }
fn payload(audio: &str, language: &str) -> AppResult<Value> {
    if audio.len() > MAX_BASE64 { return Err(AppError::msg("speech.tooLarge")); }
    let bytes = STANDARD.decode(audio).map_err(|_| AppError::msg("speech.invalidAudio"))?;
    if bytes.len() < 46 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" { return Err(AppError::msg("speech.invalidAudio")); }
    Ok(json!({"model":"mimo-v2.5-asr", "stream":false,
        "messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":format!("data:audio/wav;base64,{audio}")}}]}],
        "asr_options":{"language":if language.is_empty(){"auto"}else{language}}}))
}
fn transcript(value: &Value) -> AppResult<String> {
    value.pointer("/choices/0/message/content").and_then(Value::as_str)
        .map(str::trim).filter(|v| !v.is_empty()).map(str::to_owned)
        .ok_or_else(|| AppError::msg("speech.empty"))
}
pub async fn transcribe(Json(recording): Json<Recording>) -> AppResult<Json<Value>> {
    let settings = read_settings()?;
    if settings.api_key.is_empty() { return Err(AppError::msg("speech.notConfigured")); }
    let body = payload(&recording.audio, &settings.language)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| AppError::msg("speech.network"))?;
    let response = client.post("https://api.xiaomimimo.com/v1/chat/completions")
        .bearer_auth(settings.api_key).json(&body).send().await
        .map_err(|e| AppError::msg(if e.is_timeout(){"speech.timeout"}else{"speech.network"}))?;
    if !response.status().is_success() {
        return Err(AppError::msg(match response.status().as_u16() {
            401 | 403 => "speech.unauthorized", 429 => "speech.rateLimited", _ => "speech.upstream",
        }));
    }
    let value: Value = response.json().await.map_err(|_| AppError::msg("speech.upstream"))?;
    Ok(Json(json!({"text":transcript(&value)?})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn mimo_contract_and_limits() {
        let mut wav = vec![0; 46]; wav[..4].copy_from_slice(b"RIFF"); wav[8..12].copy_from_slice(b"WAVE");
        let body = payload(&STANDARD.encode(wav), "zh").unwrap();
        assert_eq!(body["model"], "mimo-v2.5-asr");
        assert_eq!(body["asr_options"]["language"], "zh");
        assert!(body["messages"][0]["content"][0]["input_audio"]["data"].as_str().unwrap().starts_with("data:audio/wav;base64,"));
        assert!(payload("not audio", "auto").is_err());
        assert!(payload(&"A".repeat(MAX_BASE64+1), "auto").is_err());
        assert_eq!(transcript(&json!({"choices":[{"message":{"content":" 你好 "}}]})).unwrap(), "你好");
        assert!(transcript(&json!({"choices":[]})).is_err());
        assert!(public_settings(&Settings{api_key:"secret".into(),language:"auto".into()}).get("apiKey").is_none());
    }
}
