//! kestrel-markdown: markdown to HTML (comrak) and the helpers for the
//! `preview://` protocol (path decoding, MIME types, HTTP ranges).
//! This crate has no Tauri dependency.

mod protocol;
mod render;

pub use protocol::{ByteRange, decode_uri_path, mime_for, parse_range};
pub use render::render;
