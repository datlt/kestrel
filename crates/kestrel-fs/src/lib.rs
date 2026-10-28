//! File system logic for Kestrel, without Tauri.
//!
//! - `text`: encoding detection, decoding, encoding, line endings.
//! - `file`: read, safe write and stat.
//! - `dir`: list folders (with .gitignore flags), create, rename, delete.
//! - `watch`: debounced folder watcher.
//! - `store`: JSON files for recent folders, sessions and global state.

pub mod dir;
pub mod file;
pub mod store;
pub mod text;
pub mod watch;

pub use dir::{DirEntry, ListOptions, create_dir, create_file, delete, list_dir, list_dir_with, rename};
pub use file::{ReadHeader, ReadOutput, StatResult, WriteOptions, WriteResult, read_file, stat, write_file};
pub use store::Store;
pub use text::LineEnding;
pub use watch::{FsChange, Watcher};
