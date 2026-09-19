#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionLabel {
    pub name: Option<String>,
    pub first_prompt: Option<String>,
}

pub fn clip(value: &str) -> Option<String> {
    let text = value
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let text = text.trim();
    if text.is_empty() || is_noise(text) {
        return None;
    }
    Some(text.chars().take(160).collect())
}

pub fn is_noise(text: &str) -> bool {
    let start = text.trim_start();
    start.starts_with("<environment_context")
        || start.starts_with("<command-name>")
        || start.starts_with("<local-command")
        || start.starts_with("<system-reminder>")
        || start.starts_with("<user_info>")
}

pub fn json_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => clip(text),
        serde_json::Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()).and_then(clip) {
                    parts.push(text);
                } else if let Some(text) = json_text(item) {
                    parts.push(text);
                }
            }
            if parts.is_empty() {
                None
            } else {
                clip(&parts.join(" "))
            }
        }
        serde_json::Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(clip)
            .or_else(|| map.get("content").and_then(json_text))
            .or_else(|| map.get("prompt").and_then(json_text)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_and_drops_noise() {
        assert_eq!(clip("  hello  ").as_deref(), Some("hello"));
        assert_eq!(clip("<environment_context>\ncwd"), None);
        assert_eq!(clip("<command-name>/clear</command-name>"), None);
    }
}
