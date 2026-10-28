//! App-level commands: settings file, app info, logging from the frontend.

use super::{Handler, SetupResult};
use kestrel_common::{Error, Result};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{App, AppHandle, Manager, Runtime};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    path: String,
    /// `None` when the file does not exist yet.
    text: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    platform: &'static str,
    config_dir: String,
    data_dir: String,
    cache_dir: String,
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| Error::internal(e.to_string()))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn app_settings_read(app: AppHandle) -> Result<SettingsFile> {
    let path = settings_path(&app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => Some(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    Ok(SettingsFile { path: path.to_string_lossy().into_owned(), text })
}

#[tauri::command]
fn app_settings_write(app: AppHandle, text: String) -> Result<()> {
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write a temp file first, so a crash never leaves a half-written file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[tauri::command]
fn app_info(app: AppHandle) -> Result<AppInfo> {
    let p = app.path();
    let s = |r: tauri::Result<PathBuf>| r.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        },
        config_dir: s(p.app_config_dir()),
        data_dir: s(p.app_data_dir()),
        cache_dir: s(p.app_cache_dir()),
    })
}

/// Prints a frontend message to the terminal (helps when you debug a release build).
#[tauri::command]
fn app_log(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[web] {message}"),
        "warn" => log::warn!("[web] {message}"),
        _ => log::info!("[web] {message}"),
    }
    if cfg!(debug_assertions) || std::env::var_os("KESTREL_LOG").is_some() {
        eprintln!("[web:{level}] {message}");
    }
}

pub fn handler() -> Handler {
    Box::new(tauri::generate_handler![app_settings_read, app_settings_write, app_info, app_log])
}

pub fn setup(_app: &mut App) -> SetupResult {
    Ok(())
}
