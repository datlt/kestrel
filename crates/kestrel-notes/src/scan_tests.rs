use crate::scan::*;
use std::time::Instant;

/// Targets of all links, in order, as `kind:target` (kind `w` or `m`, `!` for embeds).
fn links(text: &str) -> Vec<String> {
    scan(text)
        .links
        .iter()
        .map(|l| format!("{}{}:{}", if l.embed { "!" } else { "" }, if l.kind == LinkKind::Wiki { "w" } else { "m" }, l.target))
        .collect()
}

fn tags(text: &str) -> Vec<String> {
    scan(text).tags
}

#[test]
fn wiki_forms() {
    let l = links("[[a]] [[b|alias]] [[c#head]] [[d#^blk]] [[e/f]] ![[g]] [[ h ]] [[i#h|al]]");
    assert_eq!(l, ["w:a", "w:b", "w:c", "w:d", "w:e/f", "!w:g", "w:h", "w:i"]);
}

#[test]
fn wiki_dropped_forms() {
    assert!(links("[[#only a heading]] [[]] [[|alias]]").is_empty());
}

#[test]
fn wiki_with_escaped_pipe_in_table() {
    assert_eq!(links("| [[a\\|alias]] | x |"), ["w:a"]);
}

#[test]
fn wiki_without_close_is_text() {
    assert_eq!(links("start [[ not closed and then [x](y.md)"), ["m:y.md"]);
    assert!(links("[[").is_empty());
    assert!(links("[[a]").is_empty());
}

#[test]
fn wiki_does_not_cross_lines() {
    assert!(links("[[a\nb]]").is_empty());
}

#[test]
fn wiki_inner_open_wins() {
    assert_eq!(links("[[a [[b]]"), ["w:b"]);
}

#[test]
fn markdown_link_forms() {
    let l = links(
        "[a](a.md) [b](b.md \"title\") [c](<c d.md>) [d](<e f.md> 'x') ![img](i.png) [e](a%20b.md) [f](g.md#h) [g](h.md?x=1#y) [h](dir/(x).md) [i](j.md (title))",
    );
    assert_eq!(l, ["m:a.md", "m:b.md", "m:c d.md", "m:e f.md", "!m:i.png", "m:a b.md", "m:g.md", "m:h.md", "m:dir/(x).md", "m:j.md"]);
}

#[test]
fn markdown_link_not_a_link() {
    let l = links("[a](https://x.y/z.md) [b](mailto:x@y.z) [c](obsidian://open) [d](#anchor) [e]() [f](//cdn/x.md) [g](a+b.c:d) [h](?q=1)");
    assert!(l.is_empty(), "{l:?}");
}

#[test]
fn markdown_link_with_colon_in_name_is_external_by_rule() {
    // `Note: x.md` looks like a scheme. DESIGN.md 14.2 says it is not a link.
    assert!(links("[a](<Note: x.md>)").is_empty());
    assert_eq!(links("[a](./Note: x.md)").len(), 0);
}

#[test]
fn markdown_link_unbalanced() {
    assert!(links("[a](b.md").is_empty());
    assert!(links("[a](b(.md)").is_empty());
    assert!(links("[a] (b.md)").is_empty());
    assert!(links("[a](<b.md)").is_empty());
}

#[test]
fn markdown_link_percent_decoding() {
    assert_eq!(links("[a](%E6%97%A5%E6%9C%AC.md)"), ["m:日本.md"]);
    assert_eq!(links("[a](100%.md)"), ["m:100%.md"]);
    assert_eq!(links("[a](x%2.md)"), ["m:x%2.md"]);
    assert_eq!(percent_decode("a%2"), "a%2");
    assert_eq!(percent_decode("%41%zz"), "A%zz");
}

#[test]
fn image_inside_link_text() {
    assert_eq!(links("[![alt](pic.png)](page.md)"), ["m:page.md", "!m:pic.png"]);
}

#[test]
fn wiki_inside_link_text() {
    assert_eq!(links("[see [[x]] here](y.md)"), ["m:y.md", "w:x"]);
}

#[test]
fn reference_definitions() {
    let l = links("text [a][r]\n\n[r]: notes/a.md\n[s]: <b c.md> \"T\"\n[t]: https://x.y\n[^1]: footnote\n  [u]: indented.md\n");
    assert_eq!(l, ["m:notes/a.md", "m:b c.md", "m:indented.md"]);
}

#[test]
fn reference_definition_needs_line_start() {
    assert!(links("text [a]: b.md").is_empty());
    assert!(links("    [a]: b.md").is_empty());
}

#[test]
fn fenced_code_hides_links() {
    let t = "[[a]]\n```\n[[b]] #tag\n```\n[[c]]\n~~~\n[[d]]\n~~~\n[[e]]";
    assert_eq!(links(t), ["w:a", "w:c", "w:e"]);
    assert_eq!(tags(t), Vec::<String>::new());
}

#[test]
fn long_fence_needs_long_close() {
    let t = "````\n```\n[[a]]\n```\n[[b]]\n````\n[[c]]";
    assert_eq!(links(t), ["w:c"]);
}

#[test]
fn fence_closes_with_same_char_only() {
    let t = "```\n[[a]]\n~~~\n[[b]]\n```\n[[c]]";
    assert_eq!(links(t), ["w:c"]);
}

#[test]
fn unclosed_fence_hides_the_rest() {
    assert_eq!(links("[[a]]\n```\n[[b]]\n[[c]]"), ["w:a"]);
}

#[test]
fn fence_with_info_string_and_indent() {
    assert_eq!(links("   ```rust\n[[a]]\n   ```\n[[b]]"), ["w:b"]);
    assert_eq!(links("- item\n  ```\n  [[a]]\n  ```\n  [[b]]"), ["w:b"]);
    assert_eq!(links("> ```\n> [[a]]\n> ```\n[[b]]"), ["w:b"]);
}

#[test]
fn backtick_with_backtick_in_info_is_not_a_fence() {
    assert_eq!(links("``` a`b\n[[a]]"), ["w:a"]);
}

#[test]
fn inline_code_hides_links() {
    assert_eq!(links("`[[a]]` [[b]] ``[[c]] ` x`` [[d]] `unclosed [[e]]"), ["w:b", "w:d", "w:e"]);
    assert_eq!(links("```[[a]]``` [[b]]"), ["w:b"]);
}

#[test]
fn html_comments() {
    assert_eq!(links("<!-- [[a]] --> [[b]]"), ["w:b"]);
    assert_eq!(links("<!-- [[a]]\n[[b]]\n--> [[c]]\n[[d]]"), ["w:c", "w:d"]);
    assert_eq!(links("<!-- never closed\n[[a]]"), Vec::<String>::new());
}

#[test]
fn percent_comments() {
    assert_eq!(links("%% [[a]] %% [[b]]"), ["w:b"]);
    assert_eq!(links("%%\n[[a]]\n%%\n[[b]]"), ["w:b"]);
    assert_eq!(links("%% never closed [[a]]\n[[b]]"), Vec::<String>::new());
}

#[test]
fn math_blocks_and_inline_math() {
    assert_eq!(links("$$\n[[a]]\n$$\n[[b]]"), ["w:b"]);
    assert_eq!(links("$$ [[a]] $$ [[b]]"), ["w:b"]);
    assert_eq!(links("$[[a]]$ [[b]]"), ["w:b"]);
    // Prices are not math.
    assert_eq!(links("costs $5 and [[a]] or $6 [[b]]"), ["w:a", "w:b"]);
    assert_eq!(links("a $ [[a]] $ b"), ["w:a"]);
}

#[test]
fn backslash_escapes() {
    assert_eq!(links("\\[[a]] [[b]]"), ["w:b"]);
    assert_eq!(links("\\[a](b.md) [c](d.md)"), ["m:d.md"]);
    assert_eq!(tags("\\#a #b"), ["b"]);
    assert_eq!(links("\\`[[a]]\\` x"), ["w:a"]);
}

#[test]
fn indented_code_hides_links() {
    assert_eq!(links("text\n\n    [[a]]\n    [[b]]\n\n[[c]]"), ["w:c"]);
    assert_eq!(links("\t[[a]]\n"), Vec::<String>::new());
    // An indented line right after text continues the paragraph.
    assert_eq!(links("text\n    [[a]]"), ["w:a"]);
    // In a list it continues the item.
    assert_eq!(links("- item\n\n    [[a]]"), ["w:a"]);
}

#[test]
fn block_quote_and_list_links() {
    assert_eq!(links("> [[a]]\n- [[b]]\n1. [c](c.md)"), ["w:a", "w:b", "m:c.md"]);
}

#[test]
fn tag_forms() {
    assert_eq!(tags("#a #b-c #d_e #f/g/h #日本語 #Tiếng"), ["a", "b-c", "d_e", "f/g/h", "日本語", "Tiếng"]);
}

#[test]
fn tag_rules() {
    // Not tags: digits only, after a letter, headings, urls, entities.
    assert!(tags("#2024 a#b # heading\n## Two\nhttp://x/#frag &#123; (#a)").is_empty());
    assert_eq!(tags("#2024a #a1"), ["2024a", "a1"]);
    assert_eq!(tags("text #a, #b. #c!"), ["a", "b", "c"]);
    assert_eq!(tags("#a/"), ["a"]);
}

#[test]
fn tags_are_unique_case_insensitive_first_spelling_wins() {
    assert_eq!(tags("#Foo #foo #FOO #bar"), ["Foo", "bar"]);
}

#[test]
fn tags_not_in_code_links_or_comments() {
    assert!(tags("`#a` [#b](x.md) [[c#d]] <!-- #e --> %% #f %%").is_empty());
    assert!(tags("```\n#a\n```").is_empty());
}

#[test]
fn tags_in_headings_and_decomposed_text() {
    assert_eq!(tags("## Title #tag"), ["tag"]);
    // Vietnamese with combining marks and Japanese with a dakuten mark.
    assert_eq!(tags("#Vie\u{0323}\u{0302}t #ha\u{3099}"), ["Vie\u{0323}\u{0302}t", "ha\u{3099}"]);
}

#[test]
fn title_from_first_h1() {
    assert_eq!(scan("intro\n# One\n# Two\n").title.as_deref(), Some("One"));
    assert_eq!(scan("## Two\n# One\n").title.as_deref(), Some("One"));
    assert_eq!(scan("#Not heading\n").title, None);
    assert_eq!(scan("# Title ##\n").title.as_deref(), Some("Title"));
    assert_eq!(scan("# C# language\n").title.as_deref(), Some("C# language"));
    assert_eq!(scan("```\n# code\n```\n# Real\n").title.as_deref(), Some("Real"));
    assert_eq!(scan("    # indented code\n").title, None);
    assert_eq!(scan("<!--\n# Hidden\n-->\n# Shown\n").title.as_deref(), Some("Shown"));
}

#[test]
fn front_matter_title_wins() {
    let s = scan("---\ntitle: From Meta\n---\n# From Heading\n");
    assert_eq!(s.title.as_deref(), Some("From Meta"));
}

#[test]
fn front_matter_tags_and_aliases_forms() {
    let s = scan("---\ntags: [a, \"b c\", '#d']\naliases:\n  - X\n  - \"Y, Z\"\n---\n");
    assert_eq!(s.tags, ["a", "b c", "d"]);
    assert_eq!(s.aliases, ["X", "Y, Z"]);
    let s = scan("---\ntag: one two,three\nalias: Single Name\n---\n");
    assert_eq!(s.tags, ["one", "two", "three"]);
    assert_eq!(s.aliases, ["Single Name"]);
    let s = scan("---\ntags:\n- a\n- #b\naliases: [P, Q]\n---\n");
    assert_eq!(s.tags, ["a", "b"]);
    assert_eq!(s.aliases, ["P", "Q"]);
}

#[test]
fn front_matter_multiline_inline_list_and_comments() {
    let s = scan("---\ntags: [a,\n  b,\n  c]\n# comment\naliases: [x] # trailing\n---\n");
    assert_eq!(s.tags, ["a", "b", "c"]);
    assert_eq!(s.aliases, ["x"]);
}

#[test]
fn front_matter_other_keys_and_block_scalars_are_skipped() {
    let s = scan("---\ndescription: |\n  tags: not-a-tag\n  more\ntitle: T\nother:\n  - tags\n---\n");
    assert!(s.tags.is_empty());
    assert_eq!(s.title.as_deref(), Some("T"));
}

#[test]
fn front_matter_ends_with_dots() {
    let s = scan("---\ntitle: T\n...\n[[a]]");
    assert_eq!(s.title.as_deref(), Some("T"));
    assert_eq!(s.links.len(), 1);
}

#[test]
fn front_matter_links_are_not_scanned() {
    let s = scan("---\nrelated: \"[[x]]\"\n---\n[[y]]\n");
    assert_eq!(s.links.len(), 1);
    assert_eq!(s.links[0].target, "y");
    assert_eq!(s.links[0].line, 4);
}

#[test]
fn unclosed_front_matter_is_text() {
    let s = scan("---\ntitle: T\n[[a]]\n");
    assert_eq!(s.title, None);
    assert_eq!(s.links.len(), 1);
}

#[test]
fn horizontal_rules_are_not_front_matter() {
    let s = scan("---\nSome paragraph with [[a]]\n---\n[[b]]\n");
    assert_eq!(s.links.len(), 2);
}

#[test]
fn empty_and_tiny_files() {
    assert!(links("").is_empty());
    assert!(links("\n\n\n").is_empty());
    assert!(links("---").is_empty());
    assert!(links("---\n").is_empty());
    assert!(links("[").is_empty());
    assert!(links("![").is_empty());
    assert!(links("![[").is_empty());
    assert!(links("`").is_empty());
    assert!(links("\\").is_empty());
}

#[test]
fn crlf_and_bom() {
    let t = "\u{feff}---\r\ntitle: T\r\ntags: [a]\r\n---\r\n# H\r\n[[x]]\r\n```\r\n[[y]]\r\n```\r\n[[z]] #t\r\n";
    let s = scan(t);
    assert_eq!(s.title.as_deref(), Some("T"));
    assert_eq!(s.tags, ["a", "t"]);
    let targets: Vec<_> = s.links.iter().map(|l| (l.target.as_str(), l.line)).collect();
    assert_eq!(targets, [("x", 6), ("z", 10)]);
}

#[test]
fn bom_before_heading() {
    assert_eq!(scan("\u{feff}# Title\n").title.as_deref(), Some("Title"));
}

#[test]
fn line_numbers() {
    let s = scan("a\n\n[[one]]\n\n\n[two](t.md)\n![[three]]");
    let lines: Vec<u32> = s.links.iter().map(|l| l.line).collect();
    assert_eq!(lines, [3, 6, 7]);
}

#[test]
fn clean_dest_cases() {
    let c = clean_dest("<a b.md#h%20x>").unwrap();
    assert_eq!(c.target, "a b.md");
    assert_eq!(c.fragment.as_deref(), Some("h x"));
    assert!(clean_dest("#h").is_none());
    assert!(clean_dest("http://x").is_none());
    assert!(clean_dest("  ").is_none());
    assert_eq!(clean_dest("a.md?x=1").unwrap().target, "a.md");
}

#[test]
fn split_wiki_cases() {
    assert_eq!(split_wiki("a|b"), ("a", None));
    assert_eq!(split_wiki("a#h|b"), ("a", Some("h")));
    assert_eq!(split_wiki("a\\|b"), ("a", None));
    assert_eq!(split_wiki("#h"), ("", Some("h")));
}

// --- Big and nasty inputs -----------------------------------------------------------

fn timed<T>(f: impl FnOnce() -> T) -> (T, u128) {
    let t = Instant::now();
    let r = f();
    (r, t.elapsed().as_millis())
}

#[test]
fn five_megabyte_file_of_normal_text() {
    let line = "Some text with [[Link One]] and [text](two.md) and #tag and `code [[no]]`.\n";
    let text = line.repeat(5 * 1024 * 1024 / line.len());
    assert!(text.len() > 5_000_000);
    let (s, ms) = timed(|| scan(&text));
    assert_eq!(s.links.len(), 2 * (text.len() / line.len()));
    assert_eq!(s.tags, ["tag"]);
    assert!(ms < 5000, "took {ms} ms");
}

#[test]
fn two_megabyte_single_line_of_open_brackets() {
    for unit in ["[[", "[", "![", "[x](", "[x](<", "`a", "``a ```a ````a", "$a", "%", "<!-", "\\", "#", "[[a [[a", "[a](b \"", "[a](b(c"] {
        let text = unit.repeat(2 * 1024 * 1024 / unit.len());
        let (s, ms) = timed(|| scan(&text));
        assert!(s.links.is_empty(), "unit {unit:?}");
        assert!(ms < 5000, "unit {unit:?} took {ms} ms");
    }
}

#[test]
fn five_megabyte_single_line_with_links() {
    let unit = "[[a]] [b](c.md) ";
    let text = unit.repeat(2 * 1024 * 1024 / unit.len());
    let (s, ms) = timed(|| scan(&text));
    assert_eq!(s.links.len(), 2 * (text.len() / unit.len()));
    assert!(ms < 5000, "took {ms} ms");
}

#[test]
fn many_short_unclosed_constructs_stay_linear() {
    let text = "[[a\n".repeat(500_000) + &"```x\n".repeat(1);
    let (s, ms) = timed(|| scan(&text));
    assert!(s.links.is_empty());
    assert!(ms < 5000, "took {ms} ms");
}

#[test]
fn non_ascii_text_does_not_break_slicing() {
    let t = "日本語 [[ノート]] 、[リンク](ファイル.md) #タグ\n🙂 [[😀]] `🙂` $🙂$ <!-- 🙂 --> %% 🙂 %% \\🙂 [[ok]]\n";
    let l = links(t);
    assert_eq!(l, ["w:ノート", "m:ファイル.md", "w:😀", "w:ok"]);
}
