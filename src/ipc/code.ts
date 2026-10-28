// IPC for the code index: class diagram and find usages. Owner: integrator (contract).
// Rust side: src-tauri/src/cmd/code.rs and crates/kestrel-code. See docs/DESIGN.md, section 11.
//
// Lines are 1-based. Columns are 1-based and count UTF-16 code units, like
// CodeMirror and the search results.

import { invoke } from './invoke';

export type CodeLang = 'kotlin' | 'java' | 'swift';

export type TypeKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'record'
  | 'annotation'
  | 'object'
  | 'struct'
  | 'protocol'
  | 'actor'
  | 'extension'
  | 'typeAlias';

export type Visibility = 'public' | 'protected' | 'internal' | 'package' | 'private';

// --- Index -------------------------------------------------------------------

export interface CodeIndexStatus {
  /** `none`: not built yet. The first diagram or usages request builds it. */
  state: 'none' | 'building' | 'ready';
  /** Kotlin, Java and Swift files in the index. */
  files: number;
  types: number;
  /** Time of the last full build. */
  buildMs: number;
}

/** Does not start a build. */
export function codeIndexStatus(root: string): Promise<CodeIndexStatus> {
  return invoke<CodeIndexStatus>('code_index_status', { root });
}

/**
 * Tells the index about changed, new or deleted files (absolute paths).
 * `rescan` reads the whole folder again. Does nothing when the index of this
 * root was not built yet.
 */
export function codeIndexUpdate(root: string, paths: string[], rescan: boolean): Promise<void> {
  return invoke<void>('code_index_update', { root, paths, rescan });
}

/** Frees the index of this root for this window (call it when the folder closes). */
export function codeIndexDrop(root: string): Promise<void> {
  return invoke<void>('code_index_drop', { root });
}

/** Stops a running `codeDiagram`, `codeUsages`, `codeCallers`, `codeFindTypes` or `codeFindSymbols` call. It then rejects with code `cancelled`. */
export function codeCancel(id: number): Promise<void> {
  return invoke<void>('code_cancel', { id });
}

let nextId = 1;
/** A new id for the `code*` requests that take one (to cancel them). */
export function newCodeRequestId(): number {
  return nextId++;
}

// --- Class diagram -----------------------------------------------------------

/**
 * - `extends`: subclass to superclass (also interface to interface in Kotlin
 *   and Swift when the parser cannot tell, see DESIGN.md 11.3).
 * - `implements`: class to interface or protocol.
 * - `composition`: owner to part. A field or property holds one object of the part type.
 * - `aggregation`: owner to part. A field or property holds many (list, set,
 *   map value, array) of the part type.
 * - `dependency`: user to used type. Method parameters, return types and code
 *   in bodies use the type, and no other edge links the two types.
 * - `nested`: outer type to nested type.
 */
export type RelationKind = 'extends' | 'implements' | 'composition' | 'aggregation' | 'dependency' | 'nested';

export const ALL_RELATIONS: readonly RelationKind[] = [
  'extends',
  'implements',
  'composition',
  'aggregation',
  'dependency',
  'nested',
];

export type DiagramScope =
  /**
   * The type at the cursor: the type whose name is under the cursor (also a
   * use, like `: Foo` or `Foo()`), else the innermost type around the cursor.
   * `text`: the editor text when the file has unsaved changes.
   */
  | { kind: 'cursor'; path: string; line: number; column: number; text?: string }
  /** All types declared in one file. */
  | { kind: 'file'; path: string; text?: string }
  /** All types declared in the files of a folder (with sub folders). */
  | { kind: 'folder'; path: string }
  /** These types (node ids from an earlier result). */
  | { kind: 'types'; ids: string[] };

export interface DiagramRequest {
  /** Workspace root. The index covers this folder. */
  root: string;
  scope: DiagramScope;
  /** The edges to follow and to show. */
  relations: RelationKind[];
  /** Steps to follow from the start types (0 to 5). 0: only the start types and the edges between them. */
  depth: number;
  /**
   * `out`: follow edges away from the start types (superclasses, interfaces,
   * parts, used types). `in`: follow edges to them (subclasses, implementations,
   * owners, users). `both`: both ways.
   */
  direction: 'out' | 'in' | 'both';
  /** Show types that are not in the project (JDK, libraries, UIKit) as extra nodes. */
  includeExternal: boolean;
  /** Stop after this many nodes. The nearest types are kept. */
  maxNodes: number;
  /**
   * A type with more neighbors than this in one direction is a hub: the walk
   * does not follow them, and the node gets `hiddenIn` / `hiddenOut`. Start
   * types add this many of them. Default 20. "Show more" sends a big value.
   */
  maxFan?: number;
}

export interface DiagramMember {
  name: string;
  kind: 'field' | 'property' | 'constructor' | 'method' | 'enumCase';
  visibility: Visibility;
  static: boolean;
  abstract: boolean;
  /** Field type or method return type as written. Empty when the code does not say. */
  type: string;
  /** Parameters as one text, in the style of the language: `id: Long, name: String` or `long id, String name`. */
  params: string;
  /** Position of the name (column in UTF-16 units). */
  line: number;
  column: number;
}

export interface DiagramNode {
  /**
   * Stable id. Project types: the qualified name (`jp.example.FooService`,
   * `jp.example.Outer.Inner`; Swift: the name with outer types). Two project
   * types with the same qualified name get `#2`, `#3` after the second one.
   * External types: `ext:` and the name as written (`ext:JpaRepository`).
   */
  id: string;
  name: string;
  /** Package and outer types (`jp.example`, `jp.example.Outer`), or the Swift folder of the file. */
  container: string;
  kind: TypeKind;
  /** null for external types. */
  lang: CodeLang | null;
  /** Absolute path of the file. null for external types. */
  path: string | null;
  /** Position of the name (column in UTF-16 units). 0 for external types. */
  line: number;
  column: number;
  modifiers: string[];
  annotations: string[];
  typeParams: string[];
  /** At most 60 fields and 60 methods. Swift: members of extensions in the project are included. */
  fields: DiagramMember[];
  methods: DiagramMember[];
  membersTruncated: boolean;
  external: boolean;
  /**
   * Neighbors that the walk did not add because this type has too many of
   * them (more than 20 in one direction, for example a `Logger` that 300
   * classes hold). `in`: subtypes, owners and users. `out`: supertypes,
   * parts and used types. Only the chosen relations count. Not set when 0.
   */
  hiddenIn?: number;
  hiddenOut?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: RelationKind;
  /** composition and aggregation: the field names, joined with `, `. */
  label?: string;
  /** aggregation: `*`. composition of a nullable field: `0..1`. Else not set. */
  multiplicity?: string;
  /** Kotlin `by` delegation (on `implements`). */
  delegated?: boolean;
}

export interface DiagramResult {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Ids of the start types. Empty when the scope has no type. */
  focus: string[];
  /** More types matched than `maxNodes`. */
  truncated: boolean;
  index: CodeIndexStatus;
}

/** Builds the index first when needed (this can take some seconds on a big project). */
export function codeDiagram(id: number, request: DiagramRequest): Promise<DiagramResult> {
  return invoke<DiagramResult>('code_diagram', { id, request });
}

// --- Find usages -------------------------------------------------------------

export type UsageKind = 'declaration' | 'import' | 'supertype' | 'instantiation' | 'type' | 'call' | 'reference';

export interface UsagesRequest {
  root: string;
  /** The file and the position of the name. */
  path: string;
  line: number;
  column: number;
  /** The editor text when the file has unsaved changes. Other files are read from disk. */
  text?: string;
  /** Local names: also search other files (default: only this file). */
  wide?: boolean;
  /** Stop after this many matches. */
  maxResults: number;
}

export interface UsageMatch {
  line: number;
  column: number;
  /** The line without leading white space. Long lines are cut around the name. */
  text: string;
  /** `[start, end)` of the name in `text`, UTF-16 units. */
  range: [number, number];
  kind: UsageKind;
}

export interface UsageFile {
  /** Absolute path. */
  path: string;
  /**
   * True when this file can see the symbol: it is the file of the
   * declaration, or it imports or names the declaring type (or a type
   * related to it). False: only the same name. Show those files in a
   * separate group that is closed at first.
   */
  likely: boolean;
  matches: UsageMatch[];
}

export interface UsageSymbol {
  name: string;
  /**
   * `type`: a class, interface, enum ... `member`: a field, property or
   * method of a type. `topLevel`: a Kotlin top-level or Swift global function
   * or property. `local`: a parameter or local variable. `unknown`: the name
   * is not declared in the project (or the file is not Kotlin, Java or Swift).
   */
  kind: 'type' | 'member' | 'topLevel' | 'local' | 'unknown';
  /**
   * More exact kind, for the header ("class FooService", "method save").
   * Types: the `TypeKind`. Members and top-level symbols: `field`,
   * `property`, `method`, `constructor`, `enumCase`, `function`, `variable`.
   * Local names: `parameter` or `variable`. Not set when unknown.
   */
  detail?: TypeKind | 'field' | 'property' | 'method' | 'constructor' | 'enumCase' | 'function' | 'variable' | 'parameter';
  /** Qualified name of the type (kind `type`) or of the type that declares the member. */
  owner?: string;
  declaration?: { path: string; line: number; column: number };
  lang: CodeLang | null;
}

export interface UsagesResult {
  /** null: there is no name at the position. */
  symbol: UsageSymbol | null;
  files: UsageFile[];
  total: number;
  truncated: boolean;
  /**
   * True when Kestrel checked that the matches mean this symbol (types: the
   * imports and the package decide). False when it only matched the name.
   */
  exact: boolean;
  /** `local` names: only the file was searched. Search again with `wide` for all files. */
  fileOnly: boolean;
  elapsedMs: number;
}

/**
 * Finds the usages of the name at a position, without a language server.
 * Kotlin, Java and Swift files use the code index; other files get a
 * whole-word search in files of the same language.
 */
export function codeUsages(id: number, request: UsagesRequest): Promise<UsagesResult> {
  return invoke<UsagesResult>('code_usages', { id, request });
}

// --- Call hierarchy ----------------------------------------------------------

/** A method, constructor, function or property that calls, or is called. */
export interface CallTarget {
  /** Qualified name of the type that declares it. Empty for Kotlin top-level and Swift global functions. */
  owner: string;
  name: string;
  /**
   * `initializer`: code that is not in a method: a field or property
   * initializer, a Kotlin `init` block, a Java static block, top-level code of
   * a `.kts` file.
   */
  kind: 'method' | 'constructor' | 'function' | 'property' | 'initializer';
  /** Parameters as one text (`id: Long, name: String`), to tell overloads apart. Empty when none. */
  params: string;
  /** Position of the name. */
  path: string;
  line: number;
  column: number;
  lang: CodeLang;
}

export interface CallSite {
  line: number;
  column: number;
  /** The line without leading white space, cut like the usages. */
  text: string;
  /** `[start, end)` of the called name in `text`, UTF-16 units. */
  range: [number, number];
}

export interface CallerNode {
  /** The method (or other code) that calls. Expand it with `codeCallers({ target })`. */
  caller: CallTarget;
  /** Where it calls, in the order of the file. */
  sites: CallSite[];
  /** False: only the name matched (another type can have a method with this name). */
  likely: boolean;
  /** The file is test code (a `test`, `tests`, `testByKotest`, `androidTest` ... folder, or `*Test`, `*Tests`, `*Spec` files). */
  test: boolean;
}

export interface CallersRequest {
  root: string;
  /** The start: the method at a position (on its declaration or on a call), or a target from an earlier answer. */
  at?: { path: string; line: number; column: number; text?: string };
  target?: CallTarget;
  maxResults: number;
}

export interface CallersResult {
  /** The method that the callers call. null: no method, constructor, function or property at the position. */
  target: CallTarget | null;
  /** Sorted by path, then line. */
  callers: CallerNode[];
  /** Same meaning as `UsagesResult.exact`. */
  exact: boolean;
  truncated: boolean;
  elapsedMs: number;
}

/**
 * Callers of a method, one level. The UI asks again for each caller that the
 * user opens, so the tree can go up as far as needed.
 */
export function codeCallers(id: number, request: CallersRequest): Promise<CallersResult> {
  return invoke<CallersResult>('code_callers', { id, request });
}

// --- Go to class and go to symbol --------------------------------------------

/**
 * The query, as the user types it in Search Everywhere. Rust understands:
 * - camel humps and parts: `NABS`, `NewArrBS`, `newArrival service` all find
 *   `NewArrivalBookService`; case only matters for the upper-case hump letters;
 * - `*` as "anything": `*Repository`, `Book*Mapper`;
 * - a dotted qualifier: `cart.Service` (the package or the outer types contain
 *   `cart`), `Outer.Inner`, and for symbols `Type.method` or `Type#method`;
 * - a trailing space: the name must end there (`Book ` finds `Book`, not `BookMapper`).
 * The frontend removes a trailing `:line` or `:line:column` before it sends the query.
 */
export interface FindRequest {
  root: string;
  query: string;
  /** Default 100. */
  limit?: number;
  /** Leave out test code (the same rule as `CallerNode.test`). */
  excludeTests?: boolean;
  /** Only these languages. Empty or not set: all. */
  langs?: CodeLang[];
}

export interface TypeHit {
  name: string;
  /** Qualified name, the same as `DiagramNode.id` without `#n`. */
  qualified: string;
  /** Package and outer types, or the Swift folder. */
  container: string;
  kind: TypeKind;
  lang: CodeLang;
  /** Absolute path. */
  path: string;
  /** Position of the name (column in UTF-16 units). */
  line: number;
  column: number;
  /** Indexes (UTF-16) of the matched characters in `name`, for bold text. */
  nameMatches: number[];
  /** Indexes in `container` matched by a dotted qualifier. */
  containerMatches: number[];
  test: boolean;
}

export interface SymbolHit {
  name: string;
  kind: 'method' | 'constructor' | 'field' | 'property' | 'enumCase' | 'function' | 'variable';
  /** Qualified name of the declaring type. Empty for Kotlin top-level and Swift global symbols. */
  owner: string;
  /** Simple name of the declaring type (or the file name for top-level symbols). */
  ownerName: string;
  /** Parameters as text, like `DiagramMember.params`. Empty for fields. */
  params: string;
  /** Field type or return type as written. Empty when unknown. */
  type: string;
  visibility: Visibility;
  lang: CodeLang;
  /** Absolute path. */
  path: string;
  line: number;
  column: number;
  nameMatches: number[];
  test: boolean;
}

export interface FindResult<T> {
  /** Best first. */
  items: T[];
  /** More items matched than `limit`. */
  truncated: boolean;
  /** The index is `ready` when the call returns (the call waits for a build). */
  index: CodeIndexStatus;
  elapsedMs: number;
}

/** Types whose name matches the query (Go to Class). Builds the index first when needed. */
export function codeFindTypes(id: number, request: FindRequest): Promise<FindResult<TypeHit>> {
  return invoke<FindResult<TypeHit>>('code_find_types', { id, request });
}

/** Methods, fields, properties and top-level functions whose name matches (Go to Symbol). */
export function codeFindSymbols(id: number, request: FindRequest): Promise<FindResult<SymbolHit>> {
  return invoke<FindResult<SymbolHit>>('code_find_symbols', { id, request });
}
