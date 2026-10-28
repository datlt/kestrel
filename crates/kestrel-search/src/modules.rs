//! Finds the modules of a folder (the "Module" scope of find in files):
//! folders that hold a build file of Gradle, Maven, npm, SwiftPM, Cargo or Go.

use crate::walk::walker;
use kestrel_common::{Error, Result};
use ignore::WalkState;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Folders deeper than this below the root are not looked at.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum ModuleKind {
    Gradle,
    Maven,
    Npm,
    Swift,
    Cargo,
    Go,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchModule {
    /// Absolute folder of the module.
    pub path: String,
    pub name: String,
    pub kind: ModuleKind,
}

/// The kind for a build file name. The order of the list decides when one
/// folder has several build files: the first kind wins.
const BUILD_FILES: [(&str, ModuleKind); 7] = [
    ("build.gradle", ModuleKind::Gradle),
    ("build.gradle.kts", ModuleKind::Gradle),
    ("pom.xml", ModuleKind::Maven),
    ("package.json", ModuleKind::Npm),
    ("Package.swift", ModuleKind::Swift),
    ("Cargo.toml", ModuleKind::Cargo),
    ("go.mod", ModuleKind::Go),
];

/// Lists the modules under `root` (the root folder too), sorted by path.
/// Ignored folders (`.gitignore`) and `node_modules` are skipped.
pub fn search_modules(root: &Path) -> Result<Vec<SearchModule>> {
    if !root.is_dir() {
        return Err(Error::not_found(format!("not a folder: {}", root.display())));
    }
    let mut walk = walker(root);
    // A file in a folder at depth 6 has depth 7.
    walk.max_depth(Some(MAX_DEPTH + 1));
    walk.filter_entry(|e| e.file_name() != ".git" && e.file_name() != "node_modules");

    // Folder -> index of the best build file seen so far.
    let found: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());
    walk.build_parallel().run(|| {
        let found = &found;
        Box::new(move |res| {
            let Ok(entry) = res else { return WalkState::Continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                return WalkState::Continue;
            }
            let Some(name) = entry.file_name().to_str() else { return WalkState::Continue };
            let Some(rank) = BUILD_FILES.iter().position(|(n, _)| *n == name) else { return WalkState::Continue };
            let Some(dir) = entry.path().parent() else { return WalkState::Continue };
            let mut map = found.lock();
            let slot = map.entry(dir.to_path_buf()).or_insert(rank);
            if rank < *slot {
                *slot = rank;
            }
            WalkState::Continue
        })
    });
    let found = found.into_inner();

    let mut out: Vec<SearchModule> = found
        .into_iter()
        .map(|(dir, rank)| {
            let (file, kind) = BUILD_FILES[rank];
            let name = module_name(root, &dir, file, kind).unwrap_or_else(|| folder_name(&dir));
            SearchModule { path: dir.to_string_lossy().into_owned(), name, kind }
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn folder_name(dir: &Path) -> String {
    dir.file_name().map_or_else(|| dir.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned())
}

/// The name from the build file. `None` when there is none, then the caller
/// uses the folder name.
fn module_name(root: &Path, dir: &Path, file: &str, kind: ModuleKind) -> Option<String> {
    let name = match kind {
        ModuleKind::Gradle => {
            if dir != root {
                return None;
            }
            ["settings.gradle", "settings.gradle.kts"]
                .iter()
                .find_map(|f| std::fs::read_to_string(dir.join(f)).ok().and_then(|t| gradle_root_name(&t)))
        }
        ModuleKind::Maven => maven_artifact_id(&std::fs::read_to_string(dir.join(file)).ok()?),
        ModuleKind::Npm => {
            let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join(file)).ok()?).ok()?;
            v.get("name")?.as_str().map(str::to_owned)
        }
        ModuleKind::Swift => swift_package_name(&std::fs::read_to_string(dir.join(file)).ok()?),
        ModuleKind::Cargo => cargo_package_name(&std::fs::read_to_string(dir.join(file)).ok()?),
        ModuleKind::Go => go_module(&std::fs::read_to_string(dir.join(file)).ok()?),
    }?;
    let name = name.trim().to_owned();
    if name.is_empty() { None } else { Some(name) }
}

/// The text of the quoted string at the start of `s` (after white space).
fn quoted(s: &str) -> Option<String> {
    let s = s.trim_start();
    let q = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let rest = &s[1..];
    let end = rest.find(q)?;
    Some(rest[..end].to_owned())
}

/// `rootProject.name = "x"` in settings.gradle or settings.gradle.kts.
fn gradle_root_name(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("rootProject.name") {
            if let Some(v) = rest.trim_start().strip_prefix('=') {
                return quoted(v);
            }
        }
    }
    None
}

/// The first `<artifactId>` that is a direct child of `<project>`. The one
/// inside `<parent>` or `<dependency>` is deeper and does not count.
fn maven_artifact_id(text: &str) -> Option<String> {
    let mut depth = 0usize;
    let mut i = 0;
    while let Some(off) = text[i..].find('<') {
        let at = i + off;
        let rest = &text[at..];
        if rest.starts_with("<!--") {
            i = at + rest.find("-->").map_or(rest.len(), |e| e + 3);
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            i = at + rest.find("]]>").map_or(rest.len(), |e| e + 3);
            continue;
        }
        let Some(close) = rest.find('>') else { break };
        let tag = &rest[1..close];
        i = at + close + 1;
        if tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        if tag.starts_with('/') {
            depth = depth.saturating_sub(1);
            continue;
        }
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        if name == "artifactId" && depth == 1 && !tag.ends_with('/') {
            let end = text[i..].find('<')?;
            return Some(text[i..i + end].to_owned());
        }
        if !tag.ends_with('/') {
            depth += 1;
        }
    }
    None
}

/// `Package(name: "x", ...)` in Package.swift.
fn swift_package_name(text: &str) -> Option<String> {
    let rest = &text[text.find("Package(")? + "Package(".len()..];
    let after = &rest[rest.find("name:")? + "name:".len()..];
    quoted(after)
}

/// `name = "x"` in the `[package]` table of Cargo.toml.
fn cargo_package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line.trim_end() == "[package]";
        } else if in_package {
            if let Some(rest) = line.strip_prefix("name") {
                if let Some(v) = rest.trim_start().strip_prefix('=') {
                    return quoted(v);
                }
            }
        }
    }
    None
}

/// The path after `module` in go.mod.
fn go_module(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("module") {
            if !rest.starts_with(char::is_whitespace) {
                continue;
            }
            let rest = rest.trim();
            return quoted(rest).or_else(|| rest.split_whitespace().next().map(str::to_owned));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn summary(root: &Path) -> Vec<(String, String, ModuleKind)> {
        search_modules(root)
            .unwrap()
            .into_iter()
            .map(|m| (m.path.strip_prefix(root.to_str().unwrap()).unwrap().to_owned(), m.name, m.kind))
            .collect()
    }

    #[test]
    fn every_build_file_kind_with_its_name() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "settings.gradle.kts", "// x\nrootProject.name = \"my-app\"\ninclude(\":core\")\n");
        write(r, "build.gradle.kts", "plugins {}\n");
        write(r, "core/build.gradle", "apply plugin: 'java'\n");
        write(
            r,
            "mvn/pom.xml",
            "<?xml version=\"1.0\"?>\n<project>\n<!-- <artifactId>wrong</artifactId> -->\n<parent><artifactId>par</artifactId></parent>\n<artifactId>mvn-app</artifactId>\n<dependencies><dependency><artifactId>dep</artifactId></dependency></dependencies>\n</project>\n",
        );
        write(r, "web/package.json", "{\"scripts\": {\"name\": \"no\"}, \"name\": \"@x/web\"}");
        write(r, "web2/package.json", "{ broken");
        write(r, "ios/Package.swift", "// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(\n    name: \"IosKit\",\n    targets: [.target(name: \"Other\")]\n)\n");
        write(r, "rs/Cargo.toml", "[workspace]\n[package]\nversion = \"1\"\nname = \"rs-crate\"\n[dependencies]\nname = \"no\"\n");
        write(r, "gocode/go.mod", "module github.com/acme/tool\n\ngo 1.22\n");
        let got = summary(r);
        let want = vec![
            ("", "my-app", ModuleKind::Gradle),
            ("/core", "core", ModuleKind::Gradle),
            ("/gocode", "github.com/acme/tool", ModuleKind::Go),
            ("/ios", "IosKit", ModuleKind::Swift),
            ("/mvn", "mvn-app", ModuleKind::Maven),
            ("/rs", "rs-crate", ModuleKind::Cargo),
            ("/web", "@x/web", ModuleKind::Npm),
            ("/web2", "web2", ModuleKind::Npm),
        ];
        let want: Vec<_> = want.into_iter().map(|(p, n, k)| (p.to_owned(), n.to_owned(), k)).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn root_without_settings_uses_the_folder_name() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "build.gradle", "");
        let m = search_modules(d.path()).unwrap();
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, d.path().file_name().unwrap().to_str().unwrap());
    }

    #[test]
    fn ignored_folders_and_node_modules_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, ".gitignore", "generated/\n");
        write(r, "generated/package.json", "{\"name\":\"g\"}");
        write(r, "node_modules/dep/package.json", "{\"name\":\"dep\"}");
        write(r, "app/node_modules/dep/package.json", "{\"name\":\"dep\"}");
        write(r, ".git/x/Cargo.toml", "");
        write(r, "app/package.json", "{\"name\":\"app\"}");
        let got = summary(r);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1, "app");
    }

    #[test]
    fn depth_limit_is_six_levels_below_the_root() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "a/b/c/d/e/f/go.mod", "module six\n");
        write(r, "a/b/c/d/e/f/g/go.mod", "module seven\n");
        let got = summary(r);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1, "six");
    }

    #[test]
    fn one_entry_per_folder_and_sorted() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(r, "z/package.json", "{\"name\":\"z\"}");
        write(r, "z/Cargo.toml", "[package]\nname = \"zc\"\n");
        write(r, "a/pom.xml", "<project><artifactId>a</artifactId></project>");
        write(r, "a/build.gradle", "");
        let got = summary(r);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].0.as_str(), got[0].2), ("/a", ModuleKind::Gradle));
        assert_eq!((got[1].0.as_str(), got[1].2), ("/z", ModuleKind::Npm));
    }

    #[test]
    fn missing_root_is_an_error() {
        let err = search_modules(Path::new("/definitely/not/here")).unwrap_err();
        assert_eq!(err.code(), "not_found");
    }
}
