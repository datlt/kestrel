//! zsh integration: command line colors.
//!
//! Kestrel starts zsh with `ZDOTDIR` set to a folder it owns. zsh then reads the four
//! startup files of that folder (`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`) instead
//! of the files of the user. Each file runs the user's own file first, in the same
//! order zsh uses for a login shell that is interactive. The last lines of `.zshrc`
//! load a small highlighter and give `ZDOTDIR` back to the user. VS Code uses the
//! same trick for its shell integration.
//!
//! The scripts are real files in the `zsh` folder of this crate, so the dev bridge
//! (`scripts/dev-bridge.mjs`) can use the same files in browser tests.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// File name and content of each file in the folder, in the order zsh reads them.
pub const FILES: [(&str, &str); 5] = [
    (".zshenv", include_str!("../zsh/.zshenv")),
    (".zprofile", include_str!("../zsh/.zprofile")),
    (".zshrc", include_str!("../zsh/.zshrc")),
    (".zlogin", include_str!("../zsh/.zlogin")),
    ("kestrel-highlight.zsh", include_str!("../zsh/kestrel-highlight.zsh")),
];

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes the files into `dir` (the folder is created when it is missing). A file
/// that already has the right content is not written again. Other shells can start
/// at the same moment, so a new file is written under a temporary name and then
/// renamed. A reader never sees half a file.
pub fn install(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for (name, content) in FILES {
        let target = dir.join(name);
        if std::fs::read_to_string(&target).is_ok_and(|old| old == content) {
            continue;
        }
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
        std::fs::write(&temp, content)?;
        if let Err(e) = std::fs::rename(&temp, &target) {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    }
    Ok(())
}

/// True when `program` is zsh (`zsh`, `/bin/zsh`, `/opt/homebrew/bin/zsh`).
pub fn is_zsh(program: &str) -> bool {
    Path::new(program.trim()).file_name().and_then(|n| n.to_str()) == Some("zsh")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_zsh() {
        assert!(is_zsh("zsh"));
        assert!(is_zsh("/bin/zsh"));
        assert!(is_zsh("/opt/homebrew/bin/zsh"));
        assert!(!is_zsh("/bin/bash"));
        assert!(!is_zsh("/usr/bin/zshell"));
        assert!(!is_zsh(""));
    }

    #[test]
    fn install_writes_all_files_and_is_repeatable() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a").join("zsh");
        install(&target).unwrap();
        install(&target).unwrap();
        for (name, content) in FILES {
            assert_eq!(std::fs::read_to_string(target.join(name)).unwrap(), content, "{name}");
        }
        // No temporary file stays behind.
        let extra: Vec<_> = std::fs::read_dir(&target)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(extra.is_empty(), "{extra:?}");
    }

    #[test]
    fn install_replaces_an_old_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".zshrc"), "old").unwrap();
        install(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join(".zshrc")).unwrap(), FILES[2].1);
    }

    /// The files run the user's file first, and in the order of a login shell.
    #[test]
    fn each_file_sources_the_user_file_of_the_same_name() {
        for (name, content) in &FILES[..4] {
            let source = format!("builtin . \"$__kestrel_dir/{name}\"");
            assert!(content.contains(&source), "{name} must run the user's {name}");
            assert!(content.contains("KESTREL_USER_ZDOTDIR:-$HOME"), "{name} must fall back to HOME");
        }
    }

    #[test]
    fn zshrc_loads_the_highlighter_after_the_user_file_and_then_restores_zdotdir() {
        let rc = FILES[2].1;
        let user = rc.find("builtin . \"$__kestrel_dir/.zshrc\"").unwrap();
        let highlight = rc.find("kestrel-highlight.zsh\"").unwrap();
        let restore = rc.find("ZDOTDIR=$KESTREL_USER_ZDOTDIR").unwrap();
        let unset = rc.find("unset ZDOTDIR").unwrap();
        assert!(user < highlight && highlight < restore && highlight < unset);
        // Only .zshenv and .zprofile set ZDOTDIR back to the Kestrel folder.
        assert!(FILES[0].1.contains("ZDOTDIR=$KESTREL_ZDOTDIR"));
        assert!(FILES[1].1.contains("ZDOTDIR=$KESTREL_ZDOTDIR"));
    }
}
