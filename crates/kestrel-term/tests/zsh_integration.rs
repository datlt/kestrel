//! Starts a real `zsh` in a PTY with the Kestrel ZDOTDIR folder and a temporary
//! HOME. The tests never read the dotfiles of the person who runs them. They are
//! skipped when zsh is not installed.

#![cfg(unix)]

use kestrel_term::{zsh, Session, ShellCommand, SpawnOptions};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

fn find_zsh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join("zsh")).find(|p| p.is_file())
}

struct Zsh {
    session: Session,
    out: Receiver<Vec<u8>>,
    seen: String,
    _home: tempfile::TempDir,
}

/// `files` are written into the temporary HOME. `env` is added to the environment
/// (`$HOME` in a value becomes the temporary HOME). `highlight` false starts zsh
/// without the Kestrel folder.
fn start(zsh_path: &Path, files: &[(&str, &str)], env: &[(&str, &str)], highlight: bool) -> Zsh {
    let home = tempfile::tempdir().unwrap();
    let home_text = home.path().to_string_lossy().into_owned();
    for (name, content) in files {
        let file = home.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
    let zdir = tempfile::tempdir().unwrap().keep();
    zsh::install(&zdir).unwrap();
    let mut vars = vec![
        ("HOME".to_string(), home_text.clone()),
        ("LANG".to_string(), "en_US.UTF-8".to_string()),
        // An empty value counts as not set. This keeps the ZDOTDIR of the developer out.
        ("ZDOTDIR".to_string(), String::new()),
    ];
    for (k, v) in env {
        vars.retain(|(key, _)| key != k);
        vars.push((k.to_string(), v.replace("$HOME", &home_text)));
    }
    let (tx, out) = channel();
    let session = Session::spawn(
        SpawnOptions {
            command: ShellCommand { program: zsh_path.to_string_lossy().into_owned(), args: vec!["-l".into()] },
            cwd: home.path().to_path_buf(),
            cols: 120,
            rows: 24,
            env: vars,
            zsh_dir: highlight.then_some(zdir),
        },
        move |b| {
            let _ = tx.send(b);
        },
        |_| {},
    )
    .unwrap();
    Zsh { session, out, seen: String::new(), _home: home }
}

impl Zsh {
    /// Waits until the output has `needle`. Returns the output from the needle on
    /// and forgets what came before.
    fn wait_for(&mut self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            while let Ok(b) = self.out.try_recv() {
                self.seen.push_str(&String::from_utf8_lossy(&b));
            }
            if let Some(i) = self.seen.find(needle) {
                let rest = self.seen[i..].to_string();
                self.seen.clear();
                return rest;
            }
            assert!(Instant::now() < deadline, "did not see {needle:?}. Output was {:?}", self.seen);
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn send(&self, text: &str) {
        self.session.write(text.as_bytes()).unwrap();
    }

    /// Runs one command line and returns the output from `marker` on.
    fn run(&mut self, line: &str, marker: &str) -> String {
        self.send(&format!("{line}\r"));
        self.wait_for(marker)
    }

    /// Types `line`, runs the `dump` widget of the test .zshrc (Ctrl-x Ctrl-d) and
    /// returns the `region_highlight` entries without the memo tag.
    fn region_highlight(&mut self, line: &str) -> Vec<String> {
        self.send("\u{15}"); // Ctrl-u clears the line
        self.send(line);
        std::thread::sleep(Duration::from_millis(200));
        self.send("\u{18}\u{4}");
        let mut text = self.wait_for("RH:");
        if !text.contains(":END") {
            text.push_str(&self.wait_for(":END"));
        }
        let body = text.trim_start_matches("RH:").split(":END").next().unwrap_or("").to_string();
        body.split('|')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.replace("memo=kestrel", "").replace(',', "").trim().to_string())
            .collect()
    }
}

const USER_RC: &str = "PS1='PROMPT> '\nexport K_RC=1\n";

/// The startup files of the user run in zsh order and ZDOTDIR is given back.
#[test]
fn user_files_run_in_order_and_zdotdir_is_restored() {
    let Some(zsh_path) = find_zsh() else {
        eprintln!("zsh is not installed, test skipped");
        return;
    };
    let mut z = start(
        &zsh_path,
        &[
            (".zshenv", "export K_ORDER=env\n"),
            (".zprofile", "export K_ORDER=${K_ORDER}-profile\n"),
            (".zshrc", "PS1='PROMPT> '\nexport K_ORDER=${K_ORDER}-rc\nexport K_RC=1\n"),
            (".zlogin", "export K_ORDER=${K_ORDER}-login\n"),
        ],
        &[],
        true,
    );
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_ORDER:${ZDOTDIR-unset}:${+functions[__kestrel_hl]}:$KESTREL_ZDOTDIR:""#, "R:env");
    assert!(text.starts_with("R:env-profile-rc-login:unset:1::"), "output was {text:?}");
}

/// The shell history stays in the folder of the user. On macOS `/etc/zshrc` sets
/// HISTFILE from ZDOTDIR, and ZDOTDIR is the Kestrel folder at that moment.
#[test]
fn histfile_is_not_in_the_kestrel_folder() {
    let Some(zsh_path) = find_zsh() else { return };
    let mut z = start(&zsh_path, &[(".zshrc", USER_RC)], &[], true);
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "H:${HISTFILE}|$HOME|E""#, "H:/");
    let mut parts = text.trim_start_matches("H:").split('|');
    let hist = parts.next().unwrap();
    let home = parts.next().unwrap();
    assert!(hist.starts_with(home), "HISTFILE {hist} must be inside HOME {home}");
}

/// The user has their own ZDOTDIR (set in the environment).
#[test]
fn user_zdotdir_from_the_environment_is_used_and_restored() {
    let Some(zsh_path) = find_zsh() else { return };
    let mut z = start(
        &zsh_path,
        &[("zd/.zshrc", USER_RC), (".zshrc", "export K_WRONG=home\n")],
        &[("ZDOTDIR", "$HOME/zd")],
        true,
    );
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_RC:${K_WRONG-none}:${ZDOTDIR##*/}:${+functions[__kestrel_hl]}:""#, "R:1");
    assert!(text.starts_with("R:1:none:zd:1:"), "output was {text:?}");
}

/// A common setup: `~/.zshenv` sets ZDOTDIR and the other files live there.
#[test]
fn zdotdir_set_inside_zshenv_is_followed() {
    let Some(zsh_path) = find_zsh() else { return };
    let mut z = start(&zsh_path, &[(".zshenv", "export ZDOTDIR=$HOME/cfg\n"), ("cfg/.zshrc", USER_RC)], &[], true);
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_RC:${ZDOTDIR##*/}:${+functions[__kestrel_hl]}:""#, "R:1");
    assert!(text.starts_with("R:1:cfg:1:"), "output was {text:?}");
}

/// A broken .zshrc must not stop the shell. The error shows as usual and the
/// colors still load.
#[test]
fn broken_user_zshrc_still_starts_the_shell() {
    let Some(zsh_path) = find_zsh() else { return };
    let rc = "PS1='PROMPT> '\nexport K_BEFORE=1\nnot_a_command_xyz\nif then fi fi ((\nexport K_AFTER=1\n";
    let mut z = start(&zsh_path, &[(".zshrc", rc)], &[], true);
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_BEFORE:${ZDOTDIR-unset}:${+functions[__kestrel_hl]}:""#, "R:1");
    assert!(text.starts_with("R:1:unset:1:"), "output was {text:?}");
}

/// A .zshrc that ends early with `return` after a failing command is fine too.
#[test]
fn user_zshrc_with_return_still_gets_the_highlighter() {
    let Some(zsh_path) = find_zsh() else { return };
    let rc = "PS1='PROMPT> '\nexport K_RC=1\nfalse\nreturn 3\nexport K_LATE=1\n";
    let mut z = start(&zsh_path, &[(".zshrc", rc)], &[], true);
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_RC:${K_LATE-none}:${+functions[__kestrel_hl]}:""#, "R:1");
    assert!(text.starts_with("R:1:none:1:"), "output was {text:?}");
}

/// No ZDOTDIR trick when the Kestrel folder is not given (setting off). zsh reads
/// the files of the user as always and the highlighter does not load.
#[test]
fn without_the_kestrel_folder_zsh_is_untouched() {
    let Some(zsh_path) = find_zsh() else { return };
    // An empty ZDOTDIR would make zsh look in "/", so the test names the folder.
    let mut z = start(&zsh_path, &[(".zshrc", USER_RC)], &[("ZDOTDIR", "$HOME")], false);
    z.wait_for("PROMPT> ");
    let text = z.run(r#"echo "R:$K_RC:${ZDOTDIR:t}:${+functions[__kestrel_hl]}:${KESTREL_ZDOTDIR-none}:""#, "R:1");
    let home = z._home.path().file_name().unwrap().to_string_lossy().into_owned();
    assert!(text.starts_with(&format!("R:1:{home}:0:none:")), "output was {text:?}");
}

/// The highlighter stays out when the user loads zsh-syntax-highlighting
/// (`ZSH_HIGHLIGHT_VERSION`, `_zsh_highlight`) or fast-syntax-highlighting.
#[test]
fn other_highlighters_win() {
    let Some(zsh_path) = find_zsh() else { return };
    for rc in [
        "PS1='PROMPT> '\nZSH_HIGHLIGHT_VERSION=5.9\n",
        "PS1='PROMPT> '\n_zsh_highlight() { :; }\n",
        "PS1='PROMPT> '\nFAST_HIGHLIGHT_VERSION=1.5\n",
    ] {
        let mut z = start(&zsh_path, &[(".zshrc", rc)], &[], true);
        z.wait_for("PROMPT> ");
        let text = z.run(r#"echo "R:${+functions[__kestrel_hl]}:""#, "R:0:");
        assert!(text.starts_with("R:0:"), "rc {rc:?}: output was {text:?}");
    }
}

/// `region_highlight` support loads without errors, and the entries are right.
#[test]
fn highlighter_sets_region_highlight() {
    let Some(zsh_path) = find_zsh() else { return };
    let rc = "PS1='PROMPT> '\n\
              dump() { print -r -- \"RH:${(j:|:)region_highlight}:END\"; zle redisplay }\n\
              zle -N dump\n\
              bindkey '^X^D' dump\n\
              setopt interactive_comments\n";
    let mut z = start(&zsh_path, &[(".zshrc", rc)], &[], true);
    let first = z.wait_for("PROMPT> ");
    assert!(!first.contains("error") && !first.contains("not found"), "startup printed an error: {first:?}");

    let e = z.region_highlight(r#"echo -n "hi" $HOME 'x' # note"#);
    assert_eq!(
        e,
        ["0 4 fg=green", "5 7 fg=cyan", "8 12 fg=yellow", "13 18 fg=magenta", "19 22 fg=yellow", "23 29 fg=8"],
        "entries were {e:?}"
    );

    let e = z.region_highlight("zzz_no_such_cmd_1 --flag | cat > out.txt && ls");
    assert_eq!(e, ["0 17 fg=red", "18 24 fg=cyan", "27 30 fg=green", "44 46 fg=green"], "entries were {e:?}");

    // Words with characters that are special in math (`!!`, `[`, `$((`) once
    // printed "bad math expression" on every key. They must give no output.
    let e = z.region_highlight("!! | xxd | head -2");
    assert_eq!(e, ["0 2 fg=red", "5 8 fg=green", "11 15 fg=green", "16 18 fg=cyan"], "entries were {e:?}");
    let e = z.region_highlight("[ -n x ] && a[1]=2 echo");
    assert!(!e.is_empty(), "entries were {e:?}");
}
