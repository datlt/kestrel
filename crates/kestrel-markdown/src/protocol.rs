//! Helpers for the `preview://` protocol.

use percent_encoding::percent_decode_str;

/// Turns the path part of a `preview://` URL into a native path.
/// Unix: `/Users/me/My%20Docs/a.png` gives `/Users/me/My Docs/a.png`.
/// Windows: `/C:/work/a.png` gives `C:\work\a.png`.
/// Returns `None` when the path is empty, has a NUL byte, is not valid UTF-8,
/// or has a `..` segment.
pub fn decode_uri_path(uri_path: &str) -> Option<String> {
    // Drop a query or fragment if the caller passed a full request path.
    let raw = uri_path.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    if decoded.is_empty() || decoded.contains('\0') {
        return None;
    }
    // Windows removes trailing dots and spaces from a name, so `.. ` or `...` can
    // mean `..` there. We refuse every segment that has only dots and spaces,
    // except a single `.`.
    if decoded.split(['/', '\\']).any(|s| s != "." && !s.is_empty() && s.chars().all(|c| c == '.' || c == ' ')) {
        return None;
    }
    // Two separators of any kind at the start: a network (UNC) or device path such as
    // `//server/share`, `/\server\share` or `\\?\C:\x`. Windows would contact the
    // server when it opens such a path, so we refuse it before any disk access.
    let mut start = decoded.chars();
    if matches!((start.next(), start.next()), (Some('/' | '\\'), Some('/' | '\\'))) {
        return None;
    }
    let b = decoded.as_bytes();
    // `/C:` or `/C:/...`. A path like `/C:foo` is relative to a drive, so it is not accepted here.
    let is_drive = b.len() >= 3
        && b[0] == b'/'
        && b[1].is_ascii_alphabetic()
        && b[2] == b':'
        && (b.len() == 3 || b[3] == b'/' || b[3] == b'\\');
    if is_drive {
        let rest = &decoded[1..];
        let mut out = rest.replace('/', "\\");
        if out.len() == 2 {
            out.push('\\');
        }
        return Some(out);
    }
    Some(decoded.into_owned())
}

/// MIME type for a file name. Text types get `charset=utf-8`.
pub fn mime_for(path: &str) -> String {
    let ext = path.rsplit(['/', '\\']).next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_lowercase());
    // Some types that mime_guess gets wrong or does not know.
    let fixed = match ext.as_deref() {
        Some("md" | "markdown") => Some("text/markdown; charset=utf-8"),
        Some("svg") => Some("image/svg+xml"),
        Some("avif") => Some("image/avif"),
        Some("webp") => Some("image/webp"),
        Some("mjs") => Some("text/javascript; charset=utf-8"),
        Some("wasm") => Some("application/wasm"),
        Some("ts" | "tsx" | "rs" | "kt" | "java" | "toml" | "yaml" | "yml" | "log") => Some("text/plain; charset=utf-8"),
        _ => None,
    };
    if let Some(m) = fixed {
        return m.to_string();
    }
    let m = mime_guess::from_path(path).first_or_octet_stream();
    let s = m.essence_str();
    if s.starts_with("text/") || s == "application/json" || s == "application/javascript" || s == "application/xml" {
        format!("{s}; charset=utf-8")
    } else {
        s.to_string()
    }
}

/// An inclusive byte range inside a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// Parses a `Range` header for a file of `size` bytes.
/// Supports `bytes=a-b`, `bytes=a-` and `bytes=-n`. Only the first range is used.
/// Returns `None` when the header is not usable or the range is outside the
/// file (the caller answers 416).
pub fn parse_range(header: &str, size: u64) -> Option<ByteRange> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some(ByteRange { start: size.saturating_sub(n), end: size - 1 });
    }
    let start: u64 = a.parse().ok()?;
    if start >= size {
        return None;
    }
    let end = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
    if end < start {
        return None;
    }
    Some(ByteRange { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_path() {
        assert_eq!(decode_uri_path("/Users/me/My%20Docs/a.png").as_deref(), Some("/Users/me/My Docs/a.png"));
        assert_eq!(decode_uri_path("/a/%E6%97%A5%E6%9C%AC.md").as_deref(), Some("/a/日本.md"));
        assert_eq!(decode_uri_path("/a/b.png?x=1#y").as_deref(), Some("/a/b.png"));
    }

    #[test]
    fn windows_path() {
        assert_eq!(decode_uri_path("/C:/work/a%20b.png").as_deref(), Some("C:\\work\\a b.png"));
        assert_eq!(decode_uri_path("/d:/x").as_deref(), Some("d:\\x"));
        assert_eq!(decode_uri_path("/C:").as_deref(), Some("C:\\"));
        assert_eq!(decode_uri_path("/C%3A/x").as_deref(), Some("C:\\x"));
    }

    #[test]
    fn bad_paths() {
        assert_eq!(decode_uri_path(""), None);
        assert_eq!(decode_uri_path("/a/../etc/passwd"), None);
        assert_eq!(decode_uri_path("/a/%2e%2e/b"), None);
        assert_eq!(decode_uri_path("/a/%00"), None);
        assert_eq!(decode_uri_path("/a/%FF"), None);
        assert_eq!(decode_uri_path("//server/share"), None);
    }

    #[test]
    fn windows_tricks_are_refused() {
        // UNC and device paths with backslashes or mixed separators.
        assert_eq!(decode_uri_path("/%5Cserver/share/a.png"), None);
        assert_eq!(decode_uri_path("/%5C%5C?%5CC:%5Cx"), None);
        assert_eq!(decode_uri_path("%5C%5Cserver%5Cshare"), None);
        assert_eq!(decode_uri_path("/a/%5C/b"), Some("/a/\\/b".to_string()));
        // Names that Windows turns into `..`.
        assert_eq!(decode_uri_path("/a/.. /b"), None);
        assert_eq!(decode_uri_path("/a/.../b"), None);
        assert_eq!(decode_uri_path("/a/%2e%2e%5Cb"), None);
        // A single dot and normal dots in names stay valid.
        assert_eq!(decode_uri_path("/a/./b.txt").as_deref(), Some("/a/./b.txt"));
        assert_eq!(decode_uri_path("/a/.hidden/b..c").as_deref(), Some("/a/.hidden/b..c"));
        // Drive-relative path (`C:foo`) is refused as a drive; it stays a plain path.
        assert_eq!(decode_uri_path("/C:foo").as_deref(), Some("/C:foo"));
    }

    #[test]
    fn mime_types() {
        assert_eq!(mime_for("/a/b.png"), "image/png");
        assert_eq!(mime_for("/a/b.JPG"), "image/jpeg");
        assert_eq!(mime_for("C:\\a\\b.svg"), "image/svg+xml");
        assert_eq!(mime_for("/a/b.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("/a/b.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for("/a/b.mp4"), "video/mp4");
        assert_eq!(mime_for("/a/b.mp3"), "audio/mpeg");
        assert_eq!(mime_for("/a/b.md"), "text/markdown; charset=utf-8");
        assert_eq!(mime_for("/a/b.unknownext"), "application/octet-stream");
        assert_eq!(mime_for("/a/noext"), "application/octet-stream");
    }

    #[test]
    fn ranges() {
        let r = |h, s| parse_range(h, s);
        assert_eq!(r("bytes=0-99", 1000), Some(ByteRange { start: 0, end: 99 }));
        assert_eq!(r("bytes=500-", 1000), Some(ByteRange { start: 500, end: 999 }));
        assert_eq!(r("bytes=-100", 1000), Some(ByteRange { start: 900, end: 999 }));
        assert_eq!(r("bytes=-5000", 1000), Some(ByteRange { start: 0, end: 999 }));
        assert_eq!(r("bytes=900-5000", 1000), Some(ByteRange { start: 900, end: 999 }));
        assert_eq!(r("bytes=0-1,5-6", 1000), Some(ByteRange { start: 0, end: 1 }));
        assert_eq!(r("bytes=1000-", 1000), None);
        assert_eq!(r("bytes=5-2", 1000), None);
        assert_eq!(r("bytes=-0", 1000), None);
        assert_eq!(r("bytes=0-1", 0), None);
        assert_eq!(r("items=0-1", 1000), None);
        assert_eq!(r("bytes=x-y", 1000), None);
        assert_eq!(ByteRange { start: 10, end: 19 }.len(), 10);
    }
}
