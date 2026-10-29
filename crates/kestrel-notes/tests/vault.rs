//! Tests on the fixture vault in `tests/fixtures/vault` and on copies of it.

use kestrel_notes::{NoteGraph, NoteManager, NoteNodeKind, ResolvedLink};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

fn fixture() -> String {
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/vault").to_owned()
}

fn graph_of(root: &str) -> NoteGraph {
    NoteManager::new().graph("t", root, &AtomicBool::new(false)).unwrap()
}

fn node(g: &NoteGraph, rel: &str) -> usize {
    g.data.nodes.iter().position(|n| n.rel == rel).unwrap_or_else(|| panic!("no node {rel}"))
}

fn has_node(g: &NoteGraph, rel: &str) -> bool {
    g.data.nodes.iter().any(|n| n.rel == rel)
}

/// True when a note (not a missing node) has this path.
fn has_note(g: &NoteGraph, rel: &str) -> bool {
    g.data.nodes.iter().any(|n| n.rel == rel && n.kind == NoteNodeKind::Note)
}

/// (count, embeds, line) of the link between two nodes, when there is one.
fn link(g: &NoteGraph, from: &str, to: &str) -> Option<(u32, u32, u32)> {
    let (f, t) = (node(g, from) as u32, node(g, to) as u32);
    g.data.links.iter().find(|l| l.from == f && l.to == t).map(|l| (l.count, l.embeds, l.line))
}

fn out_degree(g: &NoteGraph, from: &str) -> usize {
    let f = node(g, from) as u32;
    g.data.links.iter().filter(|l| l.from == f).count()
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

fn copy_of_fixture() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("vault");
    copy_dir(Path::new(&fixture()), &root);
    // `normalize` resolves symlinks (/var is /private/var on macOS).
    let root = kestrel_common::paths::normalize(&root);
    (d, root)
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn abs(root: &Path, rel: &str) -> String {
    root.join(rel).to_string_lossy().into_owned()
}

// --- Walk -----------------------------------------------------------------------

#[test]
fn walk_skips_hidden_folders_node_modules_and_gitignored() {
    let g = graph_of(&fixture());
    for rel in [".obsidian/Hidden.md", ".trash/Gone.md", "node_modules/pkg/Readme.md", "private/Secret.md"] {
        assert!(!has_node(&g, rel), "{rel} must not be in the graph");
    }
    assert!(has_node(&g, "notes/Alpha.md"));
}

#[test]
fn nodes_are_sorted_notes_then_attachments_then_missing() {
    let g = graph_of(&fixture());
    let kinds: Vec<_> = g.data.nodes.iter().map(|n| n.kind).collect();
    let first_att = kinds.iter().position(|k| *k == NoteNodeKind::Attachment).unwrap();
    let first_miss = kinds.iter().position(|k| *k == NoteNodeKind::Missing).unwrap();
    assert!(first_att < first_miss);
    assert!(kinds[..first_att].iter().all(|k| *k == NoteNodeKind::Note));
    assert!(kinds[first_att..first_miss].iter().all(|k| *k == NoteNodeKind::Attachment));
    assert!(kinds[first_miss..].iter().all(|k| *k == NoteNodeKind::Missing));
    for part in [&g.data.nodes[..first_att], &g.data.nodes[first_att..first_miss], &g.data.nodes[first_miss..]] {
        assert!(part.windows(2).all(|w| w[0].rel <= w[1].rel));
    }
}

#[test]
fn links_are_sorted_unique_and_never_self() {
    let g = graph_of(&fixture());
    assert!(g.data.links.windows(2).all(|w| (w[0].from, w[0].to) < (w[1].from, w[1].to)));
    for l in &g.data.links {
        assert_ne!(l.from, l.to);
        assert_eq!(g.data.nodes[l.from as usize].kind, NoteNodeKind::Note);
        assert!(l.count >= 1 && l.embeds <= l.count && l.line >= 1);
    }
}

#[test]
fn node_fields() {
    let g = graph_of(&fixture());
    let i = &g.data.nodes[node(&g, "Index.md")];
    assert_eq!(i.kind, NoteNodeKind::Note);
    assert_eq!(i.name, "Index");
    assert_eq!(i.title.as_deref(), Some("Home Page"));
    assert_eq!(i.tags, ["home", "area/main", "index", "project/kestrel", "日本語"]);
    assert_eq!(i.aliases, ["Start", "Landing"]);
    assert_eq!(i.path, format!("{}/Index.md", g.data.root));
    assert!(i.size > 0 && i.mtime_ms > 0);
    let a = &g.data.nodes[node(&g, "assets/logo.png")];
    assert_eq!((a.kind, a.name.as_str(), a.title.clone()), (NoteNodeKind::Attachment, "logo.png", None));
    assert!(a.size > 0 && a.mtime_ms > 0);
    let m = &g.data.nodes[node(&g, "notes/Does Not Exist.md")];
    assert_eq!((m.kind, m.size, m.mtime_ms), (NoteNodeKind::Missing, 0, 0));
    assert_eq!(m.name, "Does Not Exist");
    assert_eq!(m.path, format!("{}/notes/Does Not Exist.md", g.data.root));
}

#[test]
fn json_shape_matches_the_contract() {
    let g = graph_of(&fixture());
    let v = serde_json::to_value(&g).unwrap();
    let mut keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["elapsedMs", "links", "nodes", "root", "truncated"]);
    let n = &v["nodes"][0];
    let mut keys: Vec<_> = n.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["aliases", "kind", "mtimeMs", "name", "path", "rel", "size", "tags", "title"]);
    assert_eq!(n["kind"], "note");
    let l = &v["links"][0];
    let mut keys: Vec<_> = l.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["count", "embeds", "from", "line", "to"]);
    let none = serde_json::to_value(NoteManager::new().status(&fixture())).unwrap();
    assert_eq!(none, serde_json::json!({ "state": "none", "notes": 0, "files": 0, "buildMs": 0 }));
    let r = ResolvedLink { path: "p".into(), exists: false, kind: NoteNodeKind::Missing, heading: None, block: true };
    assert_eq!(
        serde_json::to_value(r).unwrap(),
        serde_json::json!({ "path": "p", "exists": false, "kind": "missing", "heading": null, "block": true })
    );
}

// --- Resolution -----------------------------------------------------------------

#[test]
fn wiki_links_alias_heading_block_embed() {
    let g = graph_of(&fixture());
    // Alpha -> Beta three times: plain, #Part, #^block1.
    assert_eq!(link(&g, "notes/Alpha.md", "notes/Beta.md").map(|l| l.0), Some(3));
    // Index -> Alpha: `[[Alpha]]` and the embed `![[Alpha#Intro]]`.
    assert_eq!(link(&g, "Index.md", "notes/Alpha.md"), Some((2, 1, 10)));
    assert_eq!(link(&g, "Index.md", "notes/Beta.md"), Some((1, 0, 10)));
    assert_eq!(link(&g, "Index.md", "assets/logo.png"), Some((1, 1, 11)));
}

#[test]
fn self_links_heading_links_and_alias_to_self_are_dropped() {
    let g = graph_of(&fixture());
    // Index has [[#Welcome]], [[Index]] and [[Start]] (its own alias).
    assert_eq!(out_degree(&g, "Index.md"), 3);
    assert_eq!(out_degree(&g, "Tiếng Việt/Ghi chú.md"), 1);
}

#[test]
fn case_differences_resolve() {
    let g = graph_of(&fixture());
    // `[[ALPHA]]` and `[[alpha]]`.
    assert_eq!(link(&g, "Top.md", "notes/Alpha.md").map(|l| l.0), Some(2));
    assert!(!has_node(&g, "ALPHA.md"));
    // `Logo.PNG` finds `logo.png`.
    assert_eq!(link(&g, "with space/My Note.md", "assets/logo.png").map(|l| (l.0, l.1)), Some((2, 2)));
}

#[test]
fn same_name_tie_rules() {
    let g = graph_of(&fixture());
    // Same folder wins.
    assert!(link(&g, "projects/a/Linker.md", "projects/a/Same.md").is_some());
    assert!(link(&g, "projects/a/Linker.md", "projects/b/Same.md").is_none());
    assert!(link(&g, "projects/b/Linker2.md", "projects/b/Same.md").is_some());
    assert!(link(&g, "projects/b/Linker2.md", "projects/a/Same.md").is_none());
    // No folder in common: same length, so the first by path.
    assert!(link(&g, "Top.md", "projects/a/Same.md").is_some());
    assert!(link(&g, "Top.md", "projects/b/Same.md").is_none());
    // A path in the target picks the file.
    assert!(link(&g, "projects/Deep.md", "projects/a/Same.md").is_some());
    assert!(link(&g, "projects/Deep.md", "projects/b/Same.md").is_some());
}

#[test]
fn aliases_resolve_and_names_win_over_aliases() {
    let (_d, root) = copy_of_fixture();
    write(&root, "Uses Alias.md", "[[Landing]] and [[b]] and [[Beta]]\n");
    let g = graph_of(root.to_str().unwrap());
    assert!(link(&g, "Uses Alias.md", "Index.md").is_some());
    assert_eq!(link(&g, "Uses Alias.md", "notes/Beta.md").map(|l| l.0), Some(2));
    // A note named like an alias of another note wins.
    write(&root, "Landing.md", "# Real landing\n");
    let g = graph_of(root.to_str().unwrap());
    assert!(link(&g, "Uses Alias.md", "Landing.md").is_some());
    assert!(link(&g, "Uses Alias.md", "Index.md").is_none());
}

#[test]
fn markdown_links_forms() {
    let g = graph_of(&fixture());
    let from = "with space/My Note.md";
    assert_eq!(link(&g, from, "notes/Alpha.md").map(|l| l.0), Some(4));
    assert_eq!(link(&g, from, "notes/Beta.md").map(|l| l.0), Some(2));
    assert!(link(&g, from, "Tiếng Việt/Ghi chú.md").is_some());
    // 11 raw links, external ones and the folder are dropped.
    assert_eq!(out_degree(&g, from), 6);
}

#[test]
fn percent_encoding_and_non_ascii_names() {
    let g = graph_of(&fixture());
    assert!(link(&g, "日本語/ノート.md", "with space/My Note.md").is_some());
    assert!(link(&g, "日本語/ノート.md", "日本語/ノート2.md").is_some());
    assert!(link(&g, "日本語/ノート.md", "Tiếng Việt/Ghi chú.md").is_some());
    assert!(link(&g, "Tiếng Việt/Ghi chú.md", "日本語/ノート.md").is_some());
}

#[test]
fn decomposed_names_match_composed_links() {
    let (_d, root) = copy_of_fixture();
    // The file name is decomposed (as macOS can store it). The link is composed.
    write(&root, "Ghi chu\u{0301}.md", "# decomposed\n");
    write(&root, "Caller.md", "[[Ghi chú]] and [x](Ghi%20ch%C3%BA.md)\n");
    let g = graph_of(root.to_str().unwrap());
    assert!(link(&g, "Caller.md", "Tiếng Việt/Ghi chú.md").is_some() || link(&g, "Caller.md", "Ghi chu\u{0301}.md").is_some());
    assert!(!g.data.nodes.iter().any(|n| n.kind == NoteNodeKind::Missing && n.name.starts_with("Ghi")));
}

#[test]
fn reference_definitions_make_links() {
    let g = graph_of(&fixture());
    assert_eq!(link(&g, "refs.md", "notes/Alpha.md"), Some((1, 0, 3)));
    assert_eq!(link(&g, "refs.md", "with space/My Note.md"), Some((1, 0, 4)));
    // The footnote text has a wiki link to Beta.
    assert_eq!(link(&g, "refs.md", "notes/Beta.md"), Some((1, 0, 6)));
    assert_eq!(out_degree(&g, "refs.md"), 3);
}

#[test]
fn code_comments_and_math_hide_links() {
    let g = graph_of(&fixture());
    let targets: Vec<&str> = g
        .data
        .links
        .iter()
        .filter(|l| g.data.nodes[l.from as usize].rel == "code.md")
        .map(|l| g.data.nodes[l.to as usize].name.as_str())
        .collect();
    let mut sorted = targets.clone();
    sorted.sort();
    assert_eq!(sorted, ["Alpha", "Real2", "Real3", "Real4", "Real5", "Real6", "Real7", "Real8"]);
    assert!(!g.data.nodes.iter().any(|n| n.name.starts_with("Hidden")));
}

#[test]
fn unclosed_fence_in_a_real_file() {
    let g = graph_of(&fixture());
    assert_eq!(out_degree(&g, "unclosed.md"), 1);
    assert!(has_node(&g, "Before.md"));
    assert!(!has_node(&g, "Inside fence.md"));
}

#[test]
fn targets_outside_the_root_and_folders_are_ignored() {
    let g = graph_of(&fixture());
    // outside.md: only `[[./Index]]` is a link.
    assert_eq!(out_degree(&g, "outside.md"), 1);
    assert!(link(&g, "outside.md", "Index.md").is_some());
    assert!(!g.data.nodes.iter().any(|n| n.rel.contains("..") || n.rel.contains("passwd") || n.name == "x"));
    // `[q](../notes)` and `[[notes]]` point to a folder.
    assert!(!has_node(&g, "notes.md"));
    assert!(!has_node(&g, "notes"));
}

#[test]
fn missing_nodes_paths_and_merging() {
    let g = graph_of(&fixture());
    // Bare wiki link: the folder of the first note that links to it.
    assert!(has_node(&g, "notes/Does Not Exist.md"));
    // Wiki link with a folder: from the root.
    assert!(has_node(&g, "new/Sub Folder Note.md"));
    // Markdown links: the joined path, with `.md` added.
    assert!(has_node(&g, "missing/Nothing.md"));
    assert!(has_node(&g, "with space/nothing.md"));
    let missing = g.data.nodes.iter().filter(|n| n.kind == NoteNodeKind::Missing && n.name == "Real2").count();
    assert_eq!(missing, 1);
}

#[test]
fn bare_missing_links_merge_by_name_first_note_by_path_decides() {
    let (_d, root) = copy_of_fixture();
    write(&root, "zz/Later.md", "[[Shared Idea]]\n");
    write(&root, "aa/First.md", "[[shared idea]]\n");
    write(&root, "mm/Middle.md", "[[SHARED IDEA]] [[Shared Idea]]\n");
    let g = graph_of(root.to_str().unwrap());
    let nodes: Vec<_> = g.data.nodes.iter().filter(|n| n.kind == NoteNodeKind::Missing && n.name.eq_ignore_ascii_case("shared idea")).collect();
    assert_eq!(nodes.len(), 1);
    assert_eq!(nodes[0].rel, "aa/shared idea.md");
    for from in ["zz/Later.md", "aa/First.md", "mm/Middle.md"] {
        assert!(link(&g, from, "aa/shared idea.md").is_some(), "{from}");
    }
    assert_eq!(link(&g, "mm/Middle.md", "aa/shared idea.md").map(|l| l.0), Some(2));
}

#[test]
fn path_missing_links_merge_by_lower_case_path() {
    let (_d, root) = copy_of_fixture();
    write(&root, "A1.md", "[x](Gone/File.md) [[Gone/File]]\n");
    write(&root, "A2.md", "[x](gone/file.md)\n");
    let g = graph_of(root.to_str().unwrap());
    let n: Vec<_> = g.data.nodes.iter().filter(|n| n.kind == NoteNodeKind::Missing && n.rel.to_lowercase() == "gone/file.md").collect();
    assert_eq!(n.len(), 1);
}

#[test]
fn missing_target_that_exists_in_another_case_resolves() {
    let (_d, root) = copy_of_fixture();
    write(&root, "C1.md", "[x](NOTES/alpha.MD)\n");
    let g = graph_of(root.to_str().unwrap());
    assert!(link(&g, "C1.md", "notes/Alpha.md").is_some());
}

#[test]
fn attachments_only_when_linked() {
    let g = graph_of(&fixture());
    assert!(has_node(&g, "assets/logo.png"));
    assert!(!has_node(&g, "docs/spec.pdf"));
    let (_d, root) = copy_of_fixture();
    write(&root, "Pdf.md", "[[spec.pdf]] and [s](docs/spec.pdf) and ![[docs/spec.pdf]]\n");
    let g = graph_of(root.to_str().unwrap());
    assert_eq!(link(&g, "Pdf.md", "docs/spec.pdf"), Some((3, 1, 1)));
    assert_eq!(g.data.nodes[node(&g, "docs/spec.pdf")].kind, NoteNodeKind::Attachment);
}

#[test]
fn non_utf8_note_is_read_lossy() {
    let g = graph_of(&fixture());
    assert!(link(&g, "latin/Latin1.md", "notes/Alpha.md").is_some());
    assert!(g.data.nodes[node(&g, "latin/Latin1.md")].title.as_deref().unwrap().starts_with("Caf"));
}

#[test]
fn crlf_and_bom_note() {
    let g = graph_of(&fixture());
    let n = &g.data.nodes[node(&g, "Crlf.md")];
    assert_eq!(n.title.as_deref(), Some("Crlf Note"));
    assert_eq!(n.tags, ["crlf", "crlftag"]);
    assert_eq!(link(&g, "Crlf.md", "notes/Alpha.md").map(|l| l.2), Some(7));
}

#[test]
fn big_note_is_a_node_without_links() {
    let (_d, root) = copy_of_fixture();
    let mut text = String::from("# Big\n[[Alpha]]\n");
    text.push_str(&"x".repeat(5 * 1024 * 1024 + 10));
    write(&root, "Big.md", &text);
    let g = graph_of(root.to_str().unwrap());
    let n = &g.data.nodes[node(&g, "Big.md")];
    assert_eq!(n.title, None);
    assert!(n.size > 5 * 1024 * 1024);
    assert_eq!(out_degree(&g, "Big.md"), 0);
}

#[test]
fn markdown_extensions() {
    let (_d, root) = copy_of_fixture();
    write(&root, "x/Page.mdx", "[[Alpha]]\n");
    write(&root, "x/Other.markdown", "[[Page]] and [[Other.markdown]]\n");
    write(&root, "x/Upper.MD", "[[Page.mdx]]\n");
    let g = graph_of(root.to_str().unwrap());
    assert_eq!(g.data.nodes[node(&g, "x/Page.mdx")].name, "Page");
    assert!(link(&g, "x/Other.markdown", "x/Page.mdx").is_some());
    assert!(link(&g, "x/Upper.MD", "x/Page.mdx").is_some());
    assert_eq!(out_degree(&g, "x/Other.markdown"), 1);
}

#[test]
fn build_and_graph_on_empty_and_missing_roots() {
    let d = tempfile::tempdir().unwrap();
    let g = graph_of(d.path().to_str().unwrap());
    assert!(g.data.nodes.is_empty() && g.data.links.is_empty() && !g.data.truncated);
    let err = NoteManager::new().graph("t", "/definitely/not/here", &AtomicBool::new(false)).unwrap_err();
    assert_eq!(err.code(), "not_found");
}

#[test]
fn note_cap_sets_truncated_and_keeps_the_first_by_path() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path();
    for i in 0..(kestrel_notes::MAX_NOTES + 5) {
        fs::write(root.join(format!("n{i:06}.md")), "x").unwrap();
    }
    let g = graph_of(root.to_str().unwrap());
    assert!(g.data.truncated);
    assert_eq!(g.data.nodes.len(), kestrel_notes::MAX_NOTES);
    assert_eq!(g.data.nodes[0].rel, "n000000.md");
    assert_eq!(g.data.nodes.last().unwrap().rel, format!("n{:06}.md", kestrel_notes::MAX_NOTES - 1));
}

// --- Manager and updates ----------------------------------------------------------

#[test]
fn status_follows_the_build() {
    let m = NoteManager::new();
    let root = fixture();
    assert_eq!(serde_json::to_value(m.status(&root)).unwrap()["state"], "none");
    m.graph("w1", &root, &AtomicBool::new(false)).unwrap();
    let st = m.status(&root);
    assert_eq!(serde_json::to_value(&st).unwrap()["state"], "ready");
    assert!(st.notes >= 18);
    assert!(st.files >= 2);
}

#[test]
fn owners_drop_and_window_destroyed() {
    let m = NoteManager::new();
    let root = fixture();
    m.graph("w1", &root, &AtomicBool::new(false)).unwrap();
    m.graph("w2", &root, &AtomicBool::new(false)).unwrap();
    assert_eq!(m.root_count(), 1);
    m.drop_root("w1", &root);
    assert_eq!(m.root_count(), 1);
    m.drop_root("w2", &root);
    assert_eq!(m.root_count(), 0);
    m.graph("w3", &root, &AtomicBool::new(false)).unwrap();
    m.window_destroyed("w3");
    assert_eq!(m.root_count(), 0);
}

#[test]
fn cancelled_request_fails_with_cancelled() {
    let m = NoteManager::new();
    let err = m.graph("t", &fixture(), &AtomicBool::new(true)).unwrap_err();
    assert_eq!(err.code(), "cancelled");
    // The root can still build afterwards.
    assert!(m.graph("t", &fixture(), &AtomicBool::new(false)).is_ok());
}

#[test]
fn the_graph_is_cached_until_the_next_change() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    let a = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    let b = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(std::sync::Arc::ptr_eq(&a.data, &b.data));
    write(&root, "New.md", "[[Alpha]]");
    m.update(r, &[abs(&root, "New.md")], false).unwrap();
    let c = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(!std::sync::Arc::ptr_eq(&a.data, &c.data));
}

#[test]
fn update_does_nothing_before_the_first_build() {
    let (_d, root) = copy_of_fixture();
    let m = NoteManager::new();
    m.update(root.to_str().unwrap(), &[abs(&root, "x.md")], false).unwrap();
    assert_eq!(serde_json::to_value(m.status(root.to_str().unwrap())).unwrap()["state"], "none");
}

#[test]
fn update_changed_note_rereads_links_title_tags() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    m.graph("t", r, &AtomicBool::new(false)).unwrap();
    write(&root, "Top.md", "---\ntitle: New Top\ntags: [fresh]\n---\n[[Index]]\n");
    m.update(r, &[abs(&root, "Top.md")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    let n = &g.data.nodes[node(&g, "Top.md")];
    assert_eq!(n.title.as_deref(), Some("New Top"));
    assert_eq!(n.tags, ["fresh"]);
    assert!(link(&g, "Top.md", "Index.md").is_some());
    assert!(link(&g, "Top.md", "notes/Alpha.md").is_none());
}

#[test]
fn update_added_note_resolves_a_missing_link_and_deleted_note_makes_it_missing() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(has_node(&g, "notes/Does Not Exist.md"));
    // Create the note somewhere else: the bare link finds it by name.
    write(&root, "elsewhere/Does Not Exist.md", "# Now it exists\n");
    m.update(r, &[abs(&root, "elsewhere/Does Not Exist.md")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(!has_node(&g, "notes/Does Not Exist.md"));
    assert!(link(&g, "notes/Alpha.md", "elsewhere/Does Not Exist.md").is_some());
    // Delete it again.
    fs::remove_file(root.join("elsewhere/Does Not Exist.md")).unwrap();
    m.update(r, &[abs(&root, "elsewhere/Does Not Exist.md")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(has_node(&g, "notes/Does Not Exist.md"));
    assert!(!has_node(&g, "elsewhere/Does Not Exist.md"));
}

#[test]
fn update_rename_moves_the_node() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    m.graph("t", r, &AtomicBool::new(false)).unwrap();
    fs::create_dir_all(root.join("moved")).unwrap();
    fs::rename(root.join("notes/Beta.md"), root.join("moved/Beta.md")).unwrap();
    m.update(r, &[abs(&root, "notes/Beta.md"), abs(&root, "moved/Beta.md")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    // Links with the old path stay as missing nodes.
    assert!(!has_note(&g, "notes/Beta.md"));
    assert!(link(&g, "notes/Alpha.md", "moved/Beta.md").is_some());
}

#[test]
fn update_folder_events() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    m.graph("t", r, &AtomicBool::new(false)).unwrap();
    // A whole folder is renamed: the watcher reports the folders.
    fs::rename(root.join("projects"), root.join("work")).unwrap();
    m.update(r, &[abs(&root, "projects"), abs(&root, "work")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(!g.data.nodes.iter().any(|n| n.rel.starts_with("projects/") && n.kind == NoteNodeKind::Note));
    assert!(has_node(&g, "work/a/Same.md"));
    assert!(link(&g, "work/a/Linker.md", "work/a/Same.md").is_some());
    // A folder is deleted.
    fs::remove_dir_all(root.join("work")).unwrap();
    m.update(r, &[abs(&root, "work")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(!g.data.nodes.iter().any(|n| n.rel.starts_with("work/") && n.kind == NoteNodeKind::Note));
}

#[test]
fn update_new_attachment_resolves_a_link() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    write(&root, "Pic.md", "![[new.png]]\n");
    let m = NoteManager::new();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert_eq!(g.data.nodes[node(&g, "new.png")].kind, NoteNodeKind::Missing);
    write(&root, "assets/new.png", "png");
    m.update(r, &[abs(&root, "assets/new.png")], false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert_eq!(link(&g, "Pic.md", "assets/new.png"), Some((1, 1, 1)));
}

#[test]
fn update_ignores_hidden_and_ignored_paths() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    let before = m.graph("t", r, &AtomicBool::new(false)).unwrap().data.nodes.len();
    write(&root, ".obsidian/Plugin.md", "[[Alpha]]");
    write(&root, "private/More.md", "[[Alpha]]");
    write(&root, "node_modules/x/Y.md", "[[Alpha]]");
    let paths: Vec<_> = [".obsidian/Plugin.md", "private/More.md", "node_modules/x/Y.md", "../outside.md"].iter().map(|p| abs(&root, p)).collect();
    m.update(r, &paths, false).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert_eq!(g.data.nodes.len(), before);
}

#[test]
fn update_rescan_finds_everything_and_keeps_unchanged_notes() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    m.graph("t", r, &AtomicBool::new(false)).unwrap();
    write(&root, "Late.md", "[[Alpha]]");
    fs::remove_file(root.join("Top.md")).unwrap();
    m.update(r, &[], true).unwrap();
    let g = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    assert!(has_node(&g, "Late.md"));
    assert!(!has_node(&g, "Top.md"));
}

#[test]
fn update_equals_a_fresh_build() {
    let (_d, root) = copy_of_fixture();
    let r = root.to_str().unwrap();
    let m = NoteManager::new();
    m.graph("t", r, &AtomicBool::new(false)).unwrap();
    write(&root, "N1.md", "# N1\n[[N2]] [[Alpha]] #t1");
    write(&root, "N2.md", "---\naliases: [Two]\n---\n[[N1]]");
    write(&root, "N3.md", "[[Two]] [x](N1.md)");
    fs::remove_file(root.join("notes/Beta.md")).unwrap();
    let paths: Vec<_> = ["N1.md", "N2.md", "N3.md", "notes/Beta.md"].iter().map(|p| abs(&root, p)).collect();
    m.update(r, &paths, false).unwrap();
    let a = m.graph("t", r, &AtomicBool::new(false)).unwrap();
    let b = graph_of(r);
    assert_eq!(serde_json::to_value(&a.data.nodes).unwrap(), serde_json::to_value(&b.data.nodes).unwrap());
    assert_eq!(a.data.links, b.data.links);
}

// --- notes_resolve ----------------------------------------------------------------

fn resolve(m: &NoteManager, root: &str, from: &str, target: &str, wiki: bool) -> Option<ResolvedLink> {
    m.resolve("t", root, &format!("{root}/{from}"), target, wiki).unwrap()
}

#[test]
fn resolve_wiki_targets() {
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root = root.to_str().unwrap();
    let m = NoteManager::new();
    let r = resolve(&m, root, "Index.md", "Alpha", true).unwrap();
    assert_eq!((r.path.as_str(), r.exists, r.kind, r.heading.clone(), r.block), (format!("{root}/notes/Alpha.md").as_str(), true, NoteNodeKind::Note, None, false));
    let r = resolve(&m, root, "Index.md", "Alpha#Intro|shown", true).unwrap();
    assert_eq!((r.heading.as_deref(), r.block), (Some("Intro"), false));
    let r = resolve(&m, root, "Index.md", "notes/Beta#^abc123", true).unwrap();
    assert_eq!((r.heading.as_deref(), r.block, r.exists), (Some("abc123"), true, true));
    let r = resolve(&m, root, "Index.md", "logo.png", true).unwrap();
    assert_eq!((r.kind, r.exists), (NoteNodeKind::Attachment, true));
    let r = resolve(&m, root, "Index.md", "ALPHA", true).unwrap();
    assert!(r.exists && r.path.ends_with("notes/Alpha.md"));
    let r = resolve(&m, root, "Index.md", "Start", true).unwrap();
    assert!(r.exists && r.path.ends_with("/Index.md"));
}

#[test]
fn resolve_tie_uses_the_folder_of_the_note() {
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root = root.to_str().unwrap();
    let m = NoteManager::new();
    assert!(resolve(&m, root, "projects/b/Linker2.md", "Same", true).unwrap().path.ends_with("projects/b/Same.md"));
    assert!(resolve(&m, root, "projects/a/Linker.md", "Same", true).unwrap().path.ends_with("projects/a/Same.md"));
}

#[test]
fn resolve_missing_gives_the_place_to_create() {
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root = root.to_str().unwrap();
    let m = NoteManager::new();
    let r = resolve(&m, root, "notes/Alpha.md", "Brand New", true).unwrap();
    assert_eq!((r.exists, r.kind), (false, NoteNodeKind::Missing));
    assert_eq!(r.path, format!("{root}/notes/Brand New.md"));
    let r = resolve(&m, root, "notes/Alpha.md", "deep/er/Brand New#Head", true).unwrap();
    assert_eq!(r.path, format!("{root}/deep/er/Brand New.md"));
    assert_eq!(r.heading.as_deref(), Some("Head"));
    let r = resolve(&m, root, "notes/Alpha.md", "gone/x.md", false).unwrap();
    assert_eq!((r.exists, r.path), (false, format!("{root}/notes/gone/x.md")));
    let r = resolve(&m, root, "notes/Alpha.md", "gone/y", false).unwrap();
    assert_eq!(r.path, format!("{root}/notes/gone/y.md"));
}

#[test]
fn resolve_markdown_destinations() {
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root = root.to_str().unwrap();
    let m = NoteManager::new();
    let from = "with space/My Note.md";
    let r = resolve(&m, root, from, "../notes/Alpha.md#Intro", false).unwrap();
    assert!(r.exists && r.path.ends_with("notes/Alpha.md"));
    assert_eq!(r.heading.as_deref(), Some("Intro"));
    let r = resolve(&m, root, from, "../Tiếng%20Việt/Ghi%20ch%C3%BA.md", false).unwrap();
    assert!(r.exists && r.path.ends_with("Ghi chú.md"));
    let r = resolve(&m, root, from, "<../Tiếng Việt/Ghi chú.md>", false).unwrap();
    assert!(r.exists);
    let r = resolve(&m, root, from, "/notes/Beta.md#^blk", false).unwrap();
    assert!(r.exists && r.block && r.heading.as_deref() == Some("blk"));
    let r = resolve(&m, root, from, "My%20Note.md", false).unwrap();
    assert!(r.exists && r.path.ends_with("with space/My Note.md"));
}

#[test]
fn resolve_returns_none_for_external_heading_only_and_outside() {
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root = root.to_str().unwrap();
    let m = NoteManager::new();
    assert!(resolve(&m, root, "Index.md", "https://example.com/a.md", false).is_none());
    assert!(resolve(&m, root, "Index.md", "mailto:a@b.c", false).is_none());
    assert!(resolve(&m, root, "Index.md", "#heading", false).is_none());
    assert!(resolve(&m, root, "Index.md", "#heading", true).is_none());
    assert!(resolve(&m, root, "Index.md", "", true).is_none());
    assert!(resolve(&m, root, "Index.md", "../../outside.md", false).is_none());
    assert!(resolve(&m, root, "Index.md", "notes", true).is_none());
    assert!(resolve(&m, root, "Index.md", "notes/", false).is_none());
}

#[test]
fn resolve_agrees_with_the_graph() {
    // Every link of the graph resolves to the same path with notes_resolve.
    let root = kestrel_common::paths::normalize(Path::new(&fixture()));
    let root_s = root.to_str().unwrap();
    let m = NoteManager::new();
    let g = m.graph("t", root_s, &AtomicBool::new(false)).unwrap();
    let alpha = resolve(&m, root_s, "Top.md", "Alpha", true).unwrap();
    assert!(g.data.nodes.iter().any(|n| n.path == alpha.path));
}
