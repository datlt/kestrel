//! Dev only. A small HTTP server that gives the browser dev bridge
//! (`scripts/dev-bridge.mjs`) the same code index commands as the Tauri app.
//!
//!   cargo run -p kestrel-code --example dev_http
//!
//! It listens on 127.0.0.1:1436 (change it with KESTREL_CODE_DEV_PORT) and answers
//! `POST /invoke/<command>` with a JSON body of arguments (camelCase, as the
//! frontend sends them). Success: status 200 and the JSON result.
//! Error: status 400 and `{ "code": "...", "message": "..." }`.
//! The owner is always "dev". Running requests can be stopped with `code_cancel`.

use kestrel_code::{CallersRequest, CodeManager, DiagramRequest, UsagesRequest};
use kestrel_common::{Error, Result};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const OWNER: &str = "dev";
const DEFAULT_PORT: u16 = 1436;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

type Running = Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>;

fn main() -> std::io::Result<()> {
    let port = std::env::var("KESTREL_CODE_DEV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("kestrel-code dev server on http://127.0.0.1:{port} (POST /invoke/<command>)");
    let manager = CodeManager::new();
    let running: Running = Arc::new(Mutex::new(HashMap::new()));
    for stream in listener.incoming().flatten() {
        let (m, r) = (manager.clone(), running.clone());
        std::thread::spawn(move || {
            if let Err(e) = serve(stream, m, r) {
                eprintln!("connection error: {e}");
            }
        });
    }
    Ok(())
}

struct Request {
    method: String,
    path: String,
    has_origin: bool,
    body: Vec<u8>,
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Ok(None);
        }
        let n = stream.read(&mut chunk)?;
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
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(None);
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(Some(Request { method, path, has_origin, body }))
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
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
    stream.write_all(head.as_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()
}

fn serve(mut stream: TcpStream, manager: CodeManager, running: Running) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream)? else {
        return respond(&mut stream, 400, &json!({ "code": "invalid_input", "message": "bad request" }));
    };
    // A web page sends an Origin header. Only the Node bridge may call us.
    if req.has_origin {
        return respond(&mut stream, 403, &json!({ "code": "permission_denied", "message": "browser requests are refused" }));
    }
    if req.method == "GET" && req.path == "/ping" {
        return respond(&mut stream, 200, &json!({ "ok": true }));
    }
    let Some(cmd) = req.path.strip_prefix("/invoke/").filter(|_| req.method == "POST") else {
        return respond(&mut stream, 404, &json!({ "code": "not_found", "message": "use POST /invoke/<command>" }));
    };
    let args: Value = if req.body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(_) => return respond(&mut stream, 400, &json!({ "code": "invalid_input", "message": "body is not valid JSON" })),
        }
    };
    match invoke(&manager, &running, cmd, args) {
        Ok(v) => respond(&mut stream, 200, &v),
        Err(e) => respond(&mut stream, 400, &serde_json::to_value(&e).unwrap_or(Value::Null)),
    }
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T> {
    let v = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(v).map_err(|e| Error::invalid(format!("argument `{name}`: {e}")))
}

fn out<T: serde::Serialize>(v: T) -> Result<Value> {
    Ok(serde_json::to_value(v)?)
}

fn invoke(m: &CodeManager, running: &Running, cmd: &str, a: Value) -> Result<Value> {
    match cmd {
        "code_index_status" => out(m.status(&arg::<String>(&a, "root")?)),
        "code_index_update" => out(m.update(&arg::<String>(&a, "root")?, &arg::<Vec<String>>(&a, "paths")?, arg(&a, "rescan")?)?),
        "code_index_drop" => {
            m.drop_root(OWNER, &arg::<String>(&a, "root")?);
            out(())
        }
        "code_cancel" => {
            if let Some(f) = running.lock().get(&arg::<u64>(&a, "id")?) {
                f.store(true, Ordering::Relaxed);
            }
            out(())
        }
        "code_diagram" | "code_usages" | "code_callers" => {
            let id: u64 = arg(&a, "id")?;
            let flag = Arc::new(AtomicBool::new(false));
            running.lock().insert(id, flag.clone());
            let result = if cmd == "code_diagram" {
                let req: Result<DiagramRequest> = arg(&a, "request");
                req.and_then(|r| m.diagram(OWNER, &r, &flag)).and_then(out)
            } else if cmd == "code_callers" {
                let req: Result<CallersRequest> = arg(&a, "request");
                req.and_then(|r| m.callers(OWNER, &r, &flag)).and_then(out)
            } else {
                let req: Result<UsagesRequest> = arg(&a, "request");
                req.and_then(|r| m.usages(OWNER, &r, &flag)).and_then(out)
            };
            running.lock().remove(&id);
            result
        }
        other => Err(Error::invalid(format!("unknown command: {other}"))),
    }
}
