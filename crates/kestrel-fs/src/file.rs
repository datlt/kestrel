//! Read, safe write and stat for single files.

use crate::text::{self, LineEnding};
use kestrel_common::{Error, Result, error::codes};
use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

/// Adds the path to an I/O error and keeps its error code.
pub(crate) fn io_err(e: std::io::Error, what: &str, path: &Path) -> Error {
    let code = Error::from(std::io::Error::from(e.kind())).code();
    Error::new(code, format!("cannot {what} {}: {e}", path.display()))
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The header of a read result. Same fields as `ReadFileResult` in `src/ipc/fs.ts` (without `text`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadHeader {
    pub encoding: String,
    pub bom: bool,
    pub line_ending: LineEnding,
    pub mixed_line_endings: bool,
    pub mtime_ms: i64,
    pub size: u64,
    pub readonly: bool,
    pub binary: bool,
    pub too_large: bool,
    pub lossy: bool,
}

#[derive(Debug)]
pub struct ReadOutput {
    pub header: ReadHeader,
    pub text: String,
}

impl ReadOutput {
    /// `[u32 LE header length][header JSON][UTF-8 text]`, the format of `fs_read_file`.
    pub fn into_wire(self) -> Result<Vec<u8>> {
        let header = serde_json::to_vec(&self.header)?;
        let mut out = Vec::with_capacity(4 + header.len() + self.text.len());
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(self.text.as_bytes());
        Ok(out)
    }
}

/// Reads and decodes a text file. `forced` is an encoding name that the user chose.
pub fn read_file(path: &Path, forced: Option<&str>, max_bytes: u64) -> Result<ReadOutput> {
    let forced = match forced {
        Some(name) if !name.is_empty() => Some(text::encoding_by_name(name)?),
        _ => None,
    };
    let meta = fs::metadata(path).map_err(|e| io_err(e, "read", path))?;
    if meta.is_dir() {
        return Err(Error::invalid(format!("{} is a folder", path.display())));
    }
    let size = meta.len();
    let mut header = ReadHeader {
        encoding: forced.map(text::encoding_name).unwrap_or_else(|| "utf-8".into()),
        bom: false,
        line_ending: LineEnding::Lf,
        mixed_line_endings: false,
        mtime_ms: mtime_ms(&meta),
        size,
        readonly: meta.permissions().readonly(),
        binary: false,
        too_large: false,
        lossy: false,
    };
    if size > max_bytes {
        header.too_large = true;
        return Ok(ReadOutput { header, text: String::new() });
    }

    let mut f = fs::File::open(path).map_err(|e| io_err(e, "open", path))?;
    let mut bytes = Vec::with_capacity(size as usize + 1);
    // Read the first block alone: a big binary file is rejected without reading it all.
    (&mut f)
        .take(text::BINARY_CHECK_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| io_err(e, "read", path))?;
    let has_bom = encoding_rs::Encoding::for_bom(&bytes).is_some();
    if forced.is_none() && !has_bom && text::looks_binary(&bytes) {
        header.binary = true;
        return Ok(ReadOutput { header, text: String::new() });
    }
    f.read_to_end(&mut bytes).map_err(|e| io_err(e, "read", path))?;

    let d = text::decode(bytes, forced);
    let le = text::detect_line_ending(&d.text);
    header.encoding = text::encoding_name(d.encoding);
    header.bom = d.bom;
    header.lossy = d.lossy;
    header.line_ending = le.ending;
    header.mixed_line_endings = le.mixed;
    Ok(ReadOutput { header, text: d.text })
}

#[derive(Debug, Clone)]
pub struct WriteOptions {
    pub encoding: String,
    pub bom: bool,
    pub line_ending: LineEnding,
    /// Fails with `conflict` when the file on disk has another mtime. `None` skips the check.
    pub expected_mtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: i64,
    pub size: u64,
}

fn temp_path(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(".{name}.kestrel-{}-{n}.tmp", std::process::id()))
}

/// Writes bytes to a temp file in the same folder, then renames it over the target.
fn write_via_temp(path: &Path, bytes: &[u8], perms: Option<fs::Permissions>) -> std::io::Result<()> {
    let tmp = temp_path(path);
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if let Some(p) = perms {
            fs::set_permissions(&tmp, p)?;
        }
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Saves text. `text` uses `\n`. The write is safe: a crash cannot leave half a file.
/// Symlinks are written in place, so the link stays a link.
pub fn write_file(path: &Path, text: &str, opts: &WriteOptions) -> Result<WriteResult> {
    let enc = text::encoding_by_name(&opts.encoding)?;
    let converted = text::apply_line_ending(text, opts.line_ending);
    // Encode first: when it fails, the file on disk is not touched.
    let bytes = text::encode(&converted, enc, opts.bom)?;

    let link_meta = fs::symlink_metadata(path).ok();
    let meta = fs::metadata(path).ok();
    if let (Some(expected), Some(m)) = (opts.expected_mtime_ms, &meta) {
        if mtime_ms(m) != expected {
            return Err(Error::new(codes::CONFLICT, format!("{} changed on disk", path.display())));
        }
    }
    if let Some(m) = &meta {
        if m.is_dir() {
            return Err(Error::invalid(format!("{} is a folder", path.display())));
        }
        if m.permissions().readonly() {
            return Err(Error::new(codes::PERMISSION_DENIED, format!("{} is read-only", path.display())));
        }
    }

    let is_link = link_meta.as_ref().is_some_and(|m| m.file_type().is_symlink());
    if is_link || meta.is_none() && link_meta.is_some() {
        fs::write(path, &bytes).map_err(|e| io_err(e, "write", path))?;
    } else if let Some(m) = &meta {
        match write_via_temp(path, &bytes, Some(m.permissions())) {
            Ok(()) => {}
            // The folder may be read-only while the file is writable.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                fs::write(path, &bytes).map_err(|e| io_err(e, "write", path))?;
            }
            Err(e) => return Err(io_err(e, "write", path)),
        }
    } else {
        fs::write(path, &bytes).map_err(|e| io_err(e, "write", path))?;
    }

    let after = fs::metadata(path).map_err(|e| io_err(e, "stat", path))?;
    Ok(WriteResult { mtime_ms: mtime_ms(&after), size: after.len() })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatResult {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
    pub readonly: bool,
}

/// Never fails for a missing file.
pub fn stat(path: &Path) -> StatResult {
    match fs::metadata(path) {
        Ok(m) => StatResult {
            exists: true,
            is_dir: m.is_dir(),
            size: m.len(),
            mtime_ms: mtime_ms(&m),
            readonly: m.permissions().readonly(),
        },
        Err(_) => StatResult { exists: false, is_dir: false, size: 0, mtime_ms: 0, readonly: false },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn opts(enc: &str, bom: bool, le: LineEnding) -> WriteOptions {
        WriteOptions { encoding: enc.into(), bom, line_ending: le, expected_mtime_ms: None }
    }

    #[test]
    fn reads_utf8_and_reports_meta() {
        let d = tempdir().unwrap();
        let p = d.path().join("a.txt");
        fs::write(&p, "one\ntwo\n").unwrap();
        let r = read_file(&p, None, 1 << 20).unwrap();
        assert_eq!(r.text, "one\ntwo\n");
        assert_eq!(r.header.encoding, "utf-8");
        assert_eq!(r.header.line_ending, LineEnding::Lf);
        assert!(r.header.mtime_ms > 0);
        assert_eq!(r.header.size, 8);
    }

    #[test]
    fn reads_empty_file() {
        let d = tempdir().unwrap();
        let p = d.path().join("empty");
        fs::write(&p, "").unwrap();
        let r = read_file(&p, None, 10).unwrap();
        assert_eq!(r.text, "");
        assert!(!r.header.binary);
    }

    #[test]
    fn reads_shift_jis() {
        let d = tempdir().unwrap();
        let p = d.path().join("sj.txt");
        let (b, _, _) = encoding_rs::SHIFT_JIS.encode("これは日本語のテキストです。設定ファイルを読み込みます。\n");
        fs::write(&p, &b).unwrap();
        let r = read_file(&p, None, 1 << 20).unwrap();
        assert_eq!(r.header.encoding, "shift_jis");
        assert!(r.text.contains("日本語"));
        assert!(!r.header.lossy);
    }

    #[test]
    fn reads_utf16_with_bom_not_binary() {
        let d = tempdir().unwrap();
        let p = d.path().join("u16.txt");
        let mut b = vec![0xFF, 0xFE];
        b.extend("hi\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()));
        fs::write(&p, &b).unwrap();
        let r = read_file(&p, None, 1 << 20).unwrap();
        assert_eq!(r.header.encoding, "utf-16le");
        assert!(r.header.bom && !r.header.binary);
        assert_eq!(r.text, "hi\r\n");
        assert_eq!(r.header.line_ending, LineEnding::Crlf);
    }

    #[test]
    fn reads_utf8_bom() {
        let d = tempdir().unwrap();
        let p = d.path().join("bom.txt");
        fs::write(&p, b"\xEF\xBB\xBFabc").unwrap();
        let r = read_file(&p, None, 1 << 20).unwrap();
        assert!(r.header.bom);
        assert_eq!(r.text, "abc");
    }

    #[test]
    fn detects_crlf_and_mixed() {
        let d = tempdir().unwrap();
        let p = d.path().join("crlf.txt");
        fs::write(&p, "a\r\nb\r\nc").unwrap();
        let r = read_file(&p, None, 100).unwrap();
        assert_eq!((r.header.line_ending, r.header.mixed_line_endings), (LineEnding::Crlf, false));
        // Text is not changed on read.
        assert_eq!(r.text, "a\r\nb\r\nc");
        fs::write(&p, "a\r\nb\nc\n").unwrap();
        let r = read_file(&p, None, 100).unwrap();
        assert_eq!((r.header.line_ending, r.header.mixed_line_endings), (LineEnding::Lf, true));
    }

    #[test]
    fn binary_and_too_large() {
        let d = tempdir().unwrap();
        let p = d.path().join("b.bin");
        fs::write(&p, [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        let r = read_file(&p, None, 1 << 20).unwrap();
        assert!(r.header.binary);
        assert_eq!(r.text, "");
        let r = read_file(&p, None, 3).unwrap();
        assert!(r.header.too_large);
    }

    #[test]
    fn forced_utf16_without_bom_is_not_binary() {
        let d = tempdir().unwrap();
        let p = d.path().join("x.txt");
        fs::write(&p, "ab".encode_utf16().flat_map(|u| u.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
        assert!(read_file(&p, None, 100).unwrap().header.binary);
        let r = read_file(&p, Some("utf-16le"), 100).unwrap();
        assert_eq!(r.text, "ab");
    }

    #[test]
    fn lossy_flag() {
        let d = tempdir().unwrap();
        let p = d.path().join("l.txt");
        fs::write(&p, [b'a', 0xFF, 0xFE, b'b']).unwrap();
        let r = read_file(&p, Some("utf-8"), 100).unwrap();
        assert!(r.header.lossy);
    }

    #[test]
    fn missing_file_and_folder_errors() {
        let d = tempdir().unwrap();
        assert_eq!(read_file(&d.path().join("no"), None, 1).unwrap_err().code(), "not_found");
        assert_eq!(read_file(d.path(), None, 1).unwrap_err().code(), "invalid_input");
        assert_eq!(read_file(&d.path().join("no"), Some("bogus"), 1).unwrap_err().code(), "invalid_input");
    }

    #[test]
    fn wire_format() {
        let d = tempdir().unwrap();
        let p = d.path().join("w.txt");
        fs::write(&p, "héllo").unwrap();
        let wire = read_file(&p, None, 100).unwrap().into_wire().unwrap();
        let n = u32::from_le_bytes(wire[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&wire[4..4 + n]).unwrap();
        assert_eq!(header["lineEnding"], "lf");
        assert_eq!(header["mixedLineEndings"], false);
        assert_eq!(&wire[4 + n..], "héllo".as_bytes());
    }

    #[test]
    fn write_keeps_crlf_and_bom_and_round_trips() {
        let d = tempdir().unwrap();
        let p = d.path().join("w.txt");
        write_file(&p, "a\nb\n", &opts("utf-8", true, LineEnding::Crlf)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBFa\r\nb\r\n");
        let r = read_file(&p, None, 100).unwrap();
        assert!(r.header.bom);
        assert_eq!(r.header.line_ending, LineEnding::Crlf);
    }

    #[test]
    fn write_utf16_and_shift_jis() {
        let d = tempdir().unwrap();
        let p = d.path().join("w.txt");
        write_file(&p, "日本\n", &opts("utf-16le", true, LineEnding::Lf)).unwrap();
        let r = read_file(&p, None, 100).unwrap();
        assert_eq!((r.text.as_str(), r.header.encoding.as_str()), ("日本\n", "utf-16le"));
        write_file(&p, "日本語のテキストです。\n", &opts("shift_jis", false, LineEnding::Lf)).unwrap();
        let r = read_file(&p, Some("shift_jis"), 100).unwrap();
        assert_eq!(r.text, "日本語のテキストです。\n");
    }

    #[test]
    fn unmappable_does_not_touch_the_file() {
        let d = tempdir().unwrap();
        let p = d.path().join("w.txt");
        fs::write(&p, "old").unwrap();
        let e = write_file(&p, "日本", &opts("windows-1252", false, LineEnding::Lf)).unwrap_err();
        assert_eq!(e.code(), "unmappable");
        assert_eq!(fs::read_to_string(&p).unwrap(), "old");
    }

    #[test]
    fn conflict_check() {
        let d = tempdir().unwrap();
        let p = d.path().join("c.txt");
        fs::write(&p, "one").unwrap();
        let m = stat(&p).mtime_ms;
        let mut o = opts("utf-8", false, LineEnding::Lf);
        o.expected_mtime_ms = Some(m);
        let w = write_file(&p, "two", &o).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        assert_eq!(w.size, 3);
        o.expected_mtime_ms = Some(m - 5000);
        let e = write_file(&p, "three", &o).unwrap_err();
        assert_eq!(e.code(), "conflict");
        assert_eq!(fs::read_to_string(&p).unwrap(), "two");
        o.expected_mtime_ms = None;
        write_file(&p, "three", &o).unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "three");
    }

    #[test]
    fn no_temp_files_are_left() {
        let d = tempdir().unwrap();
        let p = d.path().join("t.txt");
        fs::write(&p, "x").unwrap();
        write_file(&p, "y", &opts("utf-8", false, LineEnding::Lf)).unwrap();
        let names: Vec<_> = fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = d.path().join("run.sh");
        fs::write(&p, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        write_file(&p, "#!/bin/sh\necho hi\n", &opts("utf-8", false, LineEnding::Lf)).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_written_in_place() {
        let d = tempdir().unwrap();
        let target = d.path().join("target.txt");
        let link = d.path().join("link.txt");
        fs::write(&target, "old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        write_file(&link, "new", &opts("utf-8", false, LineEnding::Lf)).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
    }

    #[cfg(unix)]
    #[test]
    fn readonly_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = d.path().join("ro.txt");
        fs::write(&p, "x").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let e = write_file(&p, "y", &opts("utf-8", false, LineEnding::Lf)).unwrap_err();
        assert_eq!(e.code(), "permission_denied");
        assert!(stat(&p).readonly);
    }

    #[test]
    fn non_ascii_and_space_paths() {
        let d = tempdir().unwrap();
        let dir = d.path().join("日本語 フォルダ");
        fs::create_dir(&dir).unwrap();
        let p = dir.join("ファイル name.txt");
        write_file(&p, "中身\n", &opts("utf-8", false, LineEnding::Lf)).unwrap();
        let r = read_file(&p, None, 100).unwrap();
        assert_eq!(r.text, "中身\n");
        assert!(stat(&p).exists);
    }

    #[test]
    fn new_file_and_missing_stat() {
        let d = tempdir().unwrap();
        let p = d.path().join("new.txt");
        let mut o = opts("utf-8", false, LineEnding::Lf);
        o.expected_mtime_ms = Some(0);
        write_file(&p, "hi", &o).unwrap();
        assert!(stat(&p).exists);
        let s = stat(&d.path().join("nope"));
        assert!(!s.exists);
        assert!(stat(d.path()).is_dir);
        let e = write_file(&d.path().join("no_dir/x.txt"), "a", &o).unwrap_err();
        assert_eq!(e.code(), "not_found");
    }
}
