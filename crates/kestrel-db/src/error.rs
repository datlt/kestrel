//! Maps `mysql_async` errors to the error codes of the contract.

use kestrel_common::Error;
use kestrel_common::error::codes;
use mysql_async::{DriverError, Error as MyError, ServerError};

/// Where the error happened. Connect errors use `db_connect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connect,
    Run,
}

/// MySQL error number of a statement that the server stopped on request (`KILL QUERY`).
pub const ER_QUERY_INTERRUPTED: u16 = 1317;

/// Server errors that mean "this connection is gone".
fn lost_server_code(code: u16) -> bool {
    // 1053 server shutdown, 1927 connection killed, 2006 server has gone away,
    // 2013 lost connection during the query.
    matches!(code, 1053 | 1927 | 2006 | 2013)
}

/// The message of a server error: `<code> (<sqlstate>): <message>`.
pub fn server_message(e: &ServerError) -> String {
    format!("{} ({}): {}", e.code, e.state, e.message)
}

pub fn is_interrupted(e: &MyError) -> bool {
    matches!(e, MyError::Server(s) if s.code == ER_QUERY_INTERRUPTED)
}

/// True when the error says that the connection cannot be used any more.
pub fn is_lost(e: &MyError) -> bool {
    match e {
        MyError::Server(s) => lost_server_code(s.code),
        MyError::Io(_) => true,
        MyError::Driver(d) => matches!(
            d,
            DriverError::ConnectionClosed
                | DriverError::PacketOutOfOrder
                | DriverError::PacketTooLarge
                | DriverError::UnexpectedPacket { .. }
                | DriverError::BadCompressedPacketHeader
        ),
        MyError::Other(_) | MyError::Url(_) => false,
    }
}

pub fn map_error(e: &MyError, phase: Phase) -> Error {
    match e {
        MyError::Server(s) => {
            if phase == Phase::Connect {
                Error::new(codes::DB_CONNECT, server_message(s))
            } else if lost_server_code(s.code) {
                Error::new(codes::DB_LOST, server_message(s))
            } else {
                Error::new(codes::DB_ERROR, server_message(s))
            }
        }
        other if phase == Phase::Connect => Error::new(codes::DB_CONNECT, describe(other)),
        other if is_lost(other) => Error::new(codes::DB_LOST, describe(other)),
        other => Error::internal(describe(other)),
    }
}

/// Short text for non-server errors, without the `Driver error:` style prefixes.
fn describe(e: &MyError) -> String {
    match e {
        MyError::Io(io) => io.to_string(),
        MyError::Driver(d) => d.to_string(),
        MyError::Other(o) => o.to_string(),
        MyError::Url(u) => u.to_string(),
        MyError::Server(s) => server_message(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(code: u16, state: &str, msg: &str) -> MyError {
        MyError::Server(ServerError { code, state: state.into(), message: msg.into() })
    }

    #[test]
    fn server_error_text_has_code_and_state() {
        let e = map_error(&server(1146, "42S02", "Table 'a.b' doesn't exist"), Phase::Run);
        assert_eq!(e.code(), "db_error");
        assert_eq!(e.to_string(), "1146 (42S02): Table 'a.b' doesn't exist");
    }

    #[test]
    fn login_failure_is_db_connect() {
        let e = map_error(&server(1045, "28000", "Access denied for user 'x'"), Phase::Connect);
        assert_eq!(e.code(), "db_connect");
        assert!(e.to_string().starts_with("1045 (28000): "));
    }

    #[test]
    fn dropped_connection_is_db_lost() {
        let io = MyError::Io(mysql_async::IoError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe)));
        assert_eq!(map_error(&io, Phase::Run).code(), "db_lost");
        assert_eq!(map_error(&io, Phase::Connect).code(), "db_connect");
        let closed = MyError::Driver(DriverError::ConnectionClosed);
        assert_eq!(map_error(&closed, Phase::Run).code(), "db_lost");
        assert_eq!(map_error(&server(2013, "HY000", "Lost connection"), Phase::Run).code(), "db_lost");
        assert_eq!(map_error(&server(2006, "HY000", "gone away"), Phase::Run).code(), "db_lost");
        assert_eq!(map_error(&server(1927, "70100", "Connection was killed"), Phase::Run).code(), "db_lost");
    }

    #[test]
    fn interrupted_query_is_detected() {
        assert!(is_interrupted(&server(1317, "70100", "Query execution was interrupted")));
        assert!(!is_interrupted(&server(1064, "42000", "syntax")));
    }
}
