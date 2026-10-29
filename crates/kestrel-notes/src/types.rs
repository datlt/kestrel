//! Types of the note index. They serialize to the shapes of `src/ipc/notes.ts`.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use std::sync::Arc;

/// State of the index of one root.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    /// Not built yet.
    None,
    /// A build is running.
    Building,
    /// The index can answer.
    Ready,
}

/// Answer of `notes_index_status`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexStatus {
    pub state: IndexState,
    /// Markdown files in the index.
    pub notes: usize,
    /// Other files that notes can link to.
    pub files: usize,
    /// Time of the last full build.
    pub build_ms: u64,
}

/// Kind of a graph node.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum NoteNodeKind {
    /// A markdown file.
    Note,
    /// Another file inside the root that a note links to.
    Attachment,
    /// A link target that does not exist.
    Missing,
}

/// One node of the graph.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteNode {
    pub kind: NoteNodeKind,
    /// Absolute path.
    pub path: String,
    /// Path relative to the root, with `/`.
    pub rel: String,
    /// File name without the markdown extension.
    pub name: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub size: u64,
    pub mtime_ms: u64,
}

/// All links from one note to one target.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteLink {
    pub from: u32,
    pub to: u32,
    pub count: u32,
    pub embeds: u32,
    pub line: u32,
}

/// The cached part of a graph answer.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub root: String,
    pub nodes: Vec<NoteNode>,
    pub links: Vec<NoteLink>,
    pub truncated: bool,
}

/// Answer of `notes_graph`. The data is shared with the cache of the index,
/// so a cached answer costs no copy. It serializes as one flat object.
#[derive(Clone, Debug)]
pub struct NoteGraph {
    pub data: Arc<GraphData>,
    /// Time to build this answer (not the index).
    pub elapsed_ms: u64,
}

impl Serialize for NoteGraph {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("NoteGraph", 5)?;
        st.serialize_field("root", &self.data.root)?;
        st.serialize_field("nodes", &self.data.nodes)?;
        st.serialize_field("links", &self.data.links)?;
        st.serialize_field("truncated", &self.data.truncated)?;
        st.serialize_field("elapsedMs", &self.elapsed_ms)?;
        st.end()
    }
}

/// Answer of `notes_resolve`.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLink {
    /// Absolute path. For a target that does not exist: where it would be created.
    pub path: String,
    pub exists: bool,
    pub kind: NoteNodeKind,
    /// The part after `#` without `^`, else null.
    pub heading: Option<String>,
    /// True when the part after `#` started with `^`.
    pub block: bool,
}
