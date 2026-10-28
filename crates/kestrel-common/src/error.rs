use serde::ser::{Serialize, SerializeStruct, Serializer};
use std::io;

/// Error returned by every Tauri command.
///
/// The frontend receives it as `{ code: string, message: string }`.
/// Keep `code` values stable: the frontend checks them (for example "conflict").
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{message}")]
    Code { code: &'static str, message: String },
    #[error("{0}")]
    Io(#[from] io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Error codes shared by the Rust side and the frontend (`src/ipc/invoke.ts`).
pub mod codes {
    pub const NOT_FOUND: &str = "not_found";
    pub const PERMISSION_DENIED: &str = "permission_denied";
    pub const ALREADY_EXISTS: &str = "already_exists";
    /// The file changed on disk after the editor loaded it.
    pub const CONFLICT: &str = "conflict";
    pub const TOO_LARGE: &str = "too_large";
    pub const BINARY: &str = "binary";
    /// The text has characters that the target encoding cannot store.
    pub const UNMAPPABLE: &str = "unmappable";
    pub const NOT_A_REPO: &str = "not_a_repo";
    pub const GIT_MISSING: &str = "git_missing";
    pub const SERVER_MISSING: &str = "server_missing";
    pub const CANCELLED: &str = "cancelled";
    pub const INVALID_INPUT: &str = "invalid_input";
    pub const IO: &str = "io";
    pub const INTERNAL: &str = "internal";
}

impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Error::Code { code, message: message.into() }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(codes::NOT_FOUND, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(codes::INVALID_INPUT, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(codes::INTERNAL, message)
    }
    pub fn cancelled() -> Self {
        Self::new(codes::CANCELLED, "cancelled")
    }

    pub fn code(&self) -> &'static str {
        match self {
            Error::Code { code, .. } => code,
            Error::Io(e) => io_code(e.kind()),
        }
    }
}

fn io_code(kind: io::ErrorKind) -> &'static str {
    match kind {
        io::ErrorKind::NotFound => codes::NOT_FOUND,
        io::ErrorKind::PermissionDenied => codes::PERMISSION_DENIED,
        io::ErrorKind::AlreadyExists => codes::ALREADY_EXISTS,
        _ => codes::IO,
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::internal(format!("json: {e}"))
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Error", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() {
        let e = Error::new(codes::CONFLICT, "changed on disk");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "conflict");
        assert_eq!(v["message"], "changed on disk");
        let io = Error::from(io::Error::from(io::ErrorKind::NotFound));
        assert_eq!(io.code(), "not_found");
    }
}
