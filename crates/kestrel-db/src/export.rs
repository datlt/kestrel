//! Helpers for `db_export_csv`: the read-only check of a statement, the CSV
//! encoder and the names of the files.
//! The check is a safety net for the user. It is not a security boundary: the
//! database account still decides what is allowed.

use crate::types::ExportOptions;
use kestrel_common::{Error, Result};
use std::path::{Path, PathBuf};

/// Statements that only read. The first word must be one of these.
const READ_WORDS: [&str; 8] = ["select", "with", "show", "describe", "desc", "explain", "values", "table"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Mysql,
    Trino,
}

/// Checks that the text is ONE statement that only reads data.
/// `extra_words` are more allowed first words (the Trino read-only mode allows `use`).
pub fn check_read_only(sql: &str, dialect: Dialect, extra_words: &[&str]) -> Result<()> {
    scan(sql, dialect, extra_words).map_err(|why| Error::invalid(format!("only one read-only statement is allowed here (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, VALUES, TABLE): {why}")))
}

fn scan(sql: &str, dialect: Dialect, extra_words: &[&str]) -> std::result::Result<(), String> {
    let mysql = dialect == Dialect::Mysql;
    let b = sql.as_bytes();
    let mut i = 0;
    let mut first: Option<String> = None;
    let mut prev = String::new();
    // Set after a `;` outside of quotes. Any code after it is a second statement.
    let mut ended = false;
    while i < b.len() {
        let c = b[i];
        match c {
            b' ' | b'\t' | b'\r' | b'\n' | 0x0c => i += 1,
            b'-' if b.get(i + 1) == Some(&b'-') && (!mysql || b.get(i + 2).is_none_or(|n| n.is_ascii_whitespace() || n.is_ascii_control())) => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'#' if mysql => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                if mysql && b.get(i + 2) == Some(&b'!') {
                    return Err("the text has a MySQL executable comment (/*! ... */)".into());
                }
                match sql[i + 2..].find("*/") {
                    Some(end) => i += 2 + end + 2,
                    None => return Err("a comment is not closed".into()),
                }
            }
            b';' => {
                ended = true;
                i += 1;
            }
            _ if ended => return Err("the text has more than one statement".into()),
            b'\'' | b'"' | b'`' => {
                // Trino uses `"` for names and `'` for text. Both double the quote to escape it.
                // MySQL also accepts a backslash in `'` and `"` text.
                let q = c;
                let backslash = mysql && q != b'`';
                i += 1;
                loop {
                    if i >= b.len() {
                        return Err("a quote is not closed".into());
                    }
                    if backslash && b[i] == b'\\' {
                        i += 2;
                    } else if b[i] == q {
                        if b.get(i + 1) == Some(&q) {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                if first.is_none() {
                    return Err("the statement starts with a quote".into());
                }
                prev.clear();
            }
            b'(' => {
                i += 1;
            }
            _ if c.is_ascii_alphabetic() || c == b'_' => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                let word = sql[start..i].to_ascii_lowercase();
                if first.is_none() {
                    if !READ_WORDS.contains(&word.as_str()) && !extra_words.contains(&word.as_str()) {
                        return Err(format!("`{}` is not a read statement", &sql[start..i]));
                    }
                    first = Some(word.clone());
                }
                if mysql && prev == "into" && (word == "outfile" || word == "dumpfile") {
                    return Err("SELECT ... INTO OUTFILE writes a file on the server".into());
                }
                prev = word;
            }
            _ => {
                if first.is_none() {
                    return Err("the statement does not start with a keyword".into());
                }
                i += 1;
                prev.clear();
            }
        }
    }
    if first.is_none() {
        return Err("the statement is empty".into());
    }
    Ok(())
}

/// Options with defaults and checks applied.
#[derive(Debug, Clone, Copy)]
pub struct CsvOptions {
    pub delimiter: char,
    pub header: bool,
    pub bom: bool,
}

impl CsvOptions {
    pub fn resolve(o: &ExportOptions) -> Result<Self> {
        let delimiter = match o.delimiter.as_deref() {
            None | Some("") => ',',
            Some(d) => {
                let mut chars = d.chars();
                match (chars.next(), chars.next()) {
                    (Some(c), None) if !matches!(c, '"' | '\r' | '\n') => c,
                    _ => return Err(Error::invalid("the delimiter must be one character and not a quote or a line break")),
                }
            }
        };
        Ok(CsvOptions { delimiter, header: o.header.unwrap_or(true), bom: o.bom.unwrap_or(true) })
    }
}

pub const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Adds one CSV row (RFC 4180) to `out`, with `\r\n` at the end. `None` is NULL
/// and becomes an empty field. A row with one empty field would look like an
/// empty line, so that field is written as `""`.
pub fn push_row<'a>(out: &mut Vec<u8>, delimiter: char, fields: impl ExactSizeIterator<Item = Option<&'a str>>) {
    let single = fields.len() == 1;
    let mut delim = [0u8; 4];
    let delim = delimiter.encode_utf8(&mut delim).as_bytes();
    for (n, f) in fields.enumerate() {
        if n > 0 {
            out.extend_from_slice(delim);
        }
        match f {
            None | Some("") => {
                if single {
                    out.extend_from_slice(b"\"\"");
                }
            }
            Some(text) => {
                let needs_quotes = text.contains(delimiter) || text.contains(['"', '\r', '\n']);
                if needs_quotes {
                    out.push(b'"');
                    for ch in text.bytes() {
                        if ch == b'"' {
                            out.push(b'"');
                        }
                        out.push(ch);
                    }
                    out.push(b'"');
                } else {
                    out.extend_from_slice(text.as_bytes());
                }
            }
        }
    }
    out.extend_from_slice(b"\r\n");
}

/// `<path>.part`. The export writes here and renames at the end.
pub fn part_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

/// Removes the part file when it is dropped, unless `disarm` was called.
/// Declare it BEFORE the writer, so the writer closes the file first.
pub struct PartGuard {
    path: PathBuf,
    armed: bool,
}

impl PartGuard {
    pub fn new(path: PathBuf) -> Self {
        PartGuard { path, armed: true }
    }

    /// The export is done and the file has its final name. Keep it.
    pub fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The target must be an absolute path to a file in a folder that exists.
pub fn check_target(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    if path.trim().is_empty() || !p.is_absolute() {
        return Err(Error::invalid("the export path must be absolute"));
    }
    if p.is_dir() {
        return Err(Error::invalid("the export path is a folder"));
    }
    match p.parent() {
        Some(dir) if dir.is_dir() => Ok(p),
        _ => Err(Error::invalid("the folder of the export path does not exist")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(sql: &str) -> bool {
        check_read_only(sql, Dialect::Mysql, &[]).is_ok()
    }

    fn row(fields: &[Option<&str>], d: char) -> String {
        let mut out = Vec::new();
        push_row(&mut out, d, fields.iter().copied());
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn read_statements_pass() {
        for sql in [
            "SELECT 1",
            "  select * from t;",
            "(SELECT 1) UNION (SELECT 2)",
            "WITH a AS (SELECT 1) SELECT * FROM a",
            "-- note\nSHOW TABLES",
            "/* c */ describe t",
            "EXPLAIN SELECT 1",
            "VALUES (1, 2)",
            "TABLE t",
            "SELECT 'a;b', \"c;d\", `e;f` -- ; drop\n;  ",
            "SELECT 'it''s; fine'",
            "SELECT 'back\\'; slash'",
        ] {
            assert!(ok(sql), "{sql}");
        }
    }

    #[test]
    fn write_statements_are_refused() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "update t set a = 1",
            "DELETE FROM t",
            "DROP TABLE t",
            "CALL p()",
            "USE x",
            "",
            "   ",
            "-- only a comment",
            "SELECT 1; DROP TABLE t",
            "SELECT 1; -- c\n DELETE FROM t",
            "SELECT 1--1; DROP TABLE t",
            "SELECT 1 /*!; DROP TABLE t */",
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            "SELECT 'open",
            "'SELECT'",
            "SELECT 1 /* open",
        ] {
            let err = check_read_only(sql, Dialect::Mysql, &[]).expect_err(sql);
            assert_eq!(err.code(), "invalid_input", "{sql}");
        }
    }

    #[test]
    fn trino_dialect_has_no_backslash_escape_and_no_hash_comment() {
        // In Trino the backslash ends nothing: `'a\'` is a complete text, so the `;` is real.
        assert!(check_read_only("SELECT 'a\\'; DROP TABLE t", Dialect::Trino, &[]).is_err());
        assert!(check_read_only("SELECT 'a\\'", Dialect::Trino, &[]).is_ok());
        assert!(check_read_only("SELECT 1 # x", Dialect::Trino, &[]).is_ok());
        assert!(check_read_only("SELECT 1--1\n; DROP TABLE t", Dialect::Trino, &[]).is_err());
        assert!(check_read_only("USE x", Dialect::Trino, &["use"]).is_ok());
    }

    #[test]
    fn csv_quotes_only_when_needed() {
        assert_eq!(row(&[Some("a"), Some("b c"), None, Some("")], ','), "a,b c,,\r\n");
        assert_eq!(row(&[Some("a,b"), Some("say \"hi\""), Some("x\ny"), Some("x\r")], ','), "\"a,b\",\"say \"\"hi\"\"\",\"x\ny\",\"x\r\"\r\n");
        assert_eq!(row(&[Some("a;b"), Some("c,d")], ';'), "\"a;b\";c,d\r\n");
        assert_eq!(row(&[Some("日本語"), Some("🎉")], ','), "日本語,🎉\r\n");
        assert_eq!(row(&[None], ','), "\"\"\r\n");
        assert_eq!(row(&[Some("x")], ','), "x\r\n");
    }

    #[test]
    fn options_have_defaults_and_checks() {
        let o = CsvOptions::resolve(&ExportOptions::default()).unwrap();
        assert!(o.header && o.bom && o.delimiter == ',');
        let tab = ExportOptions { delimiter: Some("\t".into()), header: Some(false), bom: Some(false) };
        let o = CsvOptions::resolve(&tab).unwrap();
        assert!(!o.header && !o.bom && o.delimiter == '\t');
        for bad in ["ab", "\"", "\n"] {
            let e = CsvOptions::resolve(&ExportOptions { delimiter: Some(bad.into()), ..Default::default() }).unwrap_err();
            assert_eq!(e.code(), "invalid_input");
        }
    }

    #[test]
    fn target_checks() {
        assert_eq!(check_target("relative.csv").unwrap_err().code(), "invalid_input");
        let dir = tempfile::tempdir().unwrap();
        assert!(check_target(dir.path().to_str().unwrap()).is_err());
        assert!(check_target(dir.path().join("no/such/dir/x.csv").to_str().unwrap()).is_err());
        let f = dir.path().join("x.csv");
        assert!(check_target(f.to_str().unwrap()).is_ok());
        assert_eq!(part_path(&f), dir.path().join("x.csv.part"));
    }
}
