//! Start child processes (git, language servers) with the user's real environment.
//!
//! On macOS and Linux, an app started from the Dock or a desktop launcher does
//! not get the PATH from the user's shell profile (`~/.zshrc`, `~/.profile`).
//! Then tools installed by Homebrew, SDKMAN or nvm are not found. At startup we
//! run the login shell once, read its environment, and use it for every child
//! process. On Windows the app already has the full environment.

use parking_lot::{Condvar, Mutex};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

type Env = Vec<(OsString, OsString)>;

struct EnvSlot {
    value: Mutex<Option<Env>>,
    ready: Condvar,
}

fn slot() -> &'static EnvSlot {
    static SLOT: OnceLock<EnvSlot> = OnceLock::new();
    SLOT.get_or_init(|| EnvSlot { value: Mutex::new(None), ready: Condvar::new() })
}

/// Starts reading the login shell environment in a background thread.
/// Call it once, early in `main`. It does not block.
pub fn init_shell_env() {
    std::thread::Builder::new()
        .name("shell-env".into())
        .spawn(|| {
            let env = resolve_shell_env().unwrap_or_default();
            let s = slot();
            *s.value.lock() = Some(env);
            s.ready.notify_all();
        })
        .ok();
}

/// Environment variables to add to child processes. Waits at most 5 seconds
/// for `init_shell_env` to finish. Empty when the shell could not be read
/// (then children inherit the app environment as usual).
pub fn shell_env() -> Env {
    let s = slot();
    let mut guard = s.value.lock();
    let deadline = Instant::now() + Duration::from_secs(5);
    while guard.is_none() {
        if s.ready.wait_until(&mut guard, deadline).timed_out() {
            break;
        }
    }
    guard.clone().unwrap_or_default()
}

/// The PATH that child processes will get.
pub fn search_path() -> Option<OsString> {
    shell_env()
        .into_iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v)
        .or_else(|| std::env::var_os("PATH"))
}

/// Finds a program in the PATH that child processes will get.
pub fn find_program(name: &str) -> Option<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    which::which_in(name, search_path(), cwd).ok()
}

/// A `std::process::Command` with the shell environment applied. On Windows it
/// also sets `CREATE_NO_WINDOW`, so no console window flashes on the screen.
/// stdin is closed by default. Convert it with `tokio::process::Command::from`
/// when you need async.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let program = program.as_ref();
    // Resolve bare names with our PATH, because Command uses the app PATH.
    let resolved = program
        .to_str()
        .filter(|p| !p.contains('/') && !p.contains('\\'))
        .and_then(find_program)
        .map(OsString::from)
        .unwrap_or_else(|| program.to_os_string());
    let mut cmd = Command::new(resolved);
    for (k, v) in shell_env() {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(windows)]
fn resolve_shell_env() -> Option<Env> {
    None
}

#[cfg(unix)]
fn resolve_shell_env() -> Option<Env> {
    // Started from a terminal: the environment is already complete.
    if std::env::var_os("TERM_PROGRAM").is_some() || std::env::var_os("KESTREL_SKIP_SHELL_ENV").is_some() {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
    });
    run_shell_for_env(&shell)
}

#[cfg(unix)]
fn run_shell_for_env(shell: &str) -> Option<Env> {
    use std::io::Read;

    const START: &str = "__KESTREL_ENV_START__";
    const END: &str = "__KESTREL_ENV_END__";
    let script = format!("printf '%s' '{START}'; /usr/bin/env; printf '%s' '{END}'");
    let mut child = Command::new(shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Read stdout in a thread. If we only waited for the exit, a big environment
    // (more than the pipe size, 64 KB on Linux) would block the shell on write and
    // we would hit the timeout.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    // Some shell profiles hang (prompts, slow plugins). Give up after 4 seconds.
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("reading the login shell environment timed out");
                return None;
            }
        }
    }
    // A background process from the profile can keep the pipe open after the shell exits.
    // Do not wait for it for long.
    let out = String::from_utf8_lossy(&rx.recv_timeout(Duration::from_secs(1)).ok()?).into_owned();
    let body = out.split_once(START)?.1.split_once(END)?.0;
    Some(parse_env(body))
}

#[cfg(unix)]
fn parse_env(body: &str) -> Env {
    const SKIP: [&str; 5] = ["_", "PWD", "OLDPWD", "SHLVL", "PS1"];
    body.lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(k, _)| !k.is_empty() && !SKIP.contains(k) && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn big_environment_does_not_block_the_shell() {
        use std::os::unix::fs::PermissionsExt;
        // A fake shell that prints about 300 KB. A pipe holds 64 KB or less, so the
        // shell can only finish when we read its output while it runs.
        let dir = tempfile::tempdir().unwrap();
        let sh = dir.path().join("fake-shell");
        std::fs::write(
            &sh,
            "#!/bin/sh\nprintf '%s' '__KESTREL_ENV_START__'\ni=0\nwhile [ $i -lt 3000 ]; do\n  echo \"VAR_$i=$(printf 'x%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100)\"\n  i=$((i+1))\ndone\nprintf '%s' '__KESTREL_ENV_END__'\n",
        )
        .unwrap();
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755)).unwrap();
        let env = run_shell_for_env(sh.to_str().unwrap()).expect("environment must be read");
        assert_eq!(env.len(), 3000);
    }

    #[test]
    fn parses_env_lines() {
        let env = parse_env("PATH=/usr/bin:/bin\nHOME=/Users/me\n_=/usr/bin/env\ncontinued line\nA_B=x=y\n");
        let keys: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
        assert_eq!(keys, vec!["PATH", "HOME", "A_B"]);
        assert_eq!(env[2].1, "x=y");
    }
}
