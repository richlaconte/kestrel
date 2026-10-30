// The one error shape every IPC failure takes (RFC-0001 §7). The webview's
// generated stubs and kestrel-native turn it into a `KestrelError`.

use serde::{Deserialize, Serialize};

/// The closed set of codes. Native code may throw an error whose `code` is
/// one of these to pick it; anything else becomes `native_function`.
pub const CODES: &[&str] = &[
    "permission_denied",
    "not_found",
    "io",
    "native_function",
    "cancelled",
    "unsupported_platform",
    "timeout",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KestrelError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl KestrelError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        debug_assert!(CODES.contains(&code), "unknown error code {code}");
        KestrelError {
            code: code.to_string(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }
}

impl std::fmt::Display for KestrelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
