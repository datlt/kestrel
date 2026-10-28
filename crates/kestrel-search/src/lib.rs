//! kestrel-search: the file index with fuzzy matching (quick open) and the
//! text search (find in files). It has no Tauri code. See docs/DESIGN.md, 7.4.

mod fuzzy;
mod index;
mod store;
mod text;
mod walk;

pub use fuzzy::{FileHit, QueryResult};
pub use index::{FileIndex, IndexManager, IndexState, IndexStatus, ReadyListener};
pub use text::{search_text, FileMatches, LineMatch, TextOptions, TextSummary};
