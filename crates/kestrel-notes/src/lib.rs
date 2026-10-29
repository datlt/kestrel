//! kestrel-notes: the index of the markdown files of a folder, for the Graph
//! View and the wiki links of the preview. It has no Tauri code.
//! See docs/DESIGN.md, section 14.
//!
//! Use `NoteManager`: it keeps one index per root, shared by the windows.

mod graph;
mod index;
mod manager;
mod resolve;
mod scan;
mod types;
mod walk;

pub use index::{build_index, update_index, Index, NoteEntry};
pub use manager::{resolve_link, NoteManager};
pub use scan::{clean_dest, percent_decode, scan, CleanDest, LinkKind, RawLink, Scanned, MAX_NOTE_BYTES};
pub use types::*;
pub use walk::{MAX_FILES, MAX_NOTES};

#[cfg(test)]
mod scan_tests;
