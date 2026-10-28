//! Command routing. Each feature module has its own `generate_handler!` list,
//! and this file sends each command to its module by the name prefix:
//!
//! | prefix                | module        |
//! |-----------------------|---------------|
//! | `app_`                | `app.rs`      |
//! | `fs_`, `ws_`          | `fs.rs`       |
//! | `search_`             | `search.rs`   |
//! | `git_`                | `git.rs`      |
//! | `lsp_`                | `lsp.rs`      |
//! | `md_`, `preview_`     | `preview.rs`  |
//! | `db_`                 | `db.rs`       |
//! | `web_`                | `web.rs`      |
//! | `term_`               | `term.rs`     |
//! | `code_`               | `code.rs`     |
//! | `gh_`                 | `gh.rs`       |
//!
//! Every feature module must export: `handler()`, `setup()`,
//! `on_window_destroyed()` and `on_exit()`.

pub mod app;
pub mod code;
pub mod db;
pub mod gh;
pub mod fs;
pub mod git;
pub mod lsp;
pub mod preview;
pub mod search;
pub mod term;
pub mod web;

use tauri::ipc::Invoke;
use tauri::{App, AppHandle, Wry};

pub type Handler = Box<dyn Fn(Invoke<Wry>) -> bool + Send + Sync>;
pub type SetupResult = Result<(), Box<dyn std::error::Error>>;

pub struct Handlers {
    app: Handler,
    fs: Handler,
    search: Handler,
    git: Handler,
    lsp: Handler,
    preview: Handler,
    db: Handler,
    web: Handler,
    term: Handler,
    code: Handler,
    gh: Handler,
}

impl Handlers {
    pub fn new() -> Self {
        Handlers {
            app: app::handler(),
            fs: fs::handler(),
            search: search::handler(),
            git: git::handler(),
            lsp: lsp::handler(),
            preview: preview::handler(),
            db: db::handler(),
            web: web::handler(),
            term: term::handler(),
            code: code::handler(),
            gh: gh::handler(),
        }
    }

    pub fn dispatch(&self, invoke: Invoke<Wry>) -> bool {
        let name = invoke.message.command();
        let prefix = name.split('_').next().unwrap_or("");
        let handler = match prefix {
            "app" => &self.app,
            "fs" | "ws" => &self.fs,
            "search" => &self.search,
            "git" => &self.git,
            "lsp" => &self.lsp,
            "md" | "preview" => &self.preview,
            "db" => &self.db,
            "web" => &self.web,
            "term" => &self.term,
            "code" => &self.code,
            "gh" => &self.gh,
            _ => {
                let msg = format!("unknown command: {name}");
                invoke.resolver.reject(msg);
                return true;
            }
        };
        handler(invoke)
    }
}

pub fn setup(app: &mut App) -> SetupResult {
    app::setup(app)?;
    fs::setup(app)?;
    search::setup(app)?;
    git::setup(app)?;
    lsp::setup(app)?;
    preview::setup(app)?;
    db::setup(app)?;
    web::setup(app)?;
    term::setup(app)?;
    code::setup(app)?;
    gh::setup(app)?;
    Ok(())
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    fs::on_window_destroyed(app, label);
    search::on_window_destroyed(app, label);
    git::on_window_destroyed(app, label);
    lsp::on_window_destroyed(app, label);
    preview::on_window_destroyed(app, label);
    db::on_window_destroyed(app, label);
    web::on_window_destroyed(app, label);
    term::on_window_destroyed(app, label);
    code::on_window_destroyed(app, label);
    gh::on_window_destroyed(app, label);
}

pub fn on_exit(app: &AppHandle) {
    lsp::on_exit(app);
    fs::on_exit(app);
    search::on_exit(app);
    git::on_exit(app);
    preview::on_exit(app);
    db::on_exit(app);
    web::on_exit(app);
    term::on_exit(app);
    code::on_exit(app);
    gh::on_exit(app);
}
