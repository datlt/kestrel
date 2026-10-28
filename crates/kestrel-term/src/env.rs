//! The environment of the shell. This module only decides which variables to set.
//! `Session::spawn` applies the result. The functions are pure, so tests can run them.

use std::path::Path;

/// Variables to set and to remove, on top of the environment the shell would get.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EnvPlan {
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

impl EnvPlan {
    fn set(&mut self, key: &str, value: impl Into<String>) {
        self.remove.retain(|k| k != key);
        self.set.retain(|(k, _)| k != key);
        self.set.push((key.to_string(), value.into()));
    }

    fn remove(&mut self, key: &str) {
        self.set.retain(|(k, _)| k != key);
        if !self.remove.iter().any(|k| k == key) {
            self.remove.push(key.to_string());
        }
    }

    /// The value this plan sets for `key`, if any.
    pub fn value(&self, key: &str) -> Option<&str> {
        self.set.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// What the plan needs to know about the shell.
pub struct EnvInput<'a> {
    /// True on macOS. There the locale name `UTF-8` exists.
    pub mac: bool,
    /// The Kestrel folder with the zsh startup files, when zsh should load the
    /// command line colors. `None` leaves zsh alone.
    pub zsh_dir: Option<&'a Path>,
}

fn non_empty(get: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key).filter(|v| !v.trim().is_empty())
}

/// True when a locale name such as `en_US.UTF-8` or `C.utf8` uses UTF-8.
pub fn is_utf8_locale(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("utf-8") || n.contains("utf8")
}

/// Plans the variables for the terminal. `get` reads a variable of the environment
/// the shell would start with (the app environment plus the login shell environment).
pub fn plan_env(get: &dyn Fn(&str) -> Option<String>, input: &EnvInput) -> EnvPlan {
    let mut plan = EnvPlan::default();
    plan.set("TERM", "xterm-256color");
    plan.set("COLORTERM", "truecolor");
    plan.set("TERM_PROGRAM", "Kestrel");

    // BSD `ls` on macOS shows colors only when CLICOLOR is set. A value the user
    // has already (even `0`) stays.
    if get("CLICOLOR").is_none() {
        plan.set("CLICOLOR", "1");
    }

    plan_locale(get, input.mac, &mut plan);

    // The Kestrel ZDOTDIR for zsh. `KESTREL_USER_ZDOTDIR` is the ZDOTDIR of the
    // user. It is empty when the user has none, and then zsh files come from HOME.
    if let Some(dir) = input.zsh_dir {
        let dir = dir.to_string_lossy().into_owned();
        match non_empty(get, "ZDOTDIR").filter(|z| *z != dir) {
            Some(user) => plan.set("KESTREL_USER_ZDOTDIR", user),
            None => plan.remove("KESTREL_USER_ZDOTDIR"),
        }
        plan.set("ZDOTDIR", dir.clone());
        plan.set("KESTREL_ZDOTDIR", dir);
        plan.set("KESTREL_HIGHLIGHT", "1");
    }
    plan
}

/// The shell needs a UTF-8 locale for Vietnamese and Japanese text. Programs such
/// as zsh and readline cut a multi-byte character into single bytes when the
/// locale is not UTF-8: the cursor moves by byte, Backspace deletes half a
/// character and the line editor prints `<ffffffe1>` for the pieces.
///
/// The effective character set comes from `LC_ALL`, then `LC_CTYPE`, then `LANG`.
/// - Nothing is set (an app that starts from the Dock has no `LANG`): set `LANG`.
/// - It is UTF-8: change nothing.
/// - It is not (`LANG=C`, `LC_ALL=POSIX`, `en_US.ISO8859-1`): set `LC_CTYPE` to
///   UTF-8. `LC_ALL` would override `LC_CTYPE`, so a non-UTF-8 `LC_ALL` is removed
///   and its value moves to the other categories (sorting and messages stay as the
///   user wants them, for example `LC_ALL=C` for a fast `sort`).
fn plan_locale(get: &dyn Fn(&str) -> Option<String>, mac: bool, plan: &mut EnvPlan) {
    let all = non_empty(get, "LC_ALL");
    let ctype = non_empty(get, "LC_CTYPE");
    let lang = non_empty(get, "LANG");
    let effective = all.clone().or_else(|| ctype.clone()).or_else(|| lang.clone());
    let Some(effective) = effective else {
        plan.set("LANG", "en_US.UTF-8");
        return;
    };
    if is_utf8_locale(&effective) {
        return;
    }
    plan.set("LC_CTYPE", if mac { "UTF-8" } else { "en_US.UTF-8" });
    if let Some(all) = all {
        plan.remove("LC_ALL");
        for key in ["LC_COLLATE", "LC_MESSAGES", "LC_NUMERIC", "LC_TIME", "LC_MONETARY"] {
            if non_empty(get, key).is_none() {
                plan.set(key, all.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn plan_with(vars: &[(&str, &str)], mac: bool, zsh_dir: Option<&Path>) -> EnvPlan {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        plan_env(&|k| map.get(k).cloned(), &EnvInput { mac, zsh_dir })
    }

    #[test]
    fn sets_terminal_variables() {
        let p = plan_with(&[("LANG", "en_US.UTF-8")], true, None);
        assert_eq!(p.value("TERM"), Some("xterm-256color"));
        assert_eq!(p.value("COLORTERM"), Some("truecolor"));
        assert_eq!(p.value("TERM_PROGRAM"), Some("Kestrel"));
    }

    #[test]
    fn clicolor_is_set_only_when_missing() {
        assert_eq!(plan_with(&[], true, None).value("CLICOLOR"), Some("1"));
        assert_eq!(plan_with(&[("CLICOLOR", "0")], true, None).value("CLICOLOR"), None);
        assert_eq!(plan_with(&[("CLICOLOR", "1")], true, None).value("CLICOLOR"), None);
        assert!(plan_with(&[("CLICOLOR", "0")], true, None).remove.is_empty());
    }

    #[test]
    fn missing_locale_gets_lang() {
        let p = plan_with(&[], true, None);
        assert_eq!(p.value("LANG"), Some("en_US.UTF-8"));
        assert_eq!(p.value("LC_CTYPE"), None);
        // Empty values count as missing.
        let p = plan_with(&[("LANG", ""), ("LC_ALL", " ")], true, None);
        assert_eq!(p.value("LANG"), Some("en_US.UTF-8"));
    }

    #[test]
    fn utf8_locale_stays() {
        for vars in [
            vec![("LANG", "en_US.UTF-8")],
            vec![("LANG", "ja_JP.utf8")],
            vec![("LC_ALL", "vi_VN.UTF-8")],
            vec![("LANG", "C"), ("LC_CTYPE", "en_US.UTF-8")],
            vec![("LANG", "C"), ("LC_ALL", "C.UTF-8")],
        ] {
            let p = plan_with(&vars, true, None);
            assert_eq!(p.value("LANG"), None, "{vars:?}");
            assert_eq!(p.value("LC_CTYPE"), None, "{vars:?}");
            assert!(p.remove.is_empty(), "{vars:?}");
        }
    }

    #[test]
    fn lang_c_gets_a_utf8_ctype() {
        let p = plan_with(&[("LANG", "C")], true, None);
        assert_eq!(p.value("LC_CTYPE"), Some("UTF-8"));
        assert!(p.remove.is_empty());
        let p = plan_with(&[("LANG", "POSIX")], false, None);
        assert_eq!(p.value("LC_CTYPE"), Some("en_US.UTF-8"));
        let p = plan_with(&[("LANG", "en_US.ISO8859-1")], true, None);
        assert_eq!(p.value("LC_CTYPE"), Some("UTF-8"));
    }

    #[test]
    fn a_non_utf8_ctype_is_replaced() {
        let p = plan_with(&[("LANG", "en_US.UTF-8"), ("LC_CTYPE", "C")], true, None);
        // LC_CTYPE wins over LANG, so LC_CTYPE must change.
        assert_eq!(p.value("LC_CTYPE"), Some("UTF-8"));
    }

    #[test]
    fn lc_all_c_is_removed_and_moved_to_other_categories() {
        let p = plan_with(&[("LC_ALL", "C"), ("LC_TIME", "ja_JP.UTF-8")], true, None);
        assert_eq!(p.remove, vec!["LC_ALL".to_string()]);
        assert_eq!(p.value("LC_CTYPE"), Some("UTF-8"));
        assert_eq!(p.value("LC_COLLATE"), Some("C"));
        assert_eq!(p.value("LC_MESSAGES"), Some("C"));
        // A category the user set stays.
        assert_eq!(p.value("LC_TIME"), None);
    }

    #[test]
    fn zsh_dir_sets_zdotdir_and_remembers_the_user_value() {
        let dir = PathBuf::from("/cache/kestrel/zsh");
        let p = plan_with(&[("LANG", "en_US.UTF-8")], true, Some(&dir));
        assert_eq!(p.value("ZDOTDIR"), Some("/cache/kestrel/zsh"));
        assert_eq!(p.value("KESTREL_ZDOTDIR"), Some("/cache/kestrel/zsh"));
        assert_eq!(p.value("KESTREL_HIGHLIGHT"), Some("1"));
        assert_eq!(p.value("KESTREL_USER_ZDOTDIR"), None);
        assert!(p.remove.contains(&"KESTREL_USER_ZDOTDIR".to_string()));

        let p = plan_with(&[("LANG", "en_US.UTF-8"), ("ZDOTDIR", "/home/me/.config/zsh")], true, Some(&dir));
        assert_eq!(p.value("KESTREL_USER_ZDOTDIR"), Some("/home/me/.config/zsh"));
        assert_eq!(p.value("ZDOTDIR"), Some("/cache/kestrel/zsh"));
    }

    #[test]
    fn without_zsh_dir_zdotdir_is_not_touched() {
        let p = plan_with(&[("ZDOTDIR", "/home/me/.config/zsh")], true, None);
        assert_eq!(p.value("ZDOTDIR"), None);
        assert_eq!(p.value("KESTREL_ZDOTDIR"), None);
        assert!(!p.remove.contains(&"ZDOTDIR".to_string()));
    }
}
