use comrak::nodes::{AstNode, NodeValue};
use comrak::{Arena, Options, format_html, markdown_to_html, parse_document};

fn options() -> Options<'static> {
    let mut o = Options::default();
    let e = &mut o.extension;
    e.strikethrough = true;
    e.table = true;
    e.autolink = true;
    e.tasklist = true;
    e.footnotes = true;
    e.description_lists = true;
    e.alerts = true;
    // `[[target|label]]` (Obsidian) becomes `<a href="target" data-wikilink="true">`.
    // The preview resolves the target with the note index when you click it.
    e.wikilinks_title_after_pipe = true;
    e.front_matter_delimiter = Some("---".to_string());
    // An empty prefix turns on heading ids without changing the id text.
    e.header_id_prefix = Some(String::new());
    // Raw HTML is allowed. The preview iframe has no scripts.
    o.render.r#unsafe = true;
    o.render.sourcepos = true;
    o.render.tasklist_classes = true;
    o
}

/// Renders markdown from other people (pull request comments) for the main
/// window. Raw HTML is not rendered and comrak drops `javascript:` and other
/// unsafe links, because this HTML goes into the page that can call Kestrel
/// commands.
pub fn render_safe(text: &str) -> String {
    let mut o = options();
    o.render.r#unsafe = false;
    o.render.sourcepos = false;
    o.extension.front_matter_delimiter = None;
    o.extension.header_id_prefix = None;
    o.extension.wikilinks_title_after_pipe = false;
    markdown_to_html(text, &o)
}

/// Renders markdown to HTML. Block elements carry `data-sourcepos="l:c-l:c"`.
/// A front matter block at the top is shown as a small table.
pub fn render(text: &str) -> String {
    let o = options();
    let arena = Arena::new();
    let root = parse_document(&arena, text, &o);
    mark_embeds(&arena, root);
    let mut body = String::new();
    // Writing to a String does not fail.
    let _ = format_html(root, &o, &mut body);
    match front_matter(text) {
        Some(fm) => format!("{fm}{body}"),
        None => body,
    }
}

/// comrak renders `![[x]]` like `[[x]]`. This puts each embed in
/// `<span class="wikilink-embed">`, so the preview can show embedded images.
fn mark_embeds<'a>(arena: &'a Arena<'a>, root: &'a AstNode<'a>) {
    let embeds: Vec<_> = root
        .descendants()
        .filter(|n| matches!(&n.data().value, NodeValue::WikiLink(w) if w.embed))
        .collect();
    for n in embeds {
        let open = arena.alloc(NodeValue::HtmlInline("<span class=\"wikilink-embed\">".into()).into());
        let close = arena.alloc(NodeValue::HtmlInline("</span>".into()).into());
        n.insert_before(open);
        n.insert_after(close);
    }
}

/// Reads a `---` block at the very start of the text. Returns a table with one
/// row per `key: value` line. Lines that do not look like that are shown as
/// plain text in the last row.
fn front_matter(text: &str) -> Option<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    let mut rows = Vec::new();
    let mut closed = false;
    for line in lines {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            closed = true;
            break;
        }
        rows.push(t);
    }
    if !closed {
        return None;
    }
    let mut out = String::from("<table class=\"front-matter\" data-sourcepos=\"1:1-1:1\"><tbody>");
    let mut any = false;
    for row in rows {
        if row.trim().is_empty() {
            continue;
        }
        any = true;
        match row.split_once(':') {
            Some((k, v)) if !k.starts_with(char::is_whitespace) && !k.contains(' ') => {
                out.push_str(&format!("<tr><th>{}</th><td>{}</td></tr>", esc(k), esc(v.trim())));
            }
            _ => out.push_str(&format!("<tr><td colspan=\"2\">{}</td></tr>", esc(row))),
        }
    }
    if !any {
        return None;
    }
    out.push_str("</tbody></table>");
    Some(out)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {

    #[test]
    fn safe_render_drops_raw_html_and_script_links() {
        let html = super::render_safe("hi <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) **b**");
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("<strong>b</strong>"), "{html}");
    }
    use super::*;

    #[test]
    fn basic_blocks_have_sourcepos() {
        let html = render("# Title\n\nHello **world**\n");
        assert!(html.contains("<h1"), "{html}");
        assert!(html.contains("data-sourcepos=\"1:1-1:7\""), "{html}");
        assert!(html.contains("data-sourcepos=\"3:1-3:15\""), "{html}");
        assert!(html.contains(">world</strong>"), "{html}");
    }

    #[test]
    fn heading_has_id() {
        let html = render("## Hello World\n");
        assert!(html.contains("id=\"hello-world\""), "{html}");
    }

    #[test]
    fn github_features() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ https://example.com\n\nNote[^1]\n\n[^1]: the note\n";
        let html = render(md);
        assert!(html.contains("<table"), "{html}");
        assert!(html.contains("type=\"checkbox\""), "{html}");
        assert!(html.contains(">gone</del>"), "{html}");
        assert!(html.contains("href=\"https://example.com\""), "{html}");
        assert!(html.contains("footnote"), "{html}");
    }

    #[test]
    fn alerts_and_description_lists() {
        let html = render("> [!NOTE]\n> Be careful\n");
        assert!(html.contains("markdown-alert-note"), "{html}");
        let html = render("Term\n\n: Definition\n");
        assert!(html.contains("<dl"), "{html}");
        assert!(html.contains("<dd"), "{html}");
    }

    #[test]
    fn raw_html_is_kept() {
        let html = render("<div class=\"x\">hi</div>\n");
        assert!(html.contains("<div class=\"x\">hi</div>"), "{html}");
    }

    #[test]
    fn fenced_code_keeps_language() {
        let html = render("```rust\nfn main() {}\n```\n");
        assert!(html.contains("language-rust"), "{html}");
    }

    #[test]
    fn front_matter_becomes_table() {
        let html = render("---\ntitle: Hi <b>\ntags: a, b\n---\n\n# Body\n");
        assert!(html.contains("class=\"front-matter\""), "{html}");
        assert!(html.contains("<th>title</th><td>Hi &lt;b&gt;</td>"), "{html}");
        // The body keeps its real line number.
        assert!(html.contains("data-sourcepos=\"6:1-6:6\""), "{html}");
    }

    #[test]
    fn no_front_matter_when_not_closed() {
        let html = render("---\nnot closed\n");
        assert!(!html.contains("front-matter"), "{html}");
    }

    #[test]
    fn wiki_links() {
        let html = render("See [[Auth Flow#Login|the login]] and [[ノート/設計]].\n\n![[logo.png]]\n");
        assert!(html.contains("data-wikilink=\"true\""), "{html}");
        assert!(html.contains(">the login</a>"), "{html}");
        assert!(html.contains("設計"), "{html}");
        assert!(html.contains("<span class=\"wikilink-embed\"><a"), "{html}");
        assert_eq!(html.matches("wikilink-embed").count(), 1, "{html}");
        // Pull request comments keep the brackets as text.
        assert!(!render_safe("[[Auth]]").contains("data-wikilink"));
    }

    #[test]
    fn empty_input() {
        assert_eq!(render(""), "");
    }

    #[test]
    fn crlf_and_cjk() {
        let html = render("# 見出し\r\n\r\n本文です\r\n");
        assert!(html.contains("見出し"));
        assert!(html.contains("本文です"));
    }
}
