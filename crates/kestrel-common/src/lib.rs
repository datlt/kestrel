//! Shared code for all Kestrel crates: the error type sent to the frontend,
//! the login-shell environment used to start child processes (git, language
//! servers), the list of folders the preview protocol may serve, and path helpers.

pub mod error;
pub mod paths;
pub mod process;
pub mod roots;

pub use error::{Error, Result};
