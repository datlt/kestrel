//! The types that go over the IPC boundary. They match `src/ipc/code.ts`:
//! camelCase field names, the same enum strings, and optional fields are
//! left out when they are not set.

use kestrel_lang::{Lang, MemberKind, TypeKind, UsageKind, Visibility};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    /// Not built yet.
    None,
    Building,
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexStatus {
    pub state: IndexState,
    pub files: usize,
    pub types: usize,
    pub build_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    Extends,
    Implements,
    Composition,
    Aggregation,
    Dependency,
    Nested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Out,
    In,
    Both,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiagramScope {
    Cursor { path: String, line: u32, column: u32, text: Option<String> },
    File { path: String, text: Option<String> },
    Folder { path: String },
    Types { ids: Vec<String> },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramRequest {
    pub root: String,
    pub scope: DiagramScope,
    pub relations: Vec<RelationKind>,
    pub depth: u32,
    pub direction: Direction,
    pub include_external: bool,
    pub max_nodes: usize,
    /// Hub limit per direction. Default 20, kept between 1 and 500.
    pub max_fan: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramMember {
    pub name: String,
    pub kind: MemberKind,
    pub visibility: Visibility,
    #[serde(rename = "static")]
    pub is_static: bool,
    #[serde(rename = "abstract")]
    pub is_abstract: bool,
    #[serde(rename = "type")]
    pub ty: String,
    pub params: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramNode {
    pub id: String,
    pub name: String,
    pub container: String,
    pub kind: TypeKind,
    pub lang: Option<Lang>,
    pub path: Option<String>,
    pub line: u32,
    pub column: u32,
    pub modifiers: Vec<String>,
    pub annotations: Vec<String>,
    pub type_params: Vec<String>,
    pub fields: Vec<DiagramMember>,
    pub methods: Vec<DiagramMember>,
    pub members_truncated: bool,
    pub external: bool,
    /// Neighbors not added because there are more than 20 in one direction.
    #[serde(skip_serializing_if = "is_zero")]
    pub hidden_in: usize,
    #[serde(skip_serializing_if = "is_zero")]
    pub hidden_out: usize,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramEdge {
    pub from: String,
    pub to: String,
    pub kind: RelationKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub multiplicity: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub delegated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramResult {
    pub nodes: Vec<DiagramNode>,
    pub edges: Vec<DiagramEdge>,
    pub focus: Vec<String>,
    pub truncated: bool,
    pub index: CodeIndexStatus,
}

// --- Usages ------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagesRequest {
    pub root: String,
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub text: Option<String>,
    #[serde(default)]
    pub wide: bool,
    pub max_results: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageMatch {
    pub line: u32,
    pub column: u32,
    pub text: String,
    pub range: [u32; 2],
    pub kind: UsageKind,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageFile {
    pub path: String,
    pub likely: bool,
    pub matches: Vec<UsageMatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Type,
    Member,
    TopLevel,
    Local,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Declaration {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSymbol {
    pub name: String,
    pub kind: SymbolKind,
    /// More exact kind: a `TypeKind`, a member kind, `function`, `variable` or `parameter`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declaration: Option<Declaration>,
    /// `null` for files that are not Kotlin, Java or Swift.
    pub lang: Option<Lang>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagesResult {
    pub symbol: Option<UsageSymbol>,
    pub files: Vec<UsageFile>,
    pub total: usize,
    pub truncated: bool,
    pub exact: bool,
    pub file_only: bool,
    pub elapsed_ms: u64,
}
