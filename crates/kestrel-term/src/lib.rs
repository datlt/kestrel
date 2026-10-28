//! Pseudo terminal sessions for the Kestrel terminal panel.
//!
//! A `Session` runs a shell inside a PTY. A reader thread collects the output
//! and hands it to a callback in batches (about every 8 ms, or sooner when a
//! batch reaches 64 KB). A second thread waits for the shell to end and then
//! calls the exit callback. This crate does not know about Tauri.
//!
//! Output is raw bytes. The crate never decodes it, so a character that is cut
//! in two reads (3 or 4 bytes in UTF-8) reaches the frontend unchanged. The
//! frontend decodes the bytes as a stream. Input is a `&[u8]` that holds the UTF-8
//! text of the keys.

pub mod env;
pub mod zsh;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A batch is sent after this time, counted from its first byte.
const BATCH_INTERVAL: Duration = Duration::from_millis(8);
/// A batch is sent at once when it reaches this size.
const BATCH_MAX_BYTES: usize = 64 * 1024;
/// Size of one read from the PTY.
const READ_CHUNK: usize = 32 * 1024;
/// After the shell ends, wait this long for the last output before we report the exit.
const DRAIN_WAIT: Duration = Duration::from_millis(500);
/// After the first kill signal, wait this long before we send the hard kill.
const KILL_GRACE: Duration = Duration::from_millis(500);

pub type Error = String;
pub type Result<T> = std::result::Result<T, Error>;

/// A program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub struct SpawnOptions {
    pub command: ShellCommand,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// Extra environment variables (the login shell environment). They are added to
    /// the environment of the app. The terminal variables are set after them.
    pub env: Vec<(String, String)>,
    /// A folder made by `zsh::install`. When it is set and the shell is zsh, zsh
    /// starts with this folder as `ZDOTDIR` and loads the command line colors.
    pub zsh_dir: Option<PathBuf>,
}

/// Picks the shell program.
///
/// `setting` is the `terminal.shell` setting. Empty means the default:
/// `$SHELL -l` on macOS and Linux, PowerShell (or `COMSPEC`) on Windows.
/// `env_shell` is the value of `$SHELL` as the terminal will see it.
pub fn resolve_shell(setting: Option<&str>, env_shell: Option<&str>) -> ShellCommand {
    let setting = setting.map(str::trim).filter(|s| !s.is_empty());
    if let Some(s) = setting {
        // A path that exists as a whole (it may hold spaces) is the program itself.
        if std::path::Path::new(s).is_file() {
            return ShellCommand { program: s.to_string(), args: vec![] };
        }
        let mut parts = s.split_whitespace().map(str::to_string);
        let program = parts.next().unwrap_or_default();
        return ShellCommand { program, args: parts.collect() };
    }
    default_shell(env_shell)
}

#[cfg(unix)]
fn default_shell(env_shell: Option<&str>) -> ShellCommand {
    let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" };
    let program = env_shell.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback);
    ShellCommand { program: program.to_string(), args: vec!["-l".to_string()] }
}

#[cfg(windows)]
fn default_shell(_env_shell: Option<&str>) -> ShellCommand {
    let has_powershell = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join("powershell.exe").is_file()))
        .unwrap_or(false);
    let program = if has_powershell {
        "powershell.exe".to_string()
    } else {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    };
    ShellCommand { program, args: vec![] }
}

/// One running shell in a PTY. Dropping it kills the shell.
pub struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    exited: Arc<AtomicBool>,
}

impl Session {
    /// Starts the shell. `on_output` gets the raw bytes in batches, in order, from
    /// one thread. `on_exit` gets the exit code once, after the output is done.
    pub fn spawn(
        opts: SpawnOptions,
        on_output: impl Fn(Vec<u8>) + Send + 'static,
        on_exit: impl FnOnce(i32) + Send + 'static,
    ) -> Result<Session> {
        let pair = native_pty_system()
            .openpty(PtySize { rows: opts.rows.max(1), cols: opts.cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("cannot open a terminal: {e}"))?;

        let mut cmd = CommandBuilder::new(&opts.command.program);
        cmd.args(&opts.command.args);
        cmd.cwd(&opts.cwd);
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        // The shell gets the variables of the plan: terminal type, colors for `ls`,
        // a UTF-8 locale and the zsh folder (see `env::plan_env`).
        let zsh_dir = opts.zsh_dir.as_deref().filter(|_| zsh::is_zsh(&opts.command.program));
        let plan = {
            let get = |k: &str| cmd.get_env(k).and_then(|v| v.to_str()).map(str::to_string);
            env::plan_env(&get, &env::EnvInput { mac: cfg!(target_os = "macos"), zsh_dir })
        };
        for k in &plan.remove {
            cmd.env_remove(k);
        }
        for (k, v) in &plan.set {
            cmd.env(k, v);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("cannot start {}: {e}", opts.command.program))?;
        // The parent must close its copy of the slave side. Without this the reader
        // never sees the end of the output.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("cannot read the terminal: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("cannot write to the terminal: {e}"))?;

        // Reader thread: PTY -> channel. The channel is bounded, so a slow consumer
        // slows the shell down instead of using unlimited memory.
        let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<u8>>(64);
        std::thread::Builder::new()
            .name("term-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if chunk_tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        // On Linux the read fails with EIO when the shell has ended.
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("cannot start the reader thread: {e}"))?;

        // Batch thread: channel -> callback.
        let (done_tx, done_rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("term-batch".into())
            .spawn(move || {
                let mut batch: Vec<u8> = Vec::new();
                let mut started = Instant::now();
                loop {
                    let msg = if batch.is_empty() {
                        chunk_rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
                    } else {
                        chunk_rx.recv_timeout(BATCH_INTERVAL.saturating_sub(started.elapsed()))
                    };
                    match msg {
                        Ok(chunk) => {
                            if batch.is_empty() {
                                started = Instant::now();
                            }
                            batch.extend_from_slice(&chunk);
                            if batch.len() >= BATCH_MAX_BYTES || started.elapsed() >= BATCH_INTERVAL {
                                on_output(std::mem::take(&mut batch));
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => on_output(std::mem::take(&mut batch)),
                        Err(RecvTimeoutError::Disconnected) => {
                            if !batch.is_empty() {
                                on_output(std::mem::take(&mut batch));
                            }
                            break;
                        }
                    }
                }
                let _ = done_tx.send(());
            })
            .map_err(|e| format!("cannot start the batch thread: {e}"))?;

        // Wait thread: shell exit -> callback.
        let exited = Arc::new(AtomicBool::new(false));
        let exited_flag = exited.clone();
        std::thread::Builder::new()
            .name("term-wait".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.exit_code() as i32,
                    Err(_) => -1,
                };
                exited_flag.store(true, Ordering::SeqCst);
                // Let the last output reach the frontend before it hears about the exit.
                // A background job can keep the PTY open, so we do not wait for ever.
                let _ = done_rx.recv_timeout(DRAIN_WAIT);
                on_exit(code);
            })
            .map_err(|e| format!("cannot start the wait thread: {e}"))?;

        Ok(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            pid,
            exited,
        })
    }

    /// Sends bytes to the shell (keys typed by the user).
    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data).and_then(|_| w.flush()).map_err(|e| format!("cannot write to the terminal: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("cannot resize the terminal: {e}"))
    }

    /// True after the shell has ended.
    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Process id of the shell, if the system gave one.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Stops the shell and its child programs. On Unix it sends SIGHUP to the whole
    /// process group, and SIGKILL half a second later when something is still alive.
    /// It returns at once.
    pub fn kill(&self) {
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // The shell is the leader of its own session, so its group id is its pid.
            let pgid = pid as libc::pid_t;
            unsafe {
                libc::killpg(pgid, libc::SIGHUP);
            }
            std::thread::spawn(move || {
                std::thread::sleep(KILL_GRACE);
                // A program in the group can ignore SIGHUP. The shell may be gone
                // already, so we try the whole group. The call fails when the group is empty.
                unsafe {
                    libc::killpg(pgid, libc::SIGKILL);
                }
            });
            return;
        }
        let _ = self.killer.lock().kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    struct Run {
        session: Session,
        out: mpsc::Receiver<Vec<u8>>,
        exit: mpsc::Receiver<i32>,
    }

    fn start(script: &str) -> Run {
        start_with(script, vec![])
    }

    fn start_with(script: &str, env: Vec<(String, String)>) -> Run {
        let dir = tempfile::tempdir().unwrap();
        let (otx, out) = channel();
        let (etx, exit) = channel();
        let session = Session::spawn(
            SpawnOptions {
                command: ShellCommand { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()] },
                cwd: dir.keep(),
                cols: 80,
                rows: 24,
                env,
                zsh_dir: None,
            },
            move |b| {
                let _ = otx.send(b);
            },
            move |c| {
                let _ = etx.send(c);
            },
        )
        .unwrap();
        Run { session, out, exit }
    }

    fn collect(run: &Run, until_exit: bool) -> (String, Option<i32>) {
        let mut text = Vec::new();
        let mut code = None;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            while let Ok(b) = run.out.try_recv() {
                text.extend(b);
            }
            if let Ok(c) = run.exit.try_recv() {
                code = Some(c);
                while let Ok(b) = run.out.try_recv() {
                    text.extend(b);
                }
                break;
            }
            if !until_exit && !text.is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        (String::from_utf8_lossy(&text).into_owned(), code)
    }

    #[test]
    fn reads_output_and_exit_code() {
        let run = start("echo hello; exit 3");
        let (text, code) = collect(&run, true);
        assert!(text.contains("hello"), "output was {text:?}");
        assert_eq!(code, Some(3));
    }

    #[test]
    fn writes_input_to_the_shell() {
        let run = start("read line; echo got:$line");
        run.session.write(b"abc\n").unwrap();
        let (text, code) = collect(&run, true);
        assert!(text.contains("got:abc"), "output was {text:?}");
        assert_eq!(code, Some(0));
    }

    #[test]
    fn resize_changes_the_window_size() {
        let run = start("sleep 0.5; stty size");
        run.session.resize(100, 30).unwrap();
        let (text, _) = collect(&run, true);
        assert!(text.contains("30 100"), "output was {text:?}");
    }

    #[test]
    fn terminal_environment_is_set() {
        let run = start("echo $TERM/$COLORTERM/$TERM_PROGRAM");
        let (text, _) = collect(&run, true);
        assert!(text.contains("xterm-256color/truecolor/Kestrel"), "output was {text:?}");
    }

    #[test]
    fn kill_stops_the_shell_and_its_children() {
        let run = start("sleep 60 & echo child:$!; wait");
        let (text, _) = collect(&run, false);
        let child: i32 = text.split("child:").nth(1).unwrap().trim().split_whitespace().next().unwrap().parse().unwrap();
        run.session.kill();
        let (_, code) = collect(&run, true);
        assert!(code.is_some(), "the exit callback must run after kill");
        // The child can need a moment to disappear.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let alive = unsafe { libc::kill(child, 0) } == 0;
            if !alive {
                break;
            }
            assert!(Instant::now() < deadline, "child {child} is still alive");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn big_output_comes_in_order() {
        let run = start("i=0; while [ $i -lt 3000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done");
        let (text, code) = collect(&run, true);
        assert_eq!(code, Some(0));
        assert!(text.contains("line-0-"));
        assert!(text.contains("line-2999-"));
    }

    #[test]
    fn resolves_shell_setting() {
        assert_eq!(resolve_shell(Some("fish -l"), None), ShellCommand { program: "fish".into(), args: vec!["-l".into()] });
        let d = resolve_shell(Some("  "), Some("/bin/bash"));
        assert_eq!(d, ShellCommand { program: "/bin/bash".into(), args: vec!["-l".into()] });
        assert_eq!(resolve_shell(None, None).args, vec!["-l".to_string()]);
    }

    /// Output batches as the callback got them, until the shell ends.
    fn batches(run: &Run) -> Vec<Vec<u8>> {
        let mut all = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            while let Ok(b) = run.out.try_recv() {
                all.push(b);
            }
            if run.exit.try_recv().is_ok() {
                while let Ok(b) = run.out.try_recv() {
                    all.push(b);
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        all
    }

    /// A 3-byte character (U+65E5, bytes e6 97 a5) and a 4-byte character
    /// (U+1F600, bytes f0 9f 98 80) arrive in two reads each. The bytes must
    /// reach the frontend unchanged and in order. The frontend decodes them as a
    /// stream, so a cut inside a character is fine, but a changed byte is not.
    #[test]
    fn utf8_characters_split_across_reads_stay_unchanged() {
        let run = start(
            "printf '\\346\\227'; sleep 0.15; printf '\\245'; sleep 0.15; printf '\\360\\237'; sleep 0.15; printf '\\230\\200'; sleep 0.15; printf 'END'",
        );
        let parts = batches(&run);
        let all: Vec<u8> = parts.iter().flatten().copied().collect();
        let expected = "\u{65E5}\u{1F600}END".as_bytes();
        assert_eq!(all, expected, "batches were {parts:?}");
        // The sleeps are longer than the batch time, so a batch ends inside a character.
        assert!(parts.iter().any(|b| std::str::from_utf8(b).is_err()), "no batch was cut inside a character: {parts:?}");
        assert!(parts.len() >= 4, "batches were {parts:?}");
    }

    /// The PTY gets the UTF-8 bytes of what the user types: `ệ` (U+1EC7) is
    /// e1 bb 87 and `日` is e6 97 a5. `od` prints the bytes the program read.
    #[test]
    fn typed_text_reaches_the_pty_as_utf8_bytes() {
        let run = start("od -An -tx1 -N7");
        run.session.write("\u{1EC7}\u{65E5}\n".as_bytes()).unwrap();
        let (text, code) = collect(&run, true);
        let hex: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(hex.contains("e1 bb 87 e6 97 a5 0a"), "output was {text:?}");
        assert_eq!(code, Some(0));
    }

    fn var(k: &str, v: &str) -> (String, String) {
        (k.to_string(), v.to_string())
    }

    #[test]
    fn child_gets_a_utf8_locale_when_the_login_environment_has_lc_all_c() {
        let run = start_with(
            "echo ALL=[$LC_ALL] CT=[$LC_CTYPE] COLL=[$LC_COLLATE]",
            vec![var("LC_ALL", "C"), var("LC_CTYPE", ""), var("LC_COLLATE", ""), var("LANG", "C")],
        );
        let (text, _) = collect(&run, true);
        let want = if cfg!(target_os = "macos") { "UTF-8" } else { "en_US.UTF-8" };
        assert!(text.contains(&format!("ALL=[] CT=[{want}] COLL=[C]")), "output was {text:?}");
    }

    #[test]
    fn child_keeps_the_clicolor_of_the_user() {
        let run = start_with("echo CL=[$CLICOLOR]", vec![var("CLICOLOR", "0")]);
        let (text, _) = collect(&run, true);
        assert!(text.contains("CL=[0]"), "output was {text:?}");
    }
}
