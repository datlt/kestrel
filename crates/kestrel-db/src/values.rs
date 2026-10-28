//! Turns MySQL column metadata and values into the types of the contract.

use crate::types::Column;
use mysql_async::Value;
use mysql_async::consts::{ColumnFlags, ColumnType};

/// Binary values show at most this many bytes.
pub const BINARY_PREVIEW_BYTES: usize = 256;
/// The character set number MySQL uses for binary strings.
const BINARY_CHARSET: u16 = 63;

/// `0x` + hex of the first 256 bytes. When the value is longer, ` (N bytes)` follows.
pub fn hex_preview(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789ABCDEF";
    let shown = &bytes[..bytes.len().min(BINARY_PREVIEW_BYTES)];
    let mut out = String::with_capacity(2 + shown.len() * 2 + 16);
    out.push_str("0x");
    for b in shown {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    if bytes.len() > BINARY_PREVIEW_BYTES {
        out.push_str(&format!(" ({} bytes)", bytes.len()));
    }
    out
}

/// Text of one cell. `None` is SQL NULL.
/// The text protocol sends every value as bytes, so the text is exactly what the server sent.
pub fn format_value(value: &Value, binary: bool) -> Option<String> {
    match value {
        Value::NULL => None,
        Value::Bytes(b) if binary => Some(hex_preview(b)),
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        // The binary protocol (not used for statements) can send these.
        other => Some(other.as_sql(true).trim_matches('\'').to_string()),
    }
}

fn is_integer_or_decimal(t: ColumnType) -> bool {
    use ColumnType::*;
    matches!(
        t,
        MYSQL_TYPE_TINY
            | MYSQL_TYPE_SHORT
            | MYSQL_TYPE_INT24
            | MYSQL_TYPE_LONG
            | MYSQL_TYPE_LONGLONG
            | MYSQL_TYPE_DECIMAL
            | MYSQL_TYPE_NEWDECIMAL
            | MYSQL_TYPE_FLOAT
            | MYSQL_TYPE_DOUBLE
    )
}

/// The type name for display, for example `BIGINT UNSIGNED` or `VARCHAR`.
pub fn type_name(col: &mysql_async::Column) -> String {
    use ColumnType::*;
    let flags = col.flags();
    let binary_charset = col.character_set() == BINARY_CHARSET;
    let base = match col.column_type() {
        MYSQL_TYPE_TINY => "TINYINT",
        MYSQL_TYPE_SHORT => "SMALLINT",
        MYSQL_TYPE_INT24 => "MEDIUMINT",
        MYSQL_TYPE_LONG => "INT",
        MYSQL_TYPE_LONGLONG => "BIGINT",
        MYSQL_TYPE_FLOAT => "FLOAT",
        MYSQL_TYPE_DOUBLE => "DOUBLE",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "DECIMAL",
        MYSQL_TYPE_YEAR => "YEAR",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "DATE",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "TIME",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "DATETIME",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "TIMESTAMP",
        MYSQL_TYPE_JSON => "JSON",
        MYSQL_TYPE_BIT => "BIT",
        MYSQL_TYPE_GEOMETRY => "GEOMETRY",
        MYSQL_TYPE_NULL => "NULL",
        MYSQL_TYPE_ENUM => "ENUM",
        MYSQL_TYPE_SET => "SET",
        MYSQL_TYPE_VECTOR => "VECTOR",
        // The server sends ENUM and SET as STRING and marks them with a flag.
        MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR if flags.contains(ColumnFlags::ENUM_FLAG) => "ENUM",
        MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR if flags.contains(ColumnFlags::SET_FLAG) => "SET",
        MYSQL_TYPE_STRING => {
            if binary_charset {
                "BINARY"
            } else {
                "CHAR"
            }
        }
        MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR => {
            if binary_charset {
                "VARBINARY"
            } else {
                "VARCHAR"
            }
        }
        MYSQL_TYPE_TINY_BLOB | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB => {
            // The server sends BLOB for all sizes. The column length tells the real type.
            let kind = match (col.column_type(), col.column_length()) {
                (MYSQL_TYPE_TINY_BLOB, _) => 0,
                (MYSQL_TYPE_MEDIUM_BLOB, _) => 2,
                (MYSQL_TYPE_LONG_BLOB, _) => 3,
                (_, n) if n <= 255 => 0,
                (_, n) if n <= 65_535 => 1,
                (_, n) if n <= 16_777_215 => 2,
                _ => 3,
            };
            match (binary_charset, kind) {
                (true, 0) => "TINYBLOB",
                (true, 1) => "BLOB",
                (true, 2) => "MEDIUMBLOB",
                (true, _) => "LONGBLOB",
                (false, 0) => "TINYTEXT",
                (false, 1) => "TEXT",
                (false, 2) => "MEDIUMTEXT",
                (false, _) => "LONGTEXT",
            }
        }
        MYSQL_TYPE_UNKNOWN | MYSQL_TYPE_TYPED_ARRAY => "UNKNOWN",
    };
    if is_integer_or_decimal(col.column_type()) && flags.contains(ColumnFlags::UNSIGNED_FLAG) {
        format!("{base} UNSIGNED")
    } else {
        base.to_string()
    }
}

fn is_binary(col: &mysql_async::Column) -> bool {
    use ColumnType::*;
    match col.column_type() {
        MYSQL_TYPE_BIT | MYSQL_TYPE_GEOMETRY => true,
        // JSON has the binary character set in the metadata, but its text is readable.
        MYSQL_TYPE_JSON => false,
        MYSQL_TYPE_STRING
        | MYSQL_TYPE_VAR_STRING
        | MYSQL_TYPE_VARCHAR
        | MYSQL_TYPE_TINY_BLOB
        | MYSQL_TYPE_MEDIUM_BLOB
        | MYSQL_TYPE_LONG_BLOB
        | MYSQL_TYPE_BLOB => {
            col.character_set() == BINARY_CHARSET
                && !col.flags().intersects(ColumnFlags::ENUM_FLAG | ColumnFlags::SET_FLAG)
        }
        _ => false,
    }
}

/// Describes a result column for the frontend.
pub fn describe_column(col: &mysql_async::Column) -> Column {
    use ColumnType::*;
    let numeric = matches!(
        col.column_type(),
        MYSQL_TYPE_TINY
            | MYSQL_TYPE_SHORT
            | MYSQL_TYPE_INT24
            | MYSQL_TYPE_LONG
            | MYSQL_TYPE_LONGLONG
            | MYSQL_TYPE_FLOAT
            | MYSQL_TYPE_DOUBLE
            | MYSQL_TYPE_DECIMAL
            | MYSQL_TYPE_NEWDECIMAL
            | MYSQL_TYPE_YEAR
    );
    let table = {
        let org = col.org_table_str();
        let t = if org.is_empty() { col.table_str() } else { org };
        (!t.is_empty()).then(|| t.into_owned())
    };
    Column {
        name: col.name_str().into_owned(),
        type_name: type_name(col),
        table,
        nullable: !col.flags().contains(ColumnFlags::NOT_NULL_FLAG),
        numeric,
        binary: is_binary(col),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mysql_async::Column as Meta;

    fn meta(t: ColumnType) -> Meta {
        Meta::new(t).with_name(b"c")
    }

    #[test]
    fn hex_preview_short_and_long() {
        assert_eq!(hex_preview(&[0, 1, 0xAB, 0xFF]), "0x0001ABFF");
        assert_eq!(hex_preview(&[]), "0x");
        let exactly = vec![0x41u8; 256];
        assert_eq!(hex_preview(&exactly), format!("0x{}", "41".repeat(256)));
        let long = vec![0x42u8; 300];
        assert_eq!(hex_preview(&long), format!("0x{} (300 bytes)", "42".repeat(256)));
    }

    #[test]
    fn values_keep_text_and_null() {
        assert_eq!(format_value(&Value::NULL, false), None);
        assert_eq!(format_value(&Value::Bytes("月の剣士".as_bytes().to_vec()), false).as_deref(), Some("月の剣士"));
        assert_eq!(format_value(&Value::Bytes(b"12345678901234567890.10".to_vec()), false).as_deref(), Some("12345678901234567890.10"));
        assert_eq!(format_value(&Value::Bytes(vec![0xDE, 0xAD]), true).as_deref(), Some("0xDEAD"));
        assert_eq!(format_value(&Value::UInt(u64::MAX), false).as_deref(), Some("18446744073709551615"));
    }

    #[test]
    fn integer_types_and_unsigned() {
        let c = describe_column(&meta(ColumnType::MYSQL_TYPE_LONGLONG).with_flags(ColumnFlags::UNSIGNED_FLAG | ColumnFlags::NOT_NULL_FLAG));
        assert_eq!(c.type_name, "BIGINT UNSIGNED");
        assert!(c.numeric && !c.binary && !c.nullable);
        let c = describe_column(&meta(ColumnType::MYSQL_TYPE_LONG));
        assert_eq!(c.type_name, "INT");
        assert!(c.nullable);
        // UNSIGNED does not apply to text types.
        let c = describe_column(&meta(ColumnType::MYSQL_TYPE_VAR_STRING).with_flags(ColumnFlags::UNSIGNED_FLAG).with_character_set(255));
        assert_eq!(c.type_name, "VARCHAR");
    }

    #[test]
    fn text_and_blob_types() {
        let text = describe_column(&meta(ColumnType::MYSQL_TYPE_BLOB).with_character_set(255).with_column_length(65_535));
        assert_eq!(text.type_name, "TEXT");
        assert!(!text.binary);
        let blob = describe_column(&meta(ColumnType::MYSQL_TYPE_BLOB).with_character_set(63).with_column_length(65_535));
        assert_eq!(blob.type_name, "BLOB");
        assert!(blob.binary && !blob.numeric);
        let long = describe_column(&meta(ColumnType::MYSQL_TYPE_BLOB).with_character_set(63).with_column_length(4_294_967_295));
        assert_eq!(long.type_name, "LONGBLOB");
        let varbin = describe_column(&meta(ColumnType::MYSQL_TYPE_VAR_STRING).with_character_set(63));
        assert_eq!(varbin.type_name, "VARBINARY");
        assert!(varbin.binary);
        let bin = describe_column(&meta(ColumnType::MYSQL_TYPE_STRING).with_character_set(63));
        assert_eq!(bin.type_name, "BINARY");
    }

    #[test]
    fn json_enum_bit_geometry() {
        let json = describe_column(&meta(ColumnType::MYSQL_TYPE_JSON).with_character_set(63));
        assert_eq!(json.type_name, "JSON");
        assert!(!json.binary);
        let en = describe_column(&meta(ColumnType::MYSQL_TYPE_STRING).with_flags(ColumnFlags::ENUM_FLAG).with_character_set(255));
        assert_eq!(en.type_name, "ENUM");
        let bit = describe_column(&meta(ColumnType::MYSQL_TYPE_BIT));
        assert!(bit.binary);
        let geo = describe_column(&meta(ColumnType::MYSQL_TYPE_GEOMETRY));
        assert!(geo.binary);
    }

    #[test]
    fn source_table_is_optional() {
        let none = describe_column(&meta(ColumnType::MYSQL_TYPE_LONG));
        assert_eq!(none.table, None);
        let with = describe_column(&meta(ColumnType::MYSQL_TYPE_LONG).with_table(b"alias").with_org_table(b"titles"));
        assert_eq!(with.table.as_deref(), Some("titles"));
    }
}
