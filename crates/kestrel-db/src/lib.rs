//! kestrel-db: MySQL sessions for the database feature. See docs/DESIGN.md section 9
//! and the contract in `src/ipc/db.ts`.
//!
//! - `DbManager` keeps sessions per owner (a window label).
//! - A session is one MySQL connection (text protocol) and can use an SSH tunnel.
//! - Passwords live in the OS keychain.

mod error;
mod keychain;
mod manager;
mod schema;
mod tunnel;
mod types;
mod values;

pub use manager::DbManager;
pub use types::*;

#[cfg(test)]
pub(crate) fn tunnel_test_config() -> ConnectionConfig {
    ConnectionConfig {
        id: "c1".into(),
        name: "n".into(),
        host: "127.0.0.1".into(),
        port: 3306,
        user: "root".into(),
        database: None,
        ssl: SslMode::Preferred,
        ssh: None,
        read_only: false,
        production: false,
        color: None,
        init_sql: None,
        connect_timeout_sec: None,
    }
}
