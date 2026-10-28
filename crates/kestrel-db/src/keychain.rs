//! Passwords in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Linux Secret Service). Service `dev.kestrel.editor.db`, account = connection id.
//! The keychain calls can block (they may show a system dialog), so they run on
//! a blocking thread.

use kestrel_common::Result;
use kestrel_common::error::codes;
use kestrel_common::Error;

pub const SERVICE: &str = "dev.kestrel.editor.db";

fn entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).map_err(keychain_error)
}

fn keychain_error(e: keyring::Error) -> Error {
    Error::new(codes::INTERNAL, format!("keychain: {e}"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| Error::internal(format!("keychain task failed: {e}")))?
}

pub async fn set(id: &str, password: &str) -> Result<()> {
    let (id, password) = (id.to_string(), password.to_string());
    blocking(move || entry(&id)?.set_password(&password).map_err(keychain_error)).await
}

/// `None` when the keychain has no entry for this id.
pub async fn get(id: &str) -> Result<Option<String>> {
    let id = id.to_string();
    blocking(move || match entry(&id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_error(e)),
    })
    .await
}

/// Deleting an entry that does not exist is not an error.
pub async fn delete(id: &str) -> Result<()> {
    let id = id.to_string();
    blocking(move || match entry(&id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_error(e)),
    })
    .await
}

pub async fn exists(id: &str) -> Result<bool> {
    Ok(get(id).await?.is_some())
}
