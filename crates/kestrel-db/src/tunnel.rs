//! SSH tunnels through the system `ssh` program.
//!
//! We run `ssh -N -L 127.0.0.1:<free port>:<db host>:<db port> user@bastion`.
//! This way `~/.ssh/config`, key files and the ssh agent work as in a terminal.
//! `BatchMode=yes` makes ssh fail at once when it needs a password or a prompt.
//! One tunnel serves all sessions of one window and one connection (ref-counted).

use crate::types::ConnectionConfig;
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

/// A running ssh process with a local forwarded port.
pub struct Tunnel {
    child: tokio::process::Child,
    pub local_port: u16,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl Tunnel {
    /// Stops ssh. On unix it kills the whole process group, so no helper process stays.
    pub fn kill(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // The child leads its own group (see `open`), so the group id is its pid.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }

    /// True while the ssh process runs.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stderr_text(&self) -> String {
        stderr_summary(&self.stderr.lock())
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.kill();
    }
}

fn stderr_summary(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn connect_error(message: impl Into<String>) -> Error {
    Error::new(codes::DB_CONNECT, message)
}

/// Rejects values that ssh would read as an option (for example `-oProxyCommand=...`).
fn check_arg(what: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(connect_error(format!("SSH tunnel: the {what} `{value}` is not valid")));
    }
    Ok(())
}

/// The arguments for ssh. `local_port` is the port on 127.0.0.1.
pub fn ssh_args(cfg: &ConnectionConfig, local_port: u16, connect_timeout_sec: u64) -> Result<Vec<String>> {
    let ssh = cfg.ssh.as_ref().ok_or_else(|| Error::invalid("no SSH tunnel is configured"))?;
    check_arg("SSH host", &ssh.host)?;
    check_arg("database host", &cfg.host)?;
    let user = ssh.user.as_deref().map(str::trim).filter(|u| !u.is_empty());
    if let Some(u) = user {
        check_arg("SSH user", u)?;
    }
    // An IPv6 address needs brackets in the forward spec.
    let db_host = if cfg.host.contains(':') && !cfg.host.starts_with('[') { format!("[{}]", cfg.host) } else { cfg.host.clone() };
    let mut args: Vec<String> = vec![
        "-N".into(),
        "-L".into(),
        format!("127.0.0.1:{local_port}:{db_host}:{}", cfg.port),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        format!("ConnectTimeout={connect_timeout_sec}"),
    ];
    if let Some(port) = ssh.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(identity) = ssh.identity_file.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        args.push("-i".into());
        args.push(identity.to_string());
    }
    args.push(match user {
        Some(u) => format!("{u}@{}", ssh.host),
        None => ssh.host.clone(),
    });
    Ok(args)
}

/// Finds a free port on 127.0.0.1.
fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Starts ssh and waits until the local port accepts connections.
/// Fails when ssh exits (its stderr goes into the message) or when the time is over.
pub async fn open(cfg: &ConnectionConfig, timeout: Duration) -> Result<Tunnel> {
    let port = free_port()?;
    let args = ssh_args(cfg, port, timeout.as_secs().max(1))?;
    let mut std_cmd = kestrel_common::process::command("ssh");
    std_cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: we can kill ssh and its helpers together, and Ctrl-C
        // in a terminal does not reach it.
        std_cmd.process_group(0);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| connect_error(format!("cannot start `ssh`: {e}")))?;

    // Read stderr all the time, so ssh never blocks on a full pipe.
    let stderr = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let sink = stderr.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                let mut s = sink.lock();
                if s.len() < 8192 {
                    s.extend_from_slice(&buf[..n]);
                }
            }
        });
    }
    let mut tunnel = Tunnel { child, local_port: port, stderr };

    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = tunnel.child.try_wait() {
            // Give the stderr reader a moment to collect the last bytes.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let text = tunnel.stderr_text();
            let detail = if text.is_empty() { format!("ssh exited with {status}") } else { text };
            return Err(connect_error(format!("SSH tunnel failed: {detail}")));
        }
        let probe = tokio::time::timeout(Duration::from_millis(300), TcpStream::connect(("127.0.0.1", port))).await;
        if matches!(probe, Ok(Ok(_))) {
            return Ok(tunnel);
        }
        if Instant::now() >= deadline {
            let text = tunnel.stderr_text();
            tunnel.kill();
            let mut msg = format!("SSH tunnel did not open within {} seconds", timeout.as_secs());
            if !text.is_empty() {
                msg.push_str(&format!(": {text}"));
            }
            return Err(connect_error(msg));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// --- Shared tunnels ---------------------------------------------------------

/// One tunnel per window, connection and target. The target is part of the key,
/// so a changed host in the settings never reuses an old tunnel.
pub type TunnelKey = (String, String, String);

struct SlotState {
    tunnel: Option<Tunnel>,
    refs: usize,
    /// Set when the last session left. A task that still holds the slot starts over.
    removed: bool,
}

struct Slot {
    state: tokio::sync::Mutex<SlotState>,
}

#[derive(Default)]
pub struct Tunnels {
    slots: Mutex<HashMap<TunnelKey, Arc<Slot>>>,
}

pub fn tunnel_key(owner: &str, cfg: &ConnectionConfig) -> TunnelKey {
    let ssh = cfg.ssh.as_ref();
    let target = format!(
        "{}:{}|{}@{}:{}|{}",
        cfg.host,
        cfg.port,
        ssh.and_then(|s| s.user.as_deref()).unwrap_or(""),
        ssh.map(|s| s.host.as_str()).unwrap_or(""),
        ssh.and_then(|s| s.port).unwrap_or(0),
        ssh.and_then(|s| s.identity_file.as_deref()).unwrap_or(""),
    );
    (owner.to_string(), cfg.id.clone(), target)
}

impl Tunnels {
    /// Returns the local port of the tunnel and counts one more user.
    /// Starts ssh when no tunnel runs for this key.
    pub async fn acquire(&self, key: &TunnelKey, cfg: &ConnectionConfig, timeout: Duration) -> Result<u16> {
        loop {
            let slot = self
                .slots
                .lock()
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Slot { state: tokio::sync::Mutex::new(SlotState { tunnel: None, refs: 0, removed: false }) }))
                .clone();
            let mut st = slot.state.lock().await;
            if st.removed {
                continue;
            }
            if let Some(t) = st.tunnel.as_mut() {
                if t.is_alive() {
                    st.refs += 1;
                    return Ok(st.tunnel.as_ref().map(|t| t.local_port).unwrap_or(0));
                }
                st.tunnel = None;
            }
            match open(cfg, timeout).await {
                Ok(t) => {
                    let port = t.local_port;
                    st.tunnel = Some(t);
                    st.refs += 1;
                    return Ok(port);
                }
                Err(e) => {
                    if st.refs == 0 {
                        st.removed = true;
                        let mut slots = self.slots.lock();
                        if slots.get(key).is_some_and(|s| Arc::ptr_eq(s, &slot)) {
                            slots.remove(key);
                        }
                    }
                    return Err(e);
                }
            }
        }
    }

    /// One user less. The last user stops ssh.
    pub async fn release(&self, key: &TunnelKey) {
        let slot = self.slots.lock().get(key).cloned();
        let Some(slot) = slot else { return };
        let mut st = slot.state.lock().await;
        st.refs = st.refs.saturating_sub(1);
        if st.refs == 0 {
            st.removed = true;
            if let Some(mut t) = st.tunnel.take() {
                t.kill();
            }
            let mut slots = self.slots.lock();
            if slots.get(key).is_some_and(|s| Arc::ptr_eq(s, &slot)) {
                slots.remove(key);
            }
        }
    }

    /// Kills every ssh process now, without waiting. For app exit.
    pub fn kill_all_now(&self) {
        let slots: Vec<Arc<Slot>> = self.slots.lock().drain().map(|(_, s)| s).collect();
        for slot in slots {
            if let Ok(mut st) = slot.state.try_lock() {
                st.removed = true;
                if let Some(mut t) = st.tunnel.take() {
                    t.kill();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SshTunnel, SslMode};

    fn cfg(ssh: Option<SshTunnel>) -> ConnectionConfig {
        ConnectionConfig {
            id: "c1".into(),
            name: "n".into(),
            driver: crate::types::Driver::Mysql,
            catalog: None,
            trino_auth: None,
            host: "db.internal".into(),
            port: 3306,
            user: "root".into(),
            database: None,
            ssl: SslMode::Preferred,
            ssh,
            read_only: false,
            production: false,
            color: None,
            init_sql: None,
            connect_timeout_sec: None,
            source: None,
        }
    }

    fn bastion() -> SshTunnel {
        SshTunnel { host: "bastion.example.com".into(), port: Some(2222), user: Some("deploy".into()), identity_file: Some("/keys/id".into()) }
    }

    #[test]
    fn builds_ssh_arguments() {
        let args = ssh_args(&cfg(Some(bastion())), 40001, 10).unwrap();
        assert_eq!(
            args,
            vec![
                "-N", "-L", "127.0.0.1:40001:db.internal:3306", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o",
                "ServerAliveInterval=30", "-o", "ConnectTimeout=10", "-p", "2222", "-i", "/keys/id", "deploy@bastion.example.com"
            ]
        );
    }

    #[test]
    fn optional_parts_are_left_out() {
        let ssh = SshTunnel { host: "bastion".into(), port: None, user: Some("  ".into()), identity_file: Some("".into()) };
        let args = ssh_args(&cfg(Some(ssh)), 1, 5).unwrap();
        assert_eq!(args.last().unwrap(), "bastion");
        assert!(!args.contains(&"-p".to_string()) && !args.contains(&"-i".to_string()));
    }

    #[test]
    fn ipv6_database_host_gets_brackets() {
        let mut c = cfg(Some(bastion()));
        c.host = "::1".into();
        let args = ssh_args(&c, 5, 5).unwrap();
        assert_eq!(args[2], "127.0.0.1:5:[::1]:3306");
    }

    #[test]
    fn refuses_option_like_values() {
        let mut ssh = bastion();
        ssh.host = "-oProxyCommand=touch /tmp/x".into();
        assert_eq!(ssh_args(&cfg(Some(ssh)), 1, 5).unwrap_err().code(), "db_connect");
        let mut ssh = bastion();
        ssh.user = Some("-x".into());
        assert!(ssh_args(&cfg(Some(ssh)), 1, 5).is_err());
    }

    #[test]
    fn key_changes_with_target() {
        let a = tunnel_key("w", &cfg(Some(bastion())));
        let mut other = cfg(Some(bastion()));
        other.host = "db2".into();
        assert_ne!(a, tunnel_key("w", &other));
        assert_ne!(a, tunnel_key("w2", &cfg(Some(bastion()))));
    }
}
