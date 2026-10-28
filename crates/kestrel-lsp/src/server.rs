//! One language server process.
//!
//! Threads: a reader (stdout to messages), a stderr reader, a writer (messages
//! to stdin) and a waiter (exit detection). All callbacks run on those threads,
//! so they must be quick and must not block.

use crate::framing::{FrameDecoder, encode_frame};
use parking_lot::{Condvar, Mutex};
use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How many stderr lines we keep for the output panel.
pub const LOG_LINES: usize = 2000;
/// Longer stderr lines are cut to this many bytes.
const MAX_LOG_LINE: usize = 16 * 1024;
/// Id of the `shutdown` request that we send ourselves. The frontend uses numbers.
const SHUTDOWN_ID: &str = "kestrel-shutdown";

pub struct SpawnOptions {
    /// Program name or path.
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
    /// How long `stop` waits for a clean exit before it kills the process.
    pub stop_timeout: Duration,
}

impl SpawnOptions {
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        SpawnOptions { program: program.into(), args, env: Vec::new(), cwd: None, stop_timeout: Duration::from_secs(2) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    /// Unix signal that ended the process, if any.
    pub signal: Option<i32>,
    /// True when `stop` was called before the exit. False means a crash or a normal exit by the server itself.
    pub stopped: bool,
}

pub struct Callbacks {
    /// One complete JSON message from the server (no headers).
    pub on_message: Box<dyn Fn(String) + Send + Sync>,
    /// One line from stderr, without the line ending.
    pub on_stderr: Box<dyn Fn(String) + Send + Sync>,
    /// Called once, after the process ended.
    pub on_exit: Box<dyn Fn(ExitInfo) + Send + Sync>,
}

#[derive(Default)]
struct State {
    exit: Option<ExitInfo>,
    stopping: bool,
    shutdown_acked: bool,
}

struct Shared {
    logs: Mutex<VecDeque<String>>,
    state: Mutex<State>,
    changed: Condvar,
}

pub struct Server {
    pid: u32,
    tx: Mutex<Option<Sender<Vec<u8>>>>,
    shared: Arc<Shared>,
    stop_timeout: Duration,
}

impl Server {
    pub fn start(opts: SpawnOptions, cb: Callbacks) -> io::Result<Server> {
        let mut cmd = kestrel_common::process::command(&opts.program);
        cmd.args(&opts.args);
        cmd.envs(opts.env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            // Own process group: we can kill the server and its children together.
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        let shared = Arc::new(Shared {
            logs: Mutex::new(VecDeque::new()),
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
        });
        let cb = Arc::new(cb);
        let out_done = Arc::new(AtomicBool::new(false));
        let err_done = Arc::new(AtomicBool::new(false));

        // Writer.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new().name("lsp-writer".into()).spawn(move || {
            let mut stdin = stdin;
            while let Ok(frame) = rx.recv() {
                if stdin.write_all(&frame).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        })?;

        // Reader for stdout.
        {
            let (shared, cb, done) = (shared.clone(), cb.clone(), out_done.clone());
            std::thread::Builder::new().name("lsp-reader".into()).spawn(move || {
                let mut input = stdout;
                let mut decoder = FrameDecoder::new();
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    let n = match input.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    for msg in decoder.push(&buf[..n]) {
                        if is_shutdown_reply(&shared, &msg) {
                            continue;
                        }
                        (cb.on_message)(msg);
                    }
                }
                done.store(true, Ordering::SeqCst);
            })?;
        }

        // Reader for stderr.
        {
            let (shared, cb, done) = (shared.clone(), cb.clone(), err_done.clone());
            std::thread::Builder::new().name("lsp-stderr".into()).spawn(move || {
                let mut input = BufReader::new(stderr);
                let mut raw = Vec::new();
                loop {
                    raw.clear();
                    match input.read_until(b'\n', &mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let line = clean_line(&raw);
                    {
                        let mut logs = shared.logs.lock();
                        if logs.len() >= LOG_LINES {
                            logs.pop_front();
                        }
                        logs.push_back(line.clone());
                    }
                    (cb.on_stderr)(line);
                }
                done.store(true, Ordering::SeqCst);
            })?;
        }

        // Waiter: detects the exit.
        {
            let shared = shared.clone();
            std::thread::Builder::new().name("lsp-wait".into()).spawn(move || {
                let status = child.wait();
                // Give the readers a moment to deliver the last lines and messages.
                let deadline = Instant::now() + Duration::from_millis(500);
                while !(out_done.load(Ordering::SeqCst) && err_done.load(Ordering::SeqCst)) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                let (code, signal) = match &status {
                    Ok(s) => (s.code(), signal_of(s)),
                    Err(_) => (None, None),
                };
                let info = {
                    let mut st = shared.state.lock();
                    let info = ExitInfo { code, signal, stopped: st.stopping };
                    st.exit = Some(info.clone());
                    shared.changed.notify_all();
                    info
                };
                (cb.on_exit)(info);
            })?;
        }

        Ok(Server { pid, tx: Mutex::new(Some(tx)), shared, stop_timeout: opts.stop_timeout })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Queues one JSON message. It is written by the writer thread.
    pub fn send(&self, message: &str) -> io::Result<()> {
        if self.shared.state.lock().exit.is_some() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "the language server has exited"));
        }
        self.write_frame(encode_frame(message))
    }

    fn write_frame(&self, frame: Vec<u8>) -> io::Result<()> {
        match self.tx.lock().as_ref() {
            Some(tx) => tx.send(frame).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "writer stopped")),
            None => Err(io::Error::new(io::ErrorKind::BrokenPipe, "server is stopped")),
        }
    }

    /// The last stderr lines (at most 2000).
    pub fn logs(&self) -> Vec<String> {
        self.shared.logs.lock().iter().cloned().collect()
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.shared.state.lock().exit.clone()
    }

    pub fn is_running(&self) -> bool {
        self.exit_info().is_none()
    }

    /// Stops the server: `shutdown` request, `exit` notification, then a kill
    /// after `stop_timeout`. Blocks up to about `stop_timeout` plus one second.
    /// Safe to call more than once.
    pub fn stop(&self) {
        let first = {
            let mut st = self.shared.state.lock();
            let first = !st.stopping;
            st.stopping = true;
            first
        };
        let deadline = Instant::now() + self.stop_timeout;
        if first && self.is_running() {
            let shutdown = format!("{{\"jsonrpc\":\"2.0\",\"id\":\"{SHUTDOWN_ID}\",\"method\":\"shutdown\"}}");
            if self.write_frame(encode_frame(&shutdown)).is_ok() {
                self.wait_until(deadline, |st| st.shutdown_acked || st.exit.is_some());
                let exit = "{\"jsonrpc\":\"2.0\",\"method\":\"exit\"}";
                let _ = self.write_frame(encode_frame(exit));
            }
        }
        let exited = self.wait_until(deadline, |st| st.exit.is_some());
        if !exited {
            kill_tree(self.pid);
            self.wait_until(Instant::now() + Duration::from_secs(1), |st| st.exit.is_some());
        } else {
            // The server is gone. Children that stayed behind (for example `java`) die now.
            kill_group_leftovers(self.pid);
        }
        *self.tx.lock() = None;
    }

    /// Waits until `done` is true or the deadline passes. Returns the last value of `done`.
    fn wait_until(&self, deadline: Instant, done: impl Fn(&State) -> bool) -> bool {
        let mut st = self.shared.state.lock();
        while !done(&st) {
            if self.shared.changed.wait_until(&mut st, deadline).timed_out() {
                return done(&st);
            }
        }
        true
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.is_running() {
            self.shared.state.lock().stopping = true;
            kill_tree(self.pid);
        }
        *self.tx.lock() = None;
    }
}

/// True when `msg` is the reply to our own `shutdown` request.
fn is_shutdown_reply(shared: &Shared, msg: &str) -> bool {
    if !shared.state.lock().stopping || !msg.contains(SHUTDOWN_ID) {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(msg) else { return false };
    if v.get("id").and_then(|i| i.as_str()) == Some(SHUTDOWN_ID) && v.get("method").is_none() {
        shared.state.lock().shutdown_acked = true;
        shared.changed.notify_all();
        return true;
    }
    false
}

fn clean_line(raw: &[u8]) -> String {
    let mut end = raw.len();
    while end > 0 && (raw[end - 1] == b'\n' || raw[end - 1] == b'\r') {
        end -= 1;
    }
    let mut s = String::from_utf8_lossy(&raw[..end]).into_owned();
    if s.len() > MAX_LOG_LINE {
        let mut cut = MAX_LOG_LINE;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str(" [cut]");
    }
    s
}

#[cfg(unix)]
fn signal_of(s: &std::process::ExitStatus) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    s.signal()
}

#[cfg(not(unix))]
fn signal_of(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

/// Kills the process and all its children.
#[cfg(unix)]
fn kill_tree(pid: u32) {
    // A negative pid means: the whole process group. The server is the leader of its group.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(unix)]
fn kill_group_leftovers(pid: u32) {
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = kestrel_common::process::command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn kill_group_leftovers(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{Receiver, channel};

    struct Harness {
        server: Server,
        messages: Receiver<String>,
        stderr: Receiver<String>,
        exit: Receiver<ExitInfo>,
    }

    fn script() -> String {
        format!("{}/tests/fake_server.py", env!("CARGO_MANIFEST_DIR"))
    }

    fn start(env: &[(&str, &str)], stop_timeout_ms: u64) -> Harness {
        // Without this call, every spawn waits 5 seconds for the shell environment.
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(kestrel_common::process::init_shell_env);
        let (m_tx, messages) = channel();
        let (s_tx, stderr) = channel();
        let (e_tx, exit) = channel();
        let (m_tx, s_tx, e_tx) = (Mutex::new(m_tx), Mutex::new(s_tx), Mutex::new(e_tx));
        let mut opts = SpawnOptions::new("python3", vec!["-u".into(), script()]);
        opts.env = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        opts.stop_timeout = Duration::from_millis(stop_timeout_ms);
        let server = Server::start(
            opts,
            Callbacks {
                on_message: Box::new(move |m| {
                    let _ = m_tx.lock().send(m);
                }),
                on_stderr: Box::new(move |l| {
                    let _ = s_tx.lock().send(l);
                }),
                on_exit: Box::new(move |i| {
                    let _ = e_tx.lock().send(i);
                }),
            },
        )
        .expect("python3 must be installed");
        Harness { server, messages, stderr, exit }
    }

    const WAIT: Duration = Duration::from_secs(10);

    #[test]
    fn initialize_and_echo() {
        let h = start(&[], 2000);
        h.server.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&h.messages.recv_timeout(WAIT).unwrap()).unwrap();
        assert_eq!(reply["id"], 1);
        assert!(reply["result"]["capabilities"].is_object());

        // A request that the fake server echoes back, with non-ASCII text.
        h.server.send(r#"{"jsonrpc":"2.0","id":2,"method":"test/echo","params":{"text":"日本語 😀 héllo"}}"#).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&h.messages.recv_timeout(WAIT).unwrap()).unwrap();
        assert_eq!(reply["id"], 2);
        assert_eq!(reply["result"]["text"], "日本語 😀 héllo");
        h.server.stop();
    }

    #[test]
    fn big_message_and_burst() {
        let h = start(&[], 2000);
        let big = "x".repeat(3 * 1024 * 1024);
        let msg = format!(r#"{{"jsonrpc":"2.0","id":7,"method":"test/echo","params":{{"text":"{big}"}}}}"#);
        h.server.send(&msg).unwrap();
        let reply: serde_json::Value = serde_json::from_str(&h.messages.recv_timeout(WAIT).unwrap()).unwrap();
        assert_eq!(reply["result"]["text"].as_str().unwrap().len(), big.len());
        // Many small messages arrive in order.
        for i in 0..200 {
            h.server.send(&format!(r#"{{"jsonrpc":"2.0","id":{},"method":"test/echo","params":{{}}}}"#, 100 + i)).unwrap();
        }
        for i in 0..200 {
            let r: serde_json::Value = serde_json::from_str(&h.messages.recv_timeout(WAIT).unwrap()).unwrap();
            assert_eq!(r["id"], 100 + i);
        }
        h.server.stop();
    }

    #[test]
    fn stderr_lines_and_ring_buffer() {
        let h = start(&[("FAKE_STDERR_LINES", "2500")], 2000);
        let first = h.stderr.recv_timeout(WAIT).unwrap();
        assert_eq!(first, "stderr line 0");
        let mut last = first;
        for _ in 1..2500 {
            last = h.stderr.recv_timeout(WAIT).unwrap();
        }
        assert_eq!(last, "stderr line 2499");
        let logs = h.server.logs();
        assert_eq!(logs.len(), LOG_LINES);
        assert_eq!(logs.last().unwrap(), "stderr line 2499");
        assert_eq!(logs[0], "stderr line 500");
        h.server.stop();
    }

    #[test]
    fn clean_stop_uses_shutdown_and_exit() {
        let h = start(&[], 3000);
        h.server.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#).unwrap();
        h.messages.recv_timeout(WAIT).unwrap();
        let t = Instant::now();
        h.server.stop();
        assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
        let info = h.exit.recv_timeout(WAIT).unwrap();
        assert_eq!(info, ExitInfo { code: Some(0), signal: None, stopped: true });
        // The reply to our shutdown request is not forwarded.
        assert!(h.messages.try_recv().is_err());
        assert!(h.server.send("{}").is_err());
        h.server.stop(); // second call is fine
    }

    #[test]
    fn stuck_server_is_killed_after_timeout() {
        let h = start(&[("FAKE_IGNORE_SHUTDOWN", "1")], 400);
        h.server.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#).unwrap();
        h.messages.recv_timeout(WAIT).unwrap();
        let t = Instant::now();
        h.server.stop();
        assert!(t.elapsed() < Duration::from_secs(4), "took {:?}", t.elapsed());
        let info = h.exit.recv_timeout(WAIT).unwrap();
        assert!(info.stopped);
        #[cfg(unix)]
        assert_eq!(info.signal, Some(9));
    }

    #[test]
    fn crash_is_reported() {
        let h = start(&[], 2000);
        h.server.send(r#"{"jsonrpc":"2.0","id":1,"method":"test/crash","params":{}}"#).unwrap();
        let info = h.exit.recv_timeout(WAIT).unwrap();
        assert_eq!(info, ExitInfo { code: Some(3), signal: None, stopped: false });
        assert!(!h.server.is_running());
        assert!(h.server.send("{}").is_err());
    }

    #[test]
    fn missing_program_fails_to_start() {
        let r = Server::start(
            SpawnOptions::new("/definitely/not/here/server", vec![]),
            Callbacks { on_message: Box::new(|_| {}), on_stderr: Box::new(|_| {}), on_exit: Box::new(|_| {}) },
        );
        assert!(r.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn child_processes_die_with_the_server() {
        // The server starts `sleep` as a child, like jdtls starts java.
        let h = start(&[("FAKE_SPAWN_CHILD", "1"), ("FAKE_IGNORE_SHUTDOWN", "1")], 300);
        let line = h.stderr.recv_timeout(WAIT).unwrap();
        let child_pid: i32 = line.strip_prefix("child pid ").unwrap().trim().parse().unwrap();
        assert!(alive(child_pid));
        h.server.stop();
        let t = Instant::now();
        while alive(child_pid) && t.elapsed() < Duration::from_secs(3) {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(child_pid), "child {child_pid} is still running");
    }

    #[cfg(unix)]
    fn alive(pid: i32) -> bool {
        // Signal 0 only checks that the process exists. A zombie counts as gone.
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&out.stdout);
        let stat = stat.trim();
        !stat.is_empty() && !stat.starts_with('Z')
    }
}
