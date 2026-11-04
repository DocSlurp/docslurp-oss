//! Typed errors, serialized as `{ "code": ..., "message": ... }` across the ABI.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request JSON does not match the contract (missing, extra or out-of-range fields).
    InvalidRequest,
    /// The supplied card is malformed or has another schema.
    InvalidCard,
    /// The card or profile needs pricing rules this build does not implement (newer card, unknown quality or feature).
    UnsupportedRules,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl Error {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn invalid_card(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidCard, format!("invalid price card: {}", message.into()))
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for Error {}
