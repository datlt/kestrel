//! Encoding detection, decoding, encoding and line endings.

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use kestrel_common::{Error, Result, error::codes};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

/// How many bytes at the start of a file we check for NUL bytes.
pub const BINARY_CHECK_BYTES: usize = 8192;
/// How many bytes we give to the encoding guesser.
const GUESS_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
    Cr,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
            LineEnding::Cr => "\r",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "lf" => Some(LineEnding::Lf),
            "crlf" => Some(LineEnding::Crlf),
            "cr" => Some(LineEnding::Cr),
            _ => None,
        }
    }
}

pub struct Decoded {
    pub text: String,
    pub encoding: &'static Encoding,
    pub bom: bool,
    /// Some bytes were not valid and became U+FFFD.
    pub lossy: bool,
}

/// Finds an encoding by label (`utf-8`, `shift_jis`, `sjis`, `utf-16le`, ...).
pub fn encoding_by_name(name: &str) -> Result<&'static Encoding> {
    Encoding::for_label(name.trim().as_bytes())
        .ok_or_else(|| Error::invalid(format!("unknown encoding: {name}")))
}

/// Lower case name that the frontend uses, for example `shift_jis`.
pub fn encoding_name(enc: &'static Encoding) -> String {
    enc.name().to_ascii_lowercase()
}

/// True when the first bytes have a NUL byte. Call it only when there is no BOM.
pub fn looks_binary(head: &[u8]) -> bool {
    head[..head.len().min(BINARY_CHECK_BYTES)].contains(&0)
}

/// Picks the encoding when the user did not force one: valid UTF-8 first,
/// then a guess from `chardetng`.
pub fn guess_encoding(bytes: &[u8]) -> &'static Encoding {
    if std::str::from_utf8(bytes).is_ok() {
        return UTF_8;
    }
    let part = &bytes[..bytes.len().min(GUESS_BYTES)];
    let mut det = EncodingDetector::new(Iso2022JpDetection::Allow);
    det.feed(part, part.len() == bytes.len());
    det.guess(None, Utf8Detection::Allow)
}

/// Decodes a whole file. Order: forced encoding, BOM, valid UTF-8, guess.
/// A BOM is removed from the text and reported in `bom`.
pub fn decode(bytes: Vec<u8>, forced: Option<&'static Encoding>) -> Decoded {
    let found = Encoding::for_bom(&bytes);
    let (enc, bom_len) = match (forced, found) {
        (Some(f), Some((b, n))) if b == f => (f, n),
        (Some(f), _) => (f, 0),
        (None, Some((b, n))) => (b, n),
        (None, None) => (guess_encoding(&bytes), 0),
    };
    if enc == UTF_8 {
        let mut bytes = bytes;
        if bom_len > 0 {
            bytes.drain(..bom_len);
        }
        return match String::from_utf8(bytes) {
            Ok(text) => Decoded { text, encoding: enc, bom: bom_len > 0, lossy: false },
            Err(e) => {
                let text = String::from_utf8_lossy(e.as_bytes()).into_owned();
                Decoded { text, encoding: enc, bom: bom_len > 0, lossy: true }
            }
        };
    }
    let body = &bytes[bom_len..];
    match enc.decode_without_bom_handling_and_without_replacement(body) {
        Some(text) => Decoded { text: text.into_owned(), encoding: enc, bom: bom_len > 0, lossy: false },
        None => {
            let (text, _) = enc.decode_without_bom_handling(body);
            Decoded { text: text.into_owned(), encoding: enc, bom: bom_len > 0, lossy: true }
        }
    }
}

pub struct LineEndingInfo {
    pub ending: LineEnding,
    pub mixed: bool,
}

/// Counts the line endings. The most common one wins (ties: LF, CRLF, CR).
/// A text without line breaks counts as LF.
pub fn detect_line_ending(text: &str) -> LineEndingInfo {
    let b = text.as_bytes();
    let (mut lf, mut crlf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => lf += 1,
            b'\r' => {
                if b.get(i + 1) == Some(&b'\n') {
                    crlf += 1;
                    i += 1;
                } else {
                    cr += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let kinds = [lf, crlf, cr].iter().filter(|n| **n > 0).count();
    let ending = if lf >= crlf && lf >= cr {
        LineEnding::Lf
    } else if crlf >= cr {
        LineEnding::Crlf
    } else {
        LineEnding::Cr
    };
    LineEndingInfo { ending, mixed: kinds > 1 }
}

/// Replaces each `\n` with the chosen line ending.
pub fn apply_line_ending(text: &str, le: LineEnding) -> Cow<'_, str> {
    if le == LineEnding::Lf || !text.contains('\n') {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(text.replace('\n', le.as_str()))
    }
}

/// Encodes text. Fails with `unmappable` when the encoding cannot store a character.
pub fn encode(text: &str, enc: &'static Encoding, bom: bool) -> Result<Vec<u8>> {
    if enc == UTF_16LE || enc == UTF_16BE {
        let le = enc == UTF_16LE;
        let mut out = Vec::with_capacity(text.len() * 2 + 2);
        if bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for u in text.encode_utf16() {
            out.extend_from_slice(&if le { u.to_le_bytes() } else { u.to_be_bytes() });
        }
        return Ok(out);
    }
    if enc.output_encoding() != enc {
        return Err(Error::invalid(format!("cannot save with encoding {}", enc.name())));
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(Error::new(
            codes::UNMAPPABLE,
            format!("some characters cannot be stored in {}", enc.name()),
        ));
    }
    let mut out = Vec::with_capacity(bytes.len() + 3);
    if bom && enc == UTF_8 {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(&bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_plain() {
        let d = decode("héllo\n".as_bytes().to_vec(), None);
        assert_eq!(d.text, "héllo\n");
        assert_eq!(d.encoding, UTF_8);
        assert!(!d.bom && !d.lossy);
    }

    #[test]
    fn utf8_bom_is_removed_and_reported() {
        let mut b = vec![0xEF, 0xBB, 0xBF];
        b.extend_from_slice("abc".as_bytes());
        let d = decode(b, None);
        assert_eq!(d.text, "abc");
        assert!(d.bom);
    }

    #[test]
    fn utf16_with_bom_both_orders() {
        let le: Vec<u8> = [0xFF, 0xFE].into_iter().chain("あa".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
        let d = decode(le, None);
        assert_eq!((d.text.as_str(), d.encoding, d.bom), ("あa", UTF_16LE, true));
        let be: Vec<u8> = [0xFE, 0xFF].into_iter().chain("あa".encode_utf16().flat_map(|u| u.to_be_bytes())).collect();
        let d = decode(be, None);
        assert_eq!((d.text.as_str(), d.encoding, d.bom), ("あa", UTF_16BE, true));
    }

    #[test]
    fn shift_jis_is_guessed() {
        let (bytes, _, bad) = encoding_rs::SHIFT_JIS.encode("これは日本語のテキストです。設定ファイルを読み込みます。\n");
        assert!(!bad);
        let d = decode(bytes.into_owned(), None);
        assert_eq!(d.encoding, encoding_rs::SHIFT_JIS);
        assert!(d.text.starts_with("これは日本語"));
        assert!(!d.lossy);
    }

    #[test]
    fn forced_encoding_wins() {
        let (bytes, _, _) = encoding_rs::SHIFT_JIS.encode("日本語");
        let d = decode(bytes.into_owned(), Some(encoding_rs::SHIFT_JIS));
        assert_eq!(d.text, "日本語");
    }

    #[test]
    fn invalid_utf8_forced_is_lossy() {
        let d = decode(vec![b'a', 0xFF, b'b'], Some(UTF_8));
        assert!(d.lossy);
        assert_eq!(d.text, "a\u{FFFD}b");
    }

    #[test]
    fn empty_is_utf8() {
        let d = decode(Vec::new(), None);
        assert_eq!(d.text, "");
        assert_eq!(d.encoding, UTF_8);
    }

    #[test]
    fn line_endings() {
        let i = detect_line_ending("a\r\nb\r\nc\r\n");
        assert_eq!((i.ending, i.mixed), (LineEnding::Crlf, false));
        let i = detect_line_ending("a\nb\r\nc\n");
        assert_eq!((i.ending, i.mixed), (LineEnding::Lf, true));
        let i = detect_line_ending("a\rb\rc");
        assert_eq!((i.ending, i.mixed), (LineEnding::Cr, false));
        let i = detect_line_ending("no breaks");
        assert_eq!((i.ending, i.mixed), (LineEnding::Lf, false));
        assert_eq!(apply_line_ending("a\nb", LineEnding::Crlf), "a\r\nb");
        assert_eq!(apply_line_ending("a\nb", LineEnding::Cr), "a\rb");
    }

    #[test]
    fn encode_round_trips() {
        let enc = encoding_by_name("shift_jis").unwrap();
        let bytes = encode("日本語", enc, false).unwrap();
        assert_eq!(decode(bytes, Some(enc)).text, "日本語");
        let bytes = encode("a", UTF_16LE, true).unwrap();
        assert_eq!(bytes, vec![0xFF, 0xFE, b'a', 0]);
        let bytes = encode("a", UTF_16BE, false).unwrap();
        assert_eq!(bytes, vec![0, b'a']);
        assert_eq!(encode("a", UTF_8, true).unwrap(), vec![0xEF, 0xBB, 0xBF, b'a']);
    }

    #[test]
    fn unmappable_is_an_error() {
        let enc = encoding_by_name("windows-1252").unwrap();
        let e = encode("日本", enc, false).unwrap_err();
        assert_eq!(e.code(), "unmappable");
    }

    #[test]
    fn unknown_encoding_name() {
        assert_eq!(encoding_by_name("nope").unwrap_err().code(), "invalid_input");
        assert_eq!(encoding_name(encoding_by_name("SJIS").unwrap()), "shift_jis");
    }
}
