//! kestrel-db: MySQL and Trino sessions for the database feature. See docs/DESIGN.md section 9
//! and the contract in `src/ipc/db.ts`.
//!
//! - `DbManager` keeps sessions per owner (a window label).
//! - A MySQL session is one connection (text protocol) and can use an SSH tunnel.
//! - A Trino session is a client of the Trino HTTP protocol (no JDBC).
//! - Passwords live in the OS keychain.

mod error;
mod export;
mod idea;
mod keychain;
mod manager;
mod schema;
mod trino;
mod tunnel;
mod types;
mod values;

pub use idea::list as idea_list;
pub use manager::DbManager;
pub use trino::TrinoOptions;
pub use types::*;

#[cfg(test)]
pub(crate) fn tunnel_test_config() -> ConnectionConfig {
    ConnectionConfig {
        id: "c1".into(),
        name: "n".into(),
        driver: Driver::Mysql,
        catalog: None,
        trino_auth: None,
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
        source: None,
    }
}
