use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("{code}")]
    Machine {
        code: String,
        prompt: Option<String>,
        detail: Option<String>,
    },
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        Self::Message(message.into())
    }

    pub fn machine(code: impl Into<String>) -> Self {
        Self::Machine {
            code: code.into(),
            prompt: None,
            detail: None,
        }
    }

    /// A machine code plus the original remote text. The code routes the UI
    /// (auth challenges, localized fallbacks); the detail is what the user
    /// actually reads — without it every failure looks the same.
    pub fn machine_detail(code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::Machine {
            code: code.into(),
            prompt: None,
            detail: Some(detail.into()),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Message(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Message(value.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            Self::Message(message) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
            }
            Self::Machine {
                code,
                prompt,
                detail,
            } => {
                let mut body = json!({ "error": code, "code": code });
                if let Some(prompt) = prompt {
                    body["prompt"] = json!(prompt);
                }
                if let Some(detail) = detail {
                    body["detail"] = json!(detail);
                }
                (StatusCode::BAD_REQUEST, Json(body)).into_response()
            }
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
