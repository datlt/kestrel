//! What a parser reads from one source file. Owner: integrator (contract).
//! The parsers (`kotlin.rs`, `java.rs`, `swift.rs`) fill these types, and
//! `kestrel-code` builds the project index and the class diagram from them.
//!
//! Rules for every parser:
//! - Never panic and never fail. Broken or unfinished code gives a partial result.
//! - Lines and columns are 1-based. Columns count bytes of UTF-8 here;
//!   `kestrel-code` converts them to UTF-16 for the frontend.
//! - Names keep the case and the spelling of the source. Backticks around
//!   Kotlin and Swift names are removed: `` `is` `` gives `is`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Kotlin,
    Java,
    Swift,
}

impl Lang {
    /// The language of a file from its extension: `kt` and `kts` (Kotlin),
    /// `java`, `swift`. The check ignores case. `None` for other files.
    pub fn from_extension(ext: &str) -> Option<Lang> {
        match ext.to_ascii_lowercase().as_str() {
            "kt" | "kts" => Some(Lang::Kotlin),
            "java" => Some(Lang::Java),
            "swift" => Some(Lang::Swift),
            _ => None,
        }
    }

    /// Kotlin and Java code can use each other, so a search for a JVM name
    /// looks at both. Swift stays alone.
    pub fn is_jvm(self) -> bool {
        matches!(self, Lang::Kotlin | Lang::Java)
    }
}

/// Everything that a parser reads from one file.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileModel {
    /// `package a.b.c` (Kotlin, Java). Empty for the default package and for Swift.
    pub package: String,
    pub imports: Vec<Import>,
    /// All types of the file, also nested ones. An outer type comes before
    /// its nested types. `TypeDecl::outer` is an index into this list.
    pub types: Vec<TypeDecl>,
    /// Kotlin top-level functions and properties. Swift global functions and
    /// variables. Java has none.
    pub top_level: Vec<Member>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    /// The dotted path as written, without `.*`: `a.b.C` for `import a.b.C`,
    /// `a.b` for `import a.b.*`. Swift: the module name (`import UIKit` gives `UIKit`).
    pub path: String,
    /// `import a.b.*` (Kotlin, Java).
    pub wildcard: bool,
    /// Kotlin `import a.b.C as D` gives `D`.
    pub alias: Option<String>,
    /// Java `import static a.b.C.member`.
    pub is_static: bool,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TypeKind {
    Class,
    Interface,
    Enum,
    /// Java `record`.
    Record,
    /// Java `@interface`, Kotlin `annotation class`.
    Annotation,
    /// Kotlin `object` and `companion object`.
    Object,
    /// Swift `struct`.
    Struct,
    /// Swift `protocol`.
    Protocol,
    /// Swift `actor`.
    Actor,
    /// Swift `extension Foo: Bar { ... }`. `name` is the extended type as
    /// written (`Foo` or `Outer.Inner`). `kestrel-code` merges it into that type.
    Extension,
    /// Kotlin and Swift `typealias A = B`. `aliased` holds `B`.
    TypeAlias,
}

/// One type declaration.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeDecl {
    pub name: String,
    pub kind: TypeKind,
    /// Index of the outer type in `FileModel::types` when this type is nested.
    pub outer: Option<usize>,
    /// Modifier keywords in lower case, as written: `public`, `private`,
    /// `abstract`, `open`, `final`, `sealed`, `data`, `static`, `inner`,
    /// `value`, `companion`, `fun` (Kotlin `fun interface`), `indirect` ...
    pub modifiers: Vec<String>,
    /// Annotation and attribute names without `@`, use-site target and
    /// arguments: `@field:Json(name = "x")` gives `Json`, `@MainActor` gives `MainActor`.
    pub annotations: Vec<String>,
    /// Names of the type parameters: `class Box<T : Any, out R>` gives `T`, `R`.
    pub type_params: Vec<String>,
    /// Superclass, interfaces, protocols, in the order of the source.
    pub supertypes: Vec<SuperType>,
    /// `typealias A = B`: the type `B`. `None` for other kinds.
    pub aliased: Option<TypeRef>,
    /// Fields and properties: Java fields, Kotlin properties (also `val` and
    /// `var` parameters of the primary constructor), Java record components,
    /// Swift stored and computed properties, and enum entries (`EnumCase`).
    pub fields: Vec<Member>,
    /// Methods and constructors (Java constructors, Kotlin `constructor(...)`
    /// and the primary constructor, Swift `init`).
    pub methods: Vec<Member>,
    /// Names that look like types (they start with an upper-case letter) and
    /// that the code of this type uses outside of `supertypes` and member
    /// signatures: in function bodies, initializers, `Foo.CONST`, `Foo::class`,
    /// `new Foo()`, local variable types. Nested types are not included here:
    /// they have their own list. Each name once, in the order of first use.
    /// Dotted names stay dotted: `Outer.Inner`.
    pub used_types: Vec<String>,
    /// Position of the name.
    pub line: u32,
    pub column: u32,
    /// First line of the declaration (first annotation or modifier).
    pub start_line: u32,
    /// Line of the closing `}`. The line of the name when there is no body.
    pub end_line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SuperKind {
    /// Java `class A extends B`. Kotlin supertype with a constructor call: `: Base()`.
    Extends,
    /// Java `implements`, and `extends` of a Java interface.
    Implements,
    /// The syntax does not say: Kotlin supertypes without `()`, every entry of
    /// a Swift inheritance list. `kestrel-code` decides with the kind of the
    /// type that the name resolves to.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuperType {
    pub ty: TypeRef,
    pub kind: SuperKind,
    /// Kotlin `class A(b: B) : I by b`.
    pub delegated: bool,
}

/// A type as written in the source.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeRef {
    /// The type as written, without annotations, with white space made
    /// single: `Map<String, List<Foo>>?`, `(Int) -> Unit`, `[String: Foo]`.
    pub text: String,
    /// The name without type arguments. It can be dotted: `Map`, `a.b.Foo`,
    /// `Outer.Inner`. Swift sugar uses the long name: `[Foo]` gives `Array`,
    /// `[K: V]` gives `Dictionary`, `Foo?` gives `Foo` with `nullable`.
    /// Function types, tuples and Swift `A & B` give an empty name; their
    /// parts are in `args` (see there).
    pub name: String,
    /// Type arguments: `Map<String, Foo>` gives `String` and `Foo`. Swift
    /// `[Foo]` gives `Foo`, `[K: V]` gives `K` and `V`. Star projections and
    /// wildcards (`*`, `?`) are left out; `? extends Foo` gives `Foo`.
    /// Function types: the parameter types, then the return type. Tuples
    /// and Swift `A & B`: the parts.
    pub args: Vec<TypeRef>,
    /// Kotlin and Swift `?` (also Swift `!`).
    pub nullable: bool,
    /// Java `Foo[]` and `Foo...`, Swift variadic parameters (`Int...`).
    pub array: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MemberKind {
    Field,
    Property,
    Constructor,
    Method,
    /// Java enum constant, Kotlin enum entry, Swift `case`.
    EnumCase,
}

/// The visibility that applies, also when the source has no modifier:
/// Kotlin default `Public`, Java default `Package` (members of a Java
/// interface: `Public`), Swift default `Internal`, Swift `fileprivate` and
/// `private` give `Private`, Swift `open` gives `Public`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Visibility {
    Public,
    Protected,
    Internal,
    Package,
    Private,
}

/// A field, property, method, constructor or enum entry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    /// Constructors: the type name (Java, Kotlin) or `init` (Swift).
    pub name: String,
    pub kind: MemberKind,
    pub visibility: Visibility,
    /// Java `static`, Swift `static` and `class` members.
    pub is_static: bool,
    /// Java and Kotlin `abstract`, and methods of an interface or protocol without a body.
    pub is_abstract: bool,
    /// Field or property type, or method return type. When the source has no
    /// type, a property that starts with a constructor call (`val x = Foo(...)`,
    /// `let x = Foo()`) gets `Foo`. Otherwise `None`. Constructors: `None`.
    pub ty: Option<TypeRef>,
    /// Parameters of methods and constructors, and the associated values of
    /// a Swift `EnumCase` (`case a(id: Int, Foo)`: `name` is the label or
    /// empty). Empty for other members.
    pub params: Vec<Param>,
    /// Kotlin `var`, Swift `var` (also read-only computed properties),
    /// Java fields without `final`.
    pub mutable: bool,
    /// Kotlin extension receiver: `fun Foo.bar()` gives `Foo`.
    pub receiver: Option<TypeRef>,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    pub ty: Option<TypeRef>,
}

/// How the code uses a name at one place. Parsers decide this from the
/// syntax only. When they cannot tell, they use `Reference`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UsageKind {
    /// The name where a type, member, parameter or local variable is declared.
    Declaration,
    /// In an `import` line.
    Import,
    /// In the supertype list of a type: `extends`, `implements`, Kotlin and Swift `:`.
    Supertype,
    /// Java `new Foo(`. Kotlin and Swift `Foo(` are `Call`: `kestrel-code`
    /// turns a call of a type name into `Instantiation`.
    Instantiation,
    /// In a type position: field, parameter, return and variable types, type
    /// arguments, casts, `is`, `as`, `instanceof`, `Foo::class`, `Foo.class`,
    /// `Foo.self`.
    Type,
    /// A name followed by `(`, or by a Kotlin or Swift trailing lambda `{`.
    Call,
    /// Every other use: reads, writes, `Foo.CONSTANT`, method references.
    Reference,
}

/// One place where the code uses a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentHit {
    /// Byte range of the name in the text (without backticks).
    pub start: usize,
    pub end: usize,
    pub kind: UsageKind,
    /// The dotted name right before it, without the last dot: `a.b` for
    /// `a.b.Foo`, `repo` for `repo.save()`, `this` for `this.x`,
    /// `Foo` for `Foo::bar`. Empty when the name has nothing before it, or
    /// when the part before it is not a plain dotted name (`foo().bar`).
    pub qualifier: String,
}
