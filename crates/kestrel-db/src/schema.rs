//! Schema queries: databases, objects, columns, indexes, DDL and the completion map.
//! They read `information_schema` with prepared statements, so names are never
//! pasted into the SQL text. Only `SHOW CREATE` needs a quoted identifier.

use crate::types::{ColumnInfo, DbObject, DbObjects, IndexInfo, ObjectKind};
use crate::values::format_value;
use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Result, Row, Value};
use std::collections::BTreeMap;

fn text(row: &Row, i: usize) -> Option<String> {
    row.as_ref(i).and_then(|v| format_value(v, false))
}

fn number(row: &Row, i: usize) -> Option<u64> {
    match row.as_ref(i)? {
        Value::Int(n) => u64::try_from(*n).ok(),
        Value::UInt(n) => Some(*n),
        Value::Bytes(b) => std::str::from_utf8(b).ok()?.parse().ok(),
        _ => None,
    }
}

/// Empty text counts as "no value".
fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

/// Quotes a name for use in SQL: `name` with doubled backticks inside.
pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub async fn databases(conn: &mut Conn) -> Result<Vec<String>> {
    let rows: Vec<Row> = conn.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").await?;
    Ok(rows.iter().filter_map(|r| text(r, 0)).collect())
}

pub async fn objects(conn: &mut Conn, database: &str) -> Result<DbObjects> {
    let mut out = DbObjects::default();

    let rows: Vec<Row> = conn
        .exec(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, ENGINE \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            (database,),
        )
        .await?;
    for r in &rows {
        let Some(name) = text(r, 0) else { continue };
        let is_view = text(r, 1).is_some_and(|t| t.contains("VIEW"));
        if is_view {
            // The server puts the word VIEW in the comment of a view. That is no real comment.
            out.views.push(DbObject { name, kind: ObjectKind::View, comment: None, rows_estimate: None, detail: None });
        } else {
            out.tables.push(DbObject {
                name,
                kind: ObjectKind::Table,
                comment: non_empty(text(r, 2)),
                rows_estimate: number(r, 3),
                detail: non_empty(text(r, 4)),
            });
        }
    }

    let rows: Vec<Row> = conn
        .exec(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            (database,),
        )
        .await?;
    for r in &rows {
        let Some(name) = text(r, 0) else { continue };
        let is_function = text(r, 1).is_some_and(|t| t.eq_ignore_ascii_case("FUNCTION"));
        let kind = if is_function { ObjectKind::Function } else { ObjectKind::Procedure };
        let obj = DbObject { name, kind, comment: non_empty(text(r, 2)), rows_estimate: None, detail: None };
        if is_function {
            out.functions.push(obj);
        } else {
            out.procedures.push(obj);
        }
    }

    let rows: Vec<Row> = conn
        .exec(
            "SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
            (database,),
        )
        .await?;
    for r in &rows {
        let Some(name) = text(r, 0) else { continue };
        out.triggers.push(DbObject { name, kind: ObjectKind::Trigger, comment: None, rows_estimate: None, detail: non_empty(text(r, 1)) });
    }
    Ok(out)
}

pub async fn columns(conn: &mut Conn, database: &str, table: &str) -> Result<Vec<ColumnInfo>> {
    let rows: Vec<Row> = conn
        .exec(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (database, table),
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: text(r, 0).unwrap_or_default(),
            type_name: text(r, 1).unwrap_or_default(),
            nullable: text(r, 2).is_some_and(|s| s.eq_ignore_ascii_case("YES")),
            key: text(r, 3).unwrap_or_default(),
            default_value: text(r, 4),
            extra: text(r, 5).unwrap_or_default(),
            comment: non_empty(text(r, 6)),
        })
        .collect())
}

pub async fn indexes(conn: &mut Conn, database: &str, table: &str) -> Result<Vec<IndexInfo>> {
    let rows: Vec<Row> = conn
        .exec(
            "SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            (database, table),
        )
        .await?;
    let parts = rows.iter().map(|r| {
        (
            text(r, 0).unwrap_or_default(),
            number(r, 1).unwrap_or(1) == 0,
            text(r, 3),
            text(r, 4).unwrap_or_default(),
        )
    });
    Ok(group_indexes(parts))
}

/// Joins the rows of `information_schema.STATISTICS` (one row per index column,
/// already ordered by index name and position) into one entry per index.
/// `PRIMARY` comes first. A column name of `None` is a functional (expression) key part.
pub fn group_indexes(rows: impl Iterator<Item = (String, bool, Option<String>, String)>) -> Vec<IndexInfo> {
    let mut list: Vec<IndexInfo> = Vec::new();
    for (name, unique, column, type_name) in rows {
        let column = column.unwrap_or_else(|| "(expression)".to_string());
        match list.last_mut() {
            Some(last) if last.name == name => last.columns.push(column),
            _ => list.push(IndexInfo { name, unique, columns: vec![column], type_name }),
        }
    }
    // Stable sort: PRIMARY moves to the front, the other order stays.
    list.sort_by_key(|i| i.name != "PRIMARY");
    list
}

/// The `SHOW CREATE` statement for an object, and the name of the result column with the text.
fn show_create(kind: ObjectKind) -> (&'static str, &'static str) {
    match kind {
        ObjectKind::Table => ("TABLE", "Create Table"),
        ObjectKind::View => ("VIEW", "Create View"),
        ObjectKind::Procedure => ("PROCEDURE", "Create Procedure"),
        ObjectKind::Function => ("FUNCTION", "Create Function"),
        ObjectKind::Trigger => ("TRIGGER", "SQL Original Statement"),
    }
}

/// The create statement as text. `None` when the server hides it (missing privilege).
pub async fn ddl(conn: &mut Conn, database: &str, name: &str, kind: ObjectKind) -> Result<Option<String>> {
    let (what, column) = show_create(kind);
    let sql = format!("SHOW CREATE {what} {}.{}", quote_ident(database), quote_ident(name));
    let rows: Vec<Row> = conn.query(sql).await?;
    let Some(row) = rows.first() else { return Ok(None) };
    let index = row.columns_ref().iter().position(|c| c.name_str().eq_ignore_ascii_case(column));
    Ok(index.and_then(|i| text(row, i)))
}

pub async fn completion_schema(conn: &mut Conn, database: &str) -> Result<BTreeMap<String, Vec<String>>> {
    let rows: Vec<Row> = conn
        .exec(
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? \
             ORDER BY TABLE_NAME, ORDINAL_POSITION",
            (database,),
        )
        .await?;
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in &rows {
        if let (Some(t), Some(c)) = (text(r, 0), text(r, 1)) {
            map.entry(t).or_default().push(c);
        }
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("titles"), "`titles`");
        assert_eq!(quote_ident("we`ird"), "`we``ird`");
        assert_eq!(quote_ident("a b"), "`a b`");
    }

    fn part(name: &str, unique: bool, col: Option<&str>) -> (String, bool, Option<String>, String) {
        (name.into(), unique, col.map(String::from), "BTREE".into())
    }

    #[test]
    fn groups_index_columns_and_puts_primary_first() {
        let rows = vec![
            part("idx_genre_rating", false, Some("genre")),
            part("idx_genre_rating", false, Some("rating")),
            part("PRIMARY", true, Some("id")),
            part("uk_expr", true, None),
        ];
        let list = group_indexes(rows.into_iter());
        let names: Vec<_> = list.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["PRIMARY", "idx_genre_rating", "uk_expr"]);
        assert_eq!(list[1].columns, ["genre", "rating"]);
        assert!(list[0].unique && !list[1].unique);
        assert_eq!(list[2].columns, ["(expression)"]);
    }

    #[test]
    fn show_create_names() {
        assert_eq!(show_create(ObjectKind::Trigger), ("TRIGGER", "SQL Original Statement"));
        assert_eq!(show_create(ObjectKind::View).1, "Create View");
    }
}
