//! kestrel-lsp: runs language server processes and speaks the LSP wire format
//! (JSON messages with `Content-Length` headers). It does not parse LSP
//! messages. The frontend owns the protocol; this crate moves the bytes.

pub mod framing;
pub mod root;
pub mod server;

pub use framing::{FrameDecoder, encode_frame};
pub use root::{find_root, root_hash};
pub use server::{Callbacks, ExitInfo, Server, SpawnOptions};
