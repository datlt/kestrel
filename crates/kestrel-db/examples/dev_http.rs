//! Dev only. A small HTTP server that gives the browser dev bridge
//! (`scripts/dev-bridge.mjs`) the same database commands as the Tauri app.
//!
//!   cargo run -p kestrel-db --example dev_http
//!
//! It listens on 127.0.0.1:1435 (change it with KESTREL_DB_DEV_PORT) and answers
//! `POST /invoke/<command>` with a JSON body of arguments (camelCase, as the
//! frontend sends them). Success: status 200 and the JSON result.
//! Error: status 400 and `{ "code": "...", "message": "..." }`.
//! All sessions belong to the owner "dev". Do not use this server in production:
//! it has no login, so anything that reaches the port can run SQL.

use kestrel_common::{Error, Result};
use kestrel_db::{ConnectArgs, DbManager, ObjectKind};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const OWNER: &str = "dev";
const DEFAULT_PORT: u16 = 1435;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // Read the login shell PATH, so `ssh` is found like in the app.
    kestrel_common::process::init_shell_env();
    let port = std::env::var("KESTREL_DB_DEV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("kestrel-db dev server on http://127.0.0.1:{port} (POST /invoke/<command>)");
    let manager = DbManager::new();

    let stop = manager.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        println!("closing sessions");
        let _ = tokio::time::timeout(Duration::from_secs(3), stop.close_all()).await;
        stop.kill_tunnels_now();
        std::process::exit(0);
    });

    loop {
        let (stream, _) = listener.accept().await?;
        let manager = manager.clone();
        tokio::spawn(async move {
            if let Err(e) = serve(stream, manager).await {
                eprintln!("connection error: {e}");
            }
        });
    }
}

struct Request {
    method: String,
    path: String,
    has_origin: bool,
    body: Vec<u8>,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Ok(None);
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let path = first.next().unwrap_or("").to_string();
    let mut length = 0usize;
    let mut has_origin = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(0),
                "origin" => has_origin = true,
                _ => {}
            }
        }
    }
    if length > MAX_BODY_BYTES {
        return Ok(None);
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(Some(Request { method, path, has_origin, body }))
}

async fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let text = match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"null".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {text}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&payload).await?;
    stream.shutdown().await
}

async fn serve(mut stream: TcpStream, manager: DbManager) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream).await? else {
        return respond(&mut stream, 400, &json!({ "code": "invalid_input", "message": "bad request" })).await;
    };
    // A web page in a browser sends an Origin header. Only the Node bridge may call us.
    if req.has_origin {
        return respond(&mut stream, 403, &json!({ "code": "permission_denied", "message": "browser requests are refused" })).await;
    }
    if req.method == "GET" && req.path == "/ping" {
        return respond(&mut stream, 200, &json!({ "ok": true })).await;
    }
    let Some(cmd) = req.path.strip_prefix("/invoke/").filter(|_| req.method == "POST") else {
        return respond(&mut stream, 404, &json!({ "code": "not_found", "message": "use POST /invoke/<command>" })).await;
    };
    let args: Value = if req.body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(_) => return respond(&mut stream, 400, &json!({ "code": "invalid_input", "message": "body is not valid JSON" })).await,
        }
    };
    match invoke(&manager, cmd, args).await {
        Ok(v) => respond(&mut stream, 200, &v).await,
        Err(e) => respond(&mut stream, 400, &serde_json::to_value(&e).unwrap_or(Value::Null)).await,
    }
}

// --- Commands: the same names and arguments as src/ipc/db.ts -------------------

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T> {
    let v = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| Error::invalid(format!("argument `{name}`: {e}")))
}

fn out<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

async fn invoke(m: &DbManager, cmd: &str, a: Value) -> Result<Value> {
    match cmd {
        "db_test" => out(m.test(OWNER, ConnectArgs { config: arg(&a, "config")?, password: arg(&a, "password")? }).await?),
        "db_connect" => out(m.connect(OWNER, ConnectArgs { config: arg(&a, "config")?, password: arg(&a, "password")? }).await?),
        "db_disconnect" => out(m.disconnect(OWNER, &arg::<String>(&a, "sessionId")?).await?),
        "db_execute" => {
            let max_rows: usize = arg(&a, "maxRows")?;
            out(m.execute(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "sql")?, max_rows).await?)
        }
        "db_cancel" => out(m.cancel(OWNER, &arg::<String>(&a, "sessionId")?).await?),
        "db_set_autocommit" => out(m.set_autocommit(OWNER, &arg::<String>(&a, "sessionId")?, arg(&a, "on")?).await?),
        "db_commit" => out(m.commit(OWNER, &arg::<String>(&a, "sessionId")?).await?),
        "db_rollback" => out(m.rollback(OWNER, &arg::<String>(&a, "sessionId")?).await?),
        "db_use" => out(m.use_database(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?).await?),
        "db_databases" => out(m.databases(OWNER, &arg::<String>(&a, "sessionId")?).await?),
        "db_objects" => out(m.objects(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?).await?),
        "db_columns" => out(m.columns(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?, &arg::<String>(&a, "table")?).await?),
        "db_indexes" => out(m.indexes(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?, &arg::<String>(&a, "table")?).await?),
        "db_ddl" => {
            let kind: ObjectKind = arg(&a, "kind")?;
            out(m.ddl(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?, &arg::<String>(&a, "name")?, kind).await?)
        }
        "db_completion_schema" => out(m.completion_schema(OWNER, &arg::<String>(&a, "sessionId")?, &arg::<String>(&a, "database")?).await?),
        "db_password_set" => out(m.password_set(&arg::<String>(&a, "id")?, &arg::<String>(&a, "password")?).await?),
        "db_password_delete" => out(m.password_delete(&arg::<String>(&a, "id")?).await?),
        "db_password_exists" => out(m.password_exists(&arg::<String>(&a, "id")?).await?),
        other => Err(Error::invalid(format!("unknown command: {other}"))),
    }
}
