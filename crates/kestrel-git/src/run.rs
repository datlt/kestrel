//! Runs the `git` program. Every call is a child process. A `Job` lets
//! another thread kill that process (used to cancel old status runs).

use kestrel_common::error::codes;
use kestrel_common::{process, Error, Result};
use parking_lot::Mutex;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct Job {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
    /// Wakes `run` when the job is cancelled, even if a grandchild process
    /// of git still holds the output pipes open.
    wake: Mutex<Option<Sender<Msg>>>,
}

enum Msg {
    Out(std::io::Result<Vec<u8>>),
    Err(Vec<u8>),
    Cancelled,
}

impl Job {
    /// Stops the git process now. Every later `run` with this job fails with `cancelled`.
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

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    /// `None` when the process was stopped by a signal.
    pub code: Option<i32>,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// Runs `git -c core.quotepath=off <args>` in `root` and waits for it.
/// A non-zero exit code is not an error here: the caller reads `Output`.
pub fn run(root: &Path, args: &[&str], job: &Job) -> Result<Output> {
    run_input(root, args, job, None)
}

/// Like `run`, and writes `input` to the standard input of git.
pub fn run_input(root: &Path, args: &[&str], job: &Job, input: Option<&[u8]>) -> Result<Output> {
    if !root.is_dir() {
        return Err(Error::not_found(format!("folder not found: {}", root.display())));
    }
    let mut cmd = process::command("git");
    cmd.current_dir(root)
        .args(["-c", "core.quotepath=off"])
        .args(args)
        // Do not take index.lock for a read: the user may run git at the same time.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Stable messages, so we can detect "not a git repository".
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        ErrorKind::NotFound => Error::new(codes::GIT_MISSING, "git is not installed or not in PATH"),
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
    // Both pipes are read in threads, so a full pipe can never block git.
    let tx_err = tx.clone();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf);
        let _ = tx_err.send(Msg::Err(buf));
    });
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(16 * 1024);
        let r = out.read_to_end(&mut buf).map(|_| buf);
        let _ = tx.send(Msg::Out(r));
    });
    let mut stdout = None;
    let mut stderr = None;
    while stdout.is_none() || stderr.is_none() {
        match rx.recv() {
            Ok(Msg::Out(r)) => stdout = Some(r),
            Ok(Msg::Err(b)) => stderr = Some(b),
            Ok(Msg::Cancelled) | Err(_) => break,
        }
    }
    *job.wake.lock() = None;
    let child = job.child.lock().take();
    if job.is_cancelled() {
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        return Err(Error::cancelled());
    }
    let code = child.and_then(|mut c| c.wait().ok()).and_then(|s| s.code());
    let stdout = stdout.ok_or_else(|| Error::internal("git output lost"))??;
    let stderr = stderr.unwrap_or_default();
    Ok(Output { stdout, stderr: String::from_utf8_lossy(&stderr).into_owned(), code })
}

/// Turns a failed `Output` into an error with the right code.
pub fn failure(out: &Output) -> Error {
    let msg = out.stderr.trim();
    if msg.contains("not a git repository") {
        return Error::new(codes::NOT_A_REPO, "not a git repository");
    }
    let msg = if msg.is_empty() { format!("git exited with code {:?}", out.code) } else { msg.to_string() };
    Error::new(codes::IO, msg)
}

/// Runs git and returns stdout when it succeeds.
pub fn run_ok(root: &Path, args: &[&str], job: &Job) -> Result<Vec<u8>> {
    let out = run(root, args, job)?;
    if out.ok() { Ok(out.stdout) } else { Err(failure(&out)) }
}
