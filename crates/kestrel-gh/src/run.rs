//! Runs a child process (`gh` or `git`) with a timeout and a cancel switch.
//! A `Job` lets another thread kill the process.

use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use std::io::{ErrorKind, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Job {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
    /// Wakes `run` when the job is cancelled, even if a grandchild process
    /// still holds the output pipes open.
    wake: Mutex<Option<Sender<Msg>>>,
}

enum Msg {
    Out(Vec<u8>),
    Err(Vec<u8>),
    Cancelled,
}

impl Job {
    /// Stops the process now. Every later `run` with this job fails with `cancelled`.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().as_mut() {
            let _ = child.kill();
        }
        if let Some(tx) = self.wake.lock().as_ref() {
            let _ = tx.send(Msg::Cancelled);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    /// `None` when a signal stopped the process.
    pub code: Option<i32>,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// Starts `cmd`, writes `input` to its standard input, and waits for it.
/// A non-zero exit code is not an error here: the caller reads `Output`.
/// A missing program gives `missing_code` (for `gh`: `gh_missing`).
/// After `timeout` the process is killed and the error is `gh_error`.
pub fn run(
    mut cmd: Command,
    input: Option<&[u8]>,
    timeout: Duration,
    job: &Job,
    missing_code: &'static str,
    what: &str,
) -> Result<Output> {
    if job.is_cancelled() {
        return Err(Error::cancelled());
    }
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        ErrorKind::NotFound => Error::new(missing_code, format!("{what} is not installed or not in PATH")),
        _ => Error::from(e),
    })?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    if let Some(data) = input {
        // A thread writes the text, so a big input cannot block us.
        if let Some(mut stdin) = child.stdin.take() {
            let data = data.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            });
        }
    }
    let (tx, rx) = channel();
    {
        let mut slot = job.child.lock();
        if job.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::cancelled());
        }
        *slot = Some(child);
        *job.wake.lock() = Some(tx.clone());
    }
    let tx_err = tx.clone();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf);
        let _ = tx_err.send(Msg::Err(buf));
    });
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(16 * 1024);
        let _ = out.read_to_end(&mut buf);
        let _ = tx.send(Msg::Out(buf));
    });
    let deadline = Instant::now() + timeout;
    let mut stdout = None;
    let mut stderr = None;
    let mut timed_out = false;
    while stdout.is_none() || stderr.is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(Msg::Out(b)) => stdout = Some(b),
            Ok(Msg::Err(b)) => stderr = Some(b),
            Ok(Msg::Cancelled) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                timed_out = true;
                break;
            }
        }
    }
    *job.wake.lock() = None;
    let child = job.child.lock().take();
    if job.is_cancelled() || timed_out {
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        if job.is_cancelled() {
            return Err(Error::cancelled());
        }
        return Err(Error::new(codes::GH_ERROR, format!("{what} did not answer within {} s", timeout.as_secs())));
    }
    let code = child.and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
    let stdout = stdout.ok_or_else(|| Error::internal(format!("{what} output lost")))?;
    let stderr = stderr.unwrap_or_default();
    Ok(Output { stdout, stderr: String::from_utf8_lossy(&stderr).into_owned(), code })
}
