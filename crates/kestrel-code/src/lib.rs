//! kestrel-code: the code index of a project (Kotlin, Java and Swift types),
//! the class diagram graph and "find usages". It has no Tauri code.
//! See docs/DESIGN.md, section 11.
//!
//! Use `CodeManager`: it keeps one index per root, shared by the windows.

mod callers;
mod cmodel;
mod derived;
mod find;
mod diagram;
mod index;
mod manager;
mod textutil;
mod types;
mod usages;
mod walk;

pub use index::Index;
pub use manager::CodeManager;
pub use find::{FindRequest, FindResult, SymbolHit, SymbolKindOut, TypeHit};
pub use types::*;

#[doc(hidden)]
pub mod internals {
    pub use crate::cmodel::*;
    pub use crate::derived::*;
    pub use crate::find::{match_name, Pattern, Query, Scratch};
    pub use crate::diagram::run as run_diagram;
    pub use crate::index::*;
    pub use crate::textutil::*;
    pub use crate::callers::{is_test_path, run as run_callers};
    pub use crate::usages::run as run_usages;
    pub use crate::walk::*;
}

#[cfg(test)]
mod tests;
