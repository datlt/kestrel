//! `Content-Length` framing for JSON-RPC messages.
//!
//! A frame is: header lines ending with `\r\n`, an empty line, then the body.
//! The only header we need is `Content-Length` (the size of the body in bytes).

/// Biggest body we accept. A bigger value means the stream is broken.
const MAX_BODY: usize = 512 * 1024 * 1024;
/// Biggest header block we accept before we give up on it.
const MAX_HEADER: usize = 16 * 1024;

/// Turns a message body into one frame.
pub fn encode_frame(body: &str) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body.as_bytes());
    out
}

/// Collects bytes from the server and returns complete messages.
/// Bytes can arrive in any size: half a header, several messages at once, and so on.
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    /// Body length of the frame whose header we already read.
    need: Option<usize>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds bytes and returns every message that is complete now.
    /// Bodies that are not valid UTF-8 are converted with replacement characters.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        let mut pos = 0;
        loop {
            if self.need.is_none() {
                match find_header_end(&self.buf[pos..]) {
                    Some((header_len, skip)) => {
                        let header = &self.buf[pos..pos + header_len];
                        pos += header_len + skip;
                        self.need = parse_content_length(header);
                        // A header block without a valid length is dropped.
                        if self.need.is_none() {
                            continue;
                        }
                    }
                    None => {
                        // No end of header yet. If the block is huge, the stream is broken: drop it.
                        if self.buf.len() - pos > MAX_HEADER {
                            pos = self.buf.len();
                        }
                        break;
                    }
                }
            }
            let need = self.need.unwrap();
            if self.buf.len() - pos < need {
                break;
            }
            out.push(String::from_utf8_lossy(&self.buf[pos..pos + need]).into_owned());
            pos += need;
            self.need = None;
        }
        self.buf.drain(..pos);
        out
    }
}

/// Finds the empty line that ends a header block.
/// Returns (length of the header text, length of the separator).
/// We also accept bare `\n\n`, because some servers are sloppy.
fn find_header_end(buf: &[u8]) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < buf.len() {
        if buf[i..].starts_with(b"\r\n\r\n") {
            return Some((i, 4));
        }
        if buf[i..].starts_with(b"\n\n") {
            return Some((i, 2));
        }
        i += 1;
    }
    None
}

fn parse_content_length(header: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(header);
    for line in text.lines() {
        let Some((name, value)) = line.split_once(':') else { continue };
        if name.trim().eq_ignore_ascii_case("content-length") {
            let n: usize = value.trim().parse().ok()?;
            return (n <= MAX_BODY).then_some(n);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut d = FrameDecoder::new();
        chunks.iter().flat_map(|c| d.push(c)).collect()
    }

    #[test]
    fn encodes_byte_length_not_char_count() {
        let f = encode_frame("{\"a\":\"日本\"}");
        let text = String::from_utf8(f).unwrap();
        assert!(text.starts_with("Content-Length: 14\r\n\r\n"), "{text}");
    }

    #[test]
    fn one_message() {
        assert_eq!(decode_all(&[b"Content-Length: 2\r\n\r\n{}"]), vec!["{}"]);
    }

    #[test]
    fn several_messages_in_one_read() {
        let mut data = encode_frame("{\"id\":1}");
        data.extend(encode_frame("{\"id\":2}"));
        data.extend(encode_frame("{\"id\":3}"));
        assert_eq!(decode_all(&[&data]), vec!["{\"id\":1}", "{\"id\":2}", "{\"id\":3}"]);
    }

    #[test]
    fn one_byte_at_a_time() {
        let mut data = encode_frame("{\"x\":\"héllo 日本語 😀\"}");
        data.extend(encode_frame("{}"));
        let chunks: Vec<&[u8]> = data.chunks(1).collect();
        assert_eq!(decode_all(&chunks), vec!["{\"x\":\"héllo 日本語 😀\"}", "{}"]);
    }

    #[test]
    fn split_inside_header_and_inside_utf8_char() {
        let data = encode_frame("{\"x\":\"日\"}");
        // Split in the middle of the 3-byte character.
        let cut = data.len() - 4;
        assert_eq!(decode_all(&[&data[..10], &data[10..cut], &data[cut..]]), vec!["{\"x\":\"日\"}"]);
    }

    #[test]
    fn extra_headers_and_case() {
        let raw = b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}";
        assert_eq!(decode_all(&[raw]), vec!["{}"]);
    }

    #[test]
    fn header_without_length_is_skipped() {
        let mut data = b"X-Foo: bar\r\n\r\n".to_vec();
        data.extend(encode_frame("{}"));
        assert_eq!(decode_all(&[&data]), vec!["{}"]);
    }

    #[test]
    fn empty_body() {
        assert_eq!(decode_all(&[b"Content-Length: 0\r\n\r\n"]), vec![""]);
    }

    #[test]
    fn invalid_utf8_is_replaced() {
        let out = decode_all(&[b"Content-Length: 3\r\n\r\n\xff\xfe!"]);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains('\u{fffd}') && out[0].ends_with('!'));
    }

    #[test]
    fn huge_length_is_rejected() {
        let out = decode_all(&[b"Content-Length: 99999999999\r\n\r\n", &encode_frame("{}")]);
        assert_eq!(out, vec!["{}"]);
    }

    #[test]
    fn incomplete_body_waits() {
        let mut d = FrameDecoder::new();
        assert!(d.push(b"Content-Length: 4\r\n\r\nab").is_empty());
        assert_eq!(d.push(b"cd"), vec!["abcd"]);
    }
}
