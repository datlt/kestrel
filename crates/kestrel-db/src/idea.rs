//! IntelliJ data sources. See docs/DESIGN.md section 10.2.
//!
//! Reads `<project>/.idea/dataSources.xml`, merges `dataSources.local.xml`, and
//! reads the SSH configs of the project (`.idea/sshConfigs.xml`) and of the
//! IntelliJ application (`.../JetBrains/<product>/options/sshConfigs.xml`).
//!
//! Rules:
//! - The list that goes to the frontend never holds a password.
//! - The password stays in Rust. `file_password` reads it again at connect time.
//! - All functions here block (file system, keychain). Call them from a blocking thread.

use crate::types::*;
use kestrel_common::error::codes;
use kestrel_common::{Error, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::path::{Path, PathBuf};

const DEFAULT_MYSQL_PORT: u16 = 3306;

// --- Small XML tree --------------------------------------------------------

/// One XML element with its attributes, its text and its child elements.
#[derive(Debug, Default)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn attr(&self, key: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Text of the child element, trimmed. `None` when missing or empty.
    fn child_text(&self, name: &str) -> Option<String> {
        self.child(name).map(|c| c.text.trim().to_string()).filter(|t| !t.is_empty())
    }

    /// Every element below this one (not itself) with the given name, in file order.
    fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            }
            c.descendants(name, out);
        }
    }
}

fn parse_xml(text: &str) -> std::result::Result<Node, String> {
    let mut reader = Reader::from_str(text);
    let mut stack: Vec<Node> = vec![Node::default()];
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => stack.push(element(&e)?),
            Event::Empty(e) => {
                let node = element(&e)?;
                stack.last_mut().ok_or("bad XML")?.children.push(node);
            }
            Event::End(_) => {
                if stack.len() < 2 {
                    return Err("unexpected closing tag".into());
                }
                let node = stack.pop().ok_or("bad XML")?;
                stack.last_mut().ok_or("bad XML")?.children.push(node);
            }
            Event::Text(t) => {
                stack.last_mut().ok_or("bad XML")?.text.push_str(&t);
            }
            Event::CData(t) => {
                stack.last_mut().ok_or("bad XML")?.text.push_str(&t);
            }
            Event::GeneralRef(r) => {
                let name: &str = &r;
                let ch = match r.resolve_char_ref().map_err(|e| e.to_string())? {
                    Some(c) => c.to_string(),
                    None => match name {
                        "lt" => "<".into(),
                        "gt" => ">".into(),
                        "amp" => "&".into(),
                        "quot" => "\"".into(),
                        "apos" => "'".into(),
                        other => return Err(format!("unknown entity &{other};")),
                    },
                };
                stack.last_mut().ok_or("bad XML")?.text.push_str(&ch);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("a tag is not closed".into());
    }
    stack.pop().ok_or_else(|| "bad XML".to_string())
}

fn element(e: &quick_xml::events::BytesStart<'_>) -> std::result::Result<Node, String> {
    let mut node = Node { name: e.name().0.to_string(), ..Node::default() };
    for a in e.attributes() {
        let a = a.map_err(|e| e.to_string())?;
        let key = a.key.0.to_string();
        let value = a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(|e| e.to_string())?.into_owned();
        node.attrs.push((key, value));
    }
    Ok(node)
}

fn read_xml(path: &Path) -> std::result::Result<Node, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    parse_xml(&String::from_utf8_lossy(&bytes))
}

// --- JDBC URL --------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
struct Jdbc {
    /// Text after `jdbc:`, in lower case: `mysql`, `mariadb`, `trino`...
    sub: String,
    user: Option<String>,
    password: Option<String>,
    host: String,
    port: Option<u16>,
    database: Option<String>,
    params: Vec<(String, String)>,
}

impl Jdbc {
    fn param(&self, name: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Decodes `%XX`. A bad escape stays as it is. `+` stays a plus sign.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(v) = hex {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses `jdbc:<sub>[:word]://[user[:password]@]host[:port][,host2...][/database][?params]`.
/// Returns `None` when the text has no `//` part or the host is empty.
fn parse_jdbc(url: &str) -> Option<Jdbc> {
    let url = url.trim();
    let rest = url.get(..5).filter(|p| p.eq_ignore_ascii_case("jdbc:")).map(|_| &url[5..])?;
    let (sub, after) = rest.split_once(':')?;
    let (_, body) = after.split_once("//")?;
    let mut jdbc = Jdbc { sub: sub.to_ascii_lowercase(), ..Jdbc::default() };

    // The user info ends at the last `@`. A query string before it would hold `=`.
    let mut body = body;
    if let Some(at) = body.rfind('@') {
        if !body[..at].contains('=') {
            let (user, pass) = match body[..at].split_once(':') {
                Some((u, p)) => (u, Some(p)),
                None => (&body[..at], None),
            };
            if !user.is_empty() {
                jdbc.user = Some(percent_decode(user));
            }
            jdbc.password = pass.map(percent_decode).filter(|p| !p.is_empty());
            body = &body[at + 1..];
        }
    }

    let (head, query) = match body.split_once('?') {
        Some((h, q)) => (h, Some(q)),
        None => (body, None),
    };
    let (hosts, database) = match head.split_once('/') {
        Some((h, d)) => (h, Some(d)),
        None => (head, None),
    };
    jdbc.database = database.map(|d| percent_decode(d.trim())).filter(|d| !d.is_empty());
    if let Some(q) = query {
        for pair in q.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            jdbc.params.push((percent_decode(k), percent_decode(v)));
        }
    }

    // A host list is `h1:p1,h2:p2`. Use the first one.
    let first = hosts.split(',').next().unwrap_or("").trim();
    let (host, port) = if let Some(v6) = first.strip_prefix('[') {
        let (h, tail) = v6.split_once(']')?;
        (h.to_string(), tail.strip_prefix(':'))
    } else if first.contains('(') {
        // The `(host=...,port=...)` form is not supported.
        return None;
    } else {
        match first.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (first.to_string(), None),
        }
    };
    if host.is_empty() {
        return None;
    }
    jdbc.host = host;
    jdbc.port = match port {
        Some(p) if !p.is_empty() => Some(p.parse::<u16>().ok()?),
        _ => None,
    };
    Some(jdbc)
}

fn ssl_from(jdbc: &Jdbc) -> SslMode {
    if let Some(mode) = jdbc.param("sslMode") {
        return match mode.to_ascii_lowercase().as_str() {
            "disabled" => SslMode::Disabled,
            "required" | "verify_ca" | "verify_identity" => SslMode::Required,
            _ => SslMode::Preferred,
        };
    }
    match jdbc.param("useSSL").map(str::to_ascii_lowercase).as_deref() {
        Some("false") => SslMode::Disabled,
        Some("true") => SslMode::Required,
        _ => SslMode::Preferred,
    }
}

/// `connectTimeout` is in milliseconds in JDBC. Kestrel uses seconds.
fn timeout_from(jdbc: &Jdbc) -> Option<u64> {
    let ms: u64 = jdbc.param("connectTimeout")?.trim().parse().ok()?;
    if ms == 0 { None } else { Some(ms.div_ceil(1000).max(1)) }
}

// --- Names and drivers -----------------------------------------------------

/// True when a word of the name is `real`, `prod`, `production` or `live`.
fn is_production_name(name: &str) -> bool {
    name.split(|c: char| !c.is_alphanumeric())
        .any(|w| ["real", "prod", "production", "live"].iter().any(|p| w.eq_ignore_ascii_case(p)))
}

fn driver_display(driver: &str, sub: &str) -> String {
    let key = if sub.is_empty() { driver.split('.').next().unwrap_or(driver) } else { sub };
    match key.to_ascii_lowercase().as_str() {
        "trino" => "Trino".into(),
        "presto" => "Presto".into(),
        "postgresql" | "postgres" => "PostgreSQL".into(),
        "sqlserver" | "mssql" | "jtds" => "SQL Server".into(),
        "oracle" => "Oracle".into(),
        "sqlite" => "SQLite".into(),
        "clickhouse" => "ClickHouse".into(),
        "redshift" => "Redshift".into(),
        "h2" => "H2".into(),
        "" => "This database".into(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

// --- SSH configs -----------------------------------------------------------

#[derive(Debug, Clone)]
struct SshConfig {
    id: String,
    host: String,
    port: Option<u16>,
    user: Option<String>,
    auth_type: String,
    key_path: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// `$USER_HOME$` and a leading `~` mean the home folder.
fn expand_home(p: &str) -> String {
    let Some(home) = home_dir() else { return p.to_string() };
    let home = home.to_string_lossy().into_owned();
    if let Some(rest) = p.strip_prefix("$USER_HOME$") {
        return format!("{home}{rest}");
    }
    if let Some(rest) = p.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
            return format!("{home}{rest}");
        }
    }
    p.to_string()
}

fn read_ssh_configs(path: &Path) -> Vec<SshConfig> {
    let Ok(root) = read_xml(path) else { return Vec::new() };
    let mut nodes = Vec::new();
    root.descendants("sshConfig", &mut nodes);
    nodes
        .into_iter()
        .filter_map(|n| {
            let id = n.attr("id")?.to_string();
            let host = n.attr("host")?.trim().to_string();
            if host.is_empty() {
                return None;
            }
            Some(SshConfig {
                id,
                host,
                port: n.attr("port").and_then(|p| p.trim().parse().ok()),
                user: n.attr("username").map(str::trim).filter(|u| !u.is_empty()).map(str::to_string),
                auth_type: n.attr("authType").unwrap_or("PASSWORD").to_string(),
                key_path: n.attr("keyPath").map(str::trim).filter(|k| !k.is_empty()).map(expand_home),
            })
        })
        .collect()
}

/// The `sshConfigs.xml` files of the IntelliJ products on this machine, newest first.
fn app_ssh_files() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        bases.push(home.join("Library/Application Support/JetBrains"));
        let xdg = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
        bases.push(xdg.join("JetBrains"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
        bases.push(PathBuf::from(appdata).join("JetBrains"));
    }
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for base in bases {
        let Ok(entries) = std::fs::read_dir(&base) else { continue };
        for e in entries.flatten() {
            let file = e.path().join("options").join("sshConfigs.xml");
            if let Ok(modified) = std::fs::metadata(&file).and_then(|m| m.modified()) {
                found.push((modified, file));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

enum SshOutcome {
    Tunnel(SshTunnel),
    /// The data source cannot be used. The text says why.
    Unusable(String),
}

fn ssh_tunnel(cfg: &SshConfig) -> SshOutcome {
    match cfg.auth_type.as_str() {
        // The host is an alias of ~/.ssh/config. The system `ssh` reads port, user and key from there.
        "OPEN_SSH" => SshOutcome::Tunnel(SshTunnel { host: cfg.host.clone(), port: None, user: None, identity_file: None }),
        "KEY_PAIR" => SshOutcome::Tunnel(SshTunnel {
            host: cfg.host.clone(),
            port: cfg.port,
            user: cfg.user.clone(),
            identity_file: cfg.key_path.clone(),
        }),
        "PASSWORD" => SshOutcome::Unusable("The SSH tunnel uses password login. This is not supported. Use an SSH key or an OpenSSH config in IntelliJ.".into()),
        other => SshOutcome::Unusable(format!("The SSH tunnel uses the login type {other}. This is not supported.")),
    }
}

// --- Data sources ----------------------------------------------------------

/// What one `data-source` element gives, before the files are merged.
#[derive(Debug, Default, Clone)]
struct Raw {
    name: String,
    uuid: String,
    driver: String,
    url: String,
    props: Vec<(String, String)>,
    user_name: Option<String>,
    read_only: bool,
    ssh_enabled: bool,
    ssh_config_id: Option<String>,
}

fn truthy(s: &str) -> bool {
    s.trim().eq_ignore_ascii_case("true")
}

fn raw_from(n: &Node) -> Option<Raw> {
    let uuid = n.attr("uuid")?.trim().to_string();
    if uuid.is_empty() {
        return None;
    }
    let mut raw = Raw {
        name: n.attr("name").unwrap_or("").to_string(),
        uuid,
        driver: n.child_text("driver-ref").unwrap_or_default(),
        url: n.child_text("jdbc-url").unwrap_or_default(),
        user_name: n.child_text("user-name"),
        read_only: n.attr("read-only").map(truthy).unwrap_or(false) || n.child_text("read-only").map(|t| truthy(&t)).unwrap_or(false),
        ..Raw::default()
    };
    if let Some(props) = n.child("jdbc-additional-properties") {
        for p in props.children.iter().filter(|c| c.name == "property") {
            if let (Some(k), Some(v)) = (p.attr("name"), p.attr("value")) {
                raw.props.push((k.to_string(), v.to_string()));
            }
        }
    }
    if let Some(ssh) = n.child("ssh-properties") {
        raw.ssh_enabled = ssh.child_text("enabled").map(|t| truthy(&t)).or_else(|| ssh.attr("enabled").map(truthy)).unwrap_or(false);
        raw.ssh_config_id = ssh.child_text("ssh-config-id").or_else(|| ssh.attr("ssh-config-id").map(str::to_string));
    }
    Some(raw)
}

fn prop<'a>(raw: &'a Raw, name: &str) -> Option<&'a str> {
    raw.props.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

/// One data source with its password. The password never leaves this module
/// except through `file_password`.
struct Parsed {
    source: IdeaDataSource,
    password: Option<String>,
}

fn build(raw: &Raw, project_root: &str, ssh_configs: &[SshConfig]) -> Parsed {
    let jdbc = parse_jdbc(&raw.url);
    let sub = jdbc.as_ref().map(|j| j.sub.clone()).unwrap_or_default();
    let trino_like = if sub.is_empty() { raw.driver.starts_with("trino") } else { sub == "trino" };
    let mysql_like = if sub.is_empty() {
        raw.driver.starts_with("mysql") || raw.driver.starts_with("mariadb")
    } else {
        sub == "mysql" || sub == "mariadb"
    };
    let driver = if raw.driver.is_empty() { sub.clone() } else { raw.driver.clone() };

    let mut reason: Option<String> = None;
    if !mysql_like && !trino_like {
        reason = Some(format!("{} is not supported yet", driver_display(&raw.driver, &sub)));
    } else if jdbc.is_none() {
        reason = Some("Kestrel cannot read the JDBC URL of this data source".into());
    }

    // Password: URL userinfo, then the URL query, then the properties.
    let password = jdbc
        .as_ref()
        .and_then(|j| j.password.clone().or_else(|| j.param("password").map(str::to_string)))
        .filter(|p| !p.is_empty())
        .or_else(|| prop(raw, "password").map(str::to_string));
    let user = jdbc
        .as_ref()
        .and_then(|j| j.user.clone().or_else(|| j.param("user").map(str::to_string)))
        .filter(|u| !u.is_empty())
        .or_else(|| raw.user_name.clone())
        .or_else(|| prop(raw, "user").map(str::to_string))
        .unwrap_or_default();

    // SSH tunnel. Only a problem when the data source asks for it.
    let mut ssh = None;
    if raw.ssh_enabled {
        let found = raw.ssh_config_id.as_deref().and_then(|id| ssh_configs.iter().find(|c| c.id == id));
        match found {
            Some(cfg) => match ssh_tunnel(cfg) {
                SshOutcome::Tunnel(t) => ssh = Some(t),
                SshOutcome::Unusable(why) => {
                    reason.get_or_insert(why);
                }
            },
            None => {
                reason.get_or_insert_with(|| "The SSH tunnel config of this data source was not found in the IntelliJ settings".into());
            }
        }
    }

    // Trino URL: `jdbc:trino://host[:port][/catalog[/schema]][?params]`.
    // The path holds the catalog and the schema, so `database` of the URL is split here.
    let trino_ssl = jdbc.as_ref().is_some_and(|j| j.param("SSL").is_some_and(truthy) || j.port == Some(443));
    let (host, port) = match &jdbc {
        Some(j) if trino_like => (j.host.clone(), j.port.unwrap_or(if trino_ssl { 443 } else { 8080 })),
        Some(j) => (j.host.clone(), j.port.unwrap_or(if mysql_like { DEFAULT_MYSQL_PORT } else { 0 })),
        None => (String::new(), 0),
    };
    let (catalog, database, ssl, driver_kind, trino_auth) = if trino_like {
        let path = jdbc.as_ref().and_then(|j| j.database.clone()).unwrap_or_default();
        let mut parts = path.splitn(2, '/');
        let catalog = parts.next().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string);
        let schema = parts.next().map(|s| s.trim_end_matches('/').trim()).filter(|s| !s.is_empty()).map(str::to_string);
        let ssl = if trino_ssl { SslMode::Required } else { SslMode::Disabled };
        // A user name with SSL means password login. Otherwise only the user header.
        let auth = if !user.is_empty() && trino_ssl { TrinoAuth::Password } else { TrinoAuth::None };
        (catalog, schema, ssl, Driver::Trino, Some(auth))
    } else {
        (None, jdbc.as_ref().and_then(|j| j.database.clone()), jdbc.as_ref().map(ssl_from).unwrap_or_default(), Driver::Mysql, None)
    };
    let config = ConnectionConfig {
        driver: driver_kind,
        catalog,
        trino_auth,
        id: format!("idea:{}", raw.uuid),
        name: if raw.name.is_empty() { raw.uuid.clone() } else { raw.name.clone() },
        host,
        port,
        user,
        database,
        ssl,
        ssh,
        read_only: raw.read_only,
        production: is_production_name(&raw.name),
        color: None,
        init_sql: None,
        connect_timeout_sec: jdbc.as_ref().and_then(timeout_from),
        source: Some(IdeaRef { kind: "idea".into(), project_root: project_root.to_string(), uuid: raw.uuid.clone() }),
    };
    let source = IdeaDataSource {
        config,
        driver,
        supported: reason.is_none(),
        // IntelliJ keeps most passwords in its `master_key` file or a KeePass store.
        // Kestrel cannot read those. Without a password in the XML, the OS keychain
        // (or a prompt in the UI) is the only source.
        password_source: if password.is_some() { PasswordSource::File } else { PasswordSource::Keychain },
        reason,
    };
    Parsed { source, password }
}

/// Reads and merges the IntelliJ files of a project.
/// `Ok(None)` when the project has no `dataSources.xml`.
fn parse_project(project_root: &Path, app_ssh: &[PathBuf]) -> Result<Option<(PathBuf, Vec<Parsed>)>> {
    let idea = project_root.join(".idea");
    let main_path = idea.join("dataSources.xml");
    if !main_path.is_file() {
        return Ok(None);
    }
    let main = read_xml(&main_path).map_err(|e| Error::new(codes::INVALID_INPUT, format!("{} is not valid: {e}", main_path.display())))?;

    let mut nodes = Vec::new();
    let mut components = Vec::new();
    main.descendants("component", &mut components);
    for c in components.iter().filter(|c| c.attr("name") == Some("DataSourceManagerImpl")) {
        c.descendants("data-source", &mut nodes);
    }
    let mut raws: Vec<Raw> = nodes.into_iter().filter_map(raw_from).collect();

    // The local file adds the user name and the SSH settings. A broken local file is ignored.
    if let Ok(local) = read_xml(&idea.join("dataSources.local.xml")) {
        let mut local_nodes = Vec::new();
        local.descendants("data-source", &mut local_nodes);
        for l in local_nodes.into_iter().filter_map(raw_from) {
            let Some(raw) = raws.iter_mut().find(|r| r.uuid == l.uuid) else { continue };
            if raw.user_name.is_none() {
                raw.user_name = l.user_name;
            }
            if !raw.ssh_enabled && l.ssh_enabled {
                raw.ssh_enabled = true;
            }
            if raw.ssh_config_id.is_none() {
                raw.ssh_config_id = l.ssh_config_id;
            }
        }
    }

    // Project SSH configs first, then the application configs (newest product first).
    let mut ssh_configs = read_ssh_configs(&idea.join("sshConfigs.xml"));
    for f in app_ssh {
        ssh_configs.extend(read_ssh_configs(f));
    }

    let root = project_root.to_string_lossy().into_owned();
    let parsed = raws.iter().map(|r| build(r, &root, &ssh_configs)).collect();
    Ok(Some((main_path, parsed)))
}

// --- Public functions ------------------------------------------------------

/// The data sources of a project, in file order, without passwords.
pub fn list(project_root: &Path) -> Result<IdeaList> {
    list_with(project_root, &app_ssh_files())
}

fn list_with(project_root: &Path, app_ssh: &[PathBuf]) -> Result<IdeaList> {
    Ok(match parse_project(project_root, app_ssh)? {
        None => IdeaList { file: None, sources: Vec::new() },
        Some((file, parsed)) => IdeaList {
            file: Some(file.to_string_lossy().into_owned()),
            sources: parsed.into_iter().map(|p| p.source).collect(),
        },
    })
}

/// The password that the IntelliJ files hold for this data source (URL or
/// properties). The files are read again, so a changed file is used at once.
pub fn file_password(source: &IdeaRef) -> Option<String> {
    let parsed = parse_project(Path::new(&source.project_root), &[]).ok()??.1;
    let id = format!("idea:{}", source.uuid);
    parsed.into_iter().find(|p| p.source.config.id == id).and_then(|p| p.password)
}

/// The IntelliJ keychain entry. Service `IntelliJ Platform DB — <uuid>` (with an
/// em dash). IntelliJ uses the user name as the account. Some versions use an
/// empty account, so that is tried second. macOS can ask the user once.
pub fn intellij_keychain_password(uuid: &str, user: &str) -> Option<String> {
    let service = format!("IntelliJ Platform DB \u{2014} {uuid}");
    let mut accounts: Vec<&str> = Vec::new();
    if !user.is_empty() {
        accounts.push(user);
    }
    accounts.push("");
    for account in accounts {
        let Ok(entry) = keyring::Entry::new(&service, account) else { continue };
        match entry.get_password() {
            Ok(p) if !p.is_empty() => return Some(p),
            Ok(_) | Err(keyring::Error::NoEntry) => {}
            Err(e) => log::debug!("IntelliJ keychain entry could not be read: {e}"),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASS: &str = "p@ss:w/rd";

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::create_dir_all(dir.join(".idea")).unwrap();
        std::fs::write(dir.join(".idea").join(name), text).unwrap();
    }

    fn ds(name: &str, uuid: &str, driver: &str, url: &str, extra: &str) -> String {
        format!(
            r#"<data-source source="LOCAL" name="{name}" uuid="{uuid}">
  <driver-ref>{driver}</driver-ref>
  <jdbc-url>{url}</jdbc-url>
  {extra}
</data-source>"#
        )
    }

    fn file(sources: &[String]) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<project version="4"><component name="DataSourceManagerImpl" format="xml">{}</component></project>"#,
            sources.join("\n")
        )
    }

    fn list_in(dir: &Path) -> IdeaList {
        list_with(dir, &[]).unwrap()
    }

    #[test]
    fn jdbc_user_info_with_encoded_characters() {
        let j = parse_jdbc("jdbc:mysql://al%40ice:p%40ss%3Aw%2Frd@db.example.test:3307/shop?useSSL=false").unwrap();
        assert_eq!(j.user.as_deref(), Some("al@ice"));
        assert_eq!(j.password.as_deref(), Some(PASS));
        assert_eq!(j.host, "db.example.test");
        assert_eq!(j.port, Some(3307));
        assert_eq!(j.database.as_deref(), Some("shop"));
        assert_eq!(ssl_from(&j), SslMode::Disabled);
    }

    #[test]
    fn jdbc_without_database_port_or_user() {
        let j = parse_jdbc("jdbc:mysql://db.example.test").unwrap();
        assert_eq!((j.user, j.password, j.port, j.database), (None, None, None, None));
        let j = parse_jdbc("jdbc:mysql://bob@db.example.test/").unwrap();
        assert_eq!(j.user.as_deref(), Some("bob"));
        assert_eq!(j.password, None);
        assert_eq!(j.database, None);
    }

    #[test]
    fn jdbc_host_list_ipv6_and_params() {
        let j = parse_jdbc("jdbc:mariadb://h1.test:3310,h2.test:3311/d?user=u1&password=pw%21&sslMode=VERIFY_CA&connectTimeout=2500").unwrap();
        assert_eq!((j.host.as_str(), j.port), ("h1.test", Some(3310)));
        assert_eq!(j.param("user"), Some("u1"));
        assert_eq!(j.param("password"), Some("pw!"));
        assert_eq!(ssl_from(&j), SslMode::Required);
        assert_eq!(timeout_from(&j), Some(3));
        let j = parse_jdbc("jdbc:mysql://[::1]:3306/x").unwrap();
        assert_eq!((j.host.as_str(), j.port), ("::1", Some(3306)));
        assert!(parse_jdbc("jdbc:sqlite:file.db").is_none());
        assert!(parse_jdbc("jdbc:mysql://:3306/x").is_none());
        assert!(parse_jdbc("jdbc:mysql://h:notaport/x").is_none());
    }

    #[test]
    fn production_names_match_whole_words() {
        for yes in ["main@real", "Prod DB", "db-LIVE", "x (ncc/real)", "production"] {
            assert!(is_production_name(yes), "{yes}");
        }
        for no in ["alpha", "realm", "product", "delivery", "beta"] {
            assert!(!is_production_name(no), "{no}");
        }
    }

    #[test]
    fn list_has_no_password_and_keeps_file_order() {
        let dir = tempfile::tempdir().unwrap();
        let xml = file(&[
            ds("first", "u-1", "mysql.8", "jdbc:mysql://al%40ice:p%40ss%3Aw%2Frd@db.example.test:3307/shop", ""),
            ds("second real", "u-2", "mysql.8", "jdbc:mysql://db2.example.test/", r#"<read-only>true</read-only>"#),
        ]);
        write(dir.path(), "dataSources.xml", &xml);
        let l = list_in(dir.path());
        assert!(l.file.as_ref().unwrap().ends_with("dataSources.xml"));
        assert_eq!(l.sources.len(), 2);
        let a = &l.sources[0];
        assert_eq!(a.config.id, "idea:u-1");
        assert_eq!(a.config.user, "al@ice");
        assert_eq!(a.config.port, 3307);
        assert_eq!(a.password_source, PasswordSource::File);
        assert!(a.supported && a.reason.is_none());
        let src = a.config.source.as_ref().unwrap();
        assert_eq!((src.kind.as_str(), src.uuid.as_str()), ("idea", "u-1"));
        let b = &l.sources[1];
        assert_eq!(b.config.port, 3306);
        assert!(b.config.read_only && b.config.production);
        assert!(!a.config.production && !a.config.read_only);
        assert_eq!(b.password_source, PasswordSource::Keychain);
        assert_eq!(b.config.database, None);
        let json = serde_json::to_string(&l).unwrap();
        assert!(!json.contains("ss:w") && !json.contains("%3A"), "the list must not hold the password");
        assert!(json.contains("\"passwordSource\":\"file\"") && json.contains("\"projectRoot\""));
        // The password is still available inside Rust.
        let r = IdeaRef { kind: "idea".into(), project_root: dir.path().to_string_lossy().into(), uuid: "u-1".into() };
        assert_eq!(file_password(&r).as_deref(), Some(PASS));
        let r2 = IdeaRef { uuid: "u-2".into(), ..r.clone() };
        assert_eq!(file_password(&r2), None);
        let r3 = IdeaRef { uuid: "nope".into(), ..r };
        assert_eq!(file_password(&r3), None);
    }

    #[test]
    fn password_from_properties_and_query() {
        let dir = tempfile::tempdir().unwrap();
        let props = r#"<jdbc-additional-properties><property name="user" value="pu" /><property name="password" value="pp" /></jdbc-additional-properties>"#;
        let xml = file(&[
            ds("props", "u-1", "mysql.8", "jdbc:mysql://h.test:3306/d", props),
            ds("query", "u-2", "mariadb", "jdbc:mariadb://h.test/d?user=qu&amp;password=qp&amp;useSSL=true", ""),
        ]);
        write(dir.path(), "dataSources.xml", &xml);
        let l = list_in(dir.path());
        assert_eq!(l.sources[0].config.user, "pu");
        assert_eq!(l.sources[0].password_source, PasswordSource::File);
        assert_eq!(l.sources[1].config.user, "qu");
        assert_eq!(l.sources[1].config.ssl, SslMode::Required);
        let r = IdeaRef { kind: "idea".into(), project_root: dir.path().to_string_lossy().into(), uuid: "u-1".into() };
        assert_eq!(file_password(&r).as_deref(), Some("pp"));
    }

    #[test]
    fn local_file_gives_user_name() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "dataSources.xml", &file(&[ds("n", "u-1", "mysql.8", "jdbc:mysql://h.test:3306/d", "")]));
        write(
            dir.path(),
            "dataSources.local.xml",
            r#"<project version="4"><component name="dataSourceStorageLocal">
<data-source name="n" uuid="u-1"><secret-storage>master_key</secret-storage><user-name>local_user</user-name></data-source>
</component></project>"#,
        );
        let l = list_in(dir.path());
        assert_eq!(l.sources[0].config.user, "local_user");
        assert_eq!(l.sources[0].password_source, PasswordSource::Keychain);
    }

    #[test]
    fn trino_source_is_mapped() {
        let dir = tempfile::tempdir().unwrap();
        let local = r#"<project version="4"><component name="dataSourceStorageLocal"><data-source name="x" uuid="u-1"><user-name>alice</user-name></data-source></component></project>"#;
        write(dir.path(), "dataSources.local.xml", local);
        write(
            dir.path(),
            "dataSources.xml",
            &file(&[
                ds("T real", "u-1", "trino", "jdbc:trino://t.example.test:443/hive/sales?SSL=true", ""),
                ds("plain", "u-2", "trino", "jdbc:trino://t2.example.test/hive?user=bob", ""),
                ds("anon", "u-3", "trino", "jdbc:trino://t3.example.test:8443", ""),
                ds("tls no user", "u-4", "trino", "jdbc:trino://t4.example.test/c/s/?SSL=true", ""),
                ds("pg", "u-5", "postgresql", "jdbc:postgresql://p.example.test/db", ""),
            ]),
        );
        let l = list_in(dir.path());
        let s = &l.sources;
        assert!(s[0].supported && s[0].reason.is_none());
        assert_eq!(s[0].driver, "trino");
        let c = &s[0].config;
        assert_eq!((c.driver, c.host.as_str(), c.port), (Driver::Trino, "t.example.test", 443));
        assert_eq!((c.catalog.as_deref(), c.database.as_deref(), c.ssl), (Some("hive"), Some("sales"), SslMode::Required));
        assert_eq!((c.user.as_str(), c.trino_auth), ("alice", Some(TrinoAuth::Password)));
        assert!(c.production);
        assert_eq!(s[0].password_source, PasswordSource::Keychain);

        let c = &s[1].config;
        assert_eq!((c.port, c.ssl, c.user.as_str(), c.trino_auth), (8080, SslMode::Disabled, "bob", Some(TrinoAuth::None)));
        assert_eq!((c.catalog.as_deref(), c.database.as_deref()), (Some("hive"), None));

        let c = &s[2].config;
        assert_eq!((c.port, c.ssl, c.catalog.clone(), c.trino_auth), (8443, SslMode::Disabled, None, Some(TrinoAuth::None)));

        // SSL on, no user name: nothing to log in with, so `none`.
        let c = &s[3].config;
        assert_eq!((c.catalog.as_deref(), c.database.as_deref(), c.trino_auth), (Some("c"), Some("s"), Some(TrinoAuth::None)));

        assert!(!s[4].supported);
        assert_eq!(s[4].reason.as_deref(), Some("PostgreSQL is not supported yet"));
        assert_eq!(s[4].config.driver, Driver::Mysql);
    }

    #[test]
    fn ssh_configs_from_project_and_application() {
        let dir = tempfile::tempdir().unwrap();
        let ssh_prop = |id: &str| format!("<ssh-properties><enabled>true</enabled><ssh-config-id>{id}</ssh-config-id></ssh-properties>");
        let xml = file(&[
            ds("open", "u-1", "mysql.8", "jdbc:mysql://10.0.0.1:3306/d", &ssh_prop("c-open")),
            ds("key", "u-2", "mysql.8", "jdbc:mysql://10.0.0.2:3306/d", &ssh_prop("c-key")),
            ds("pass", "u-3", "mysql.8", "jdbc:mysql://10.0.0.3:3306/d", &ssh_prop("c-pass")),
            ds("missing", "u-4", "mysql.8", "jdbc:mysql://10.0.0.4:3306/d", &ssh_prop("c-none")),
            ds("off", "u-5", "mysql.8", "jdbc:mysql://10.0.0.5:3306/d", "<ssh-properties><enabled>false</enabled></ssh-properties>"),
        ]);
        write(dir.path(), "dataSources.xml", &xml);
        write(
            dir.path(),
            "sshConfigs.xml",
            r#"<project version="4"><component name="SshConfigManager"><configs>
<sshConfig authType="OPEN_SSH" host="bastion-alias" id="c-open" port="22" username="ignored" useOpenSSHConfig="true" />
<sshConfig authType="PASSWORD" host="pw.test" id="c-pass" port="22" username="x" />
</configs></component></project>"#,
        );
        let app = dir.path().join("app-ssh.xml");
        std::fs::write(
            &app,
            r#"<application><component name="SshConfigManager"><configs>
<sshConfig authType="KEY_PAIR" host="key.test" id="c-key" port="2222" username="deploy" keyPath="/keys/id_test" />
</configs></component></application>"#,
        )
        .unwrap();
        let l = list_with(dir.path(), &[app]).unwrap();
        let s = &l.sources;
        assert_eq!(s[0].config.ssh.as_ref().unwrap(), &SshTunnel { host: "bastion-alias".into(), port: None, user: None, identity_file: None });
        assert!(s[0].supported);
        let k = s[1].config.ssh.as_ref().unwrap();
        assert_eq!((k.host.as_str(), k.port, k.user.as_deref(), k.identity_file.as_deref()), ("key.test", Some(2222), Some("deploy"), Some("/keys/id_test")));
        assert!(!s[2].supported);
        assert!(s[2].reason.as_deref().unwrap().contains("password login"));
        assert!(!s[3].supported && s[3].reason.as_deref().unwrap().contains("not found"));
        assert!(s[4].supported && s[4].config.ssh.is_none());
    }

    #[test]
    fn password_ssh_without_tunnel_is_fine() {
        // A PASSWORD ssh config that no data source uses must not matter.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "dataSources.xml", &file(&[ds("n", "u-1", "mysql.8", "jdbc:mysql://h.test/d", "")]));
        write(dir.path(), "sshConfigs.xml", r#"<project><sshConfig authType="PASSWORD" host="h" id="x" /></project>"#);
        assert!(list_in(dir.path()).sources[0].supported);
    }

    #[test]
    fn broken_xml_is_an_error_and_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let none = list_in(dir.path());
        assert!(none.file.is_none() && none.sources.is_empty());
        write(dir.path(), "dataSources.xml", "<project><component name=\"DataSourceManagerImpl\"><data-source uuid=\"a\"></project>");
        let err = list_with(dir.path(), &[]).unwrap_err();
        assert_eq!(err.code(), codes::INVALID_INPUT);
        write(dir.path(), "dataSources.xml", "not xml at all <<<");
        assert!(list_with(dir.path(), &[]).is_err());
    }

    #[test]
    fn unreadable_url_and_entities() {
        let dir = tempfile::tempdir().unwrap();
        let xml = file(&[
            ds("a &amp; b", "u-1", "mysql.8", "jdbc:mysql://(host=h,port=1)/d", ""),
            ds("no-url", "u-2", "mysql.8", "", ""),
        ]);
        write(dir.path(), "dataSources.xml", &xml);
        let l = list_in(dir.path());
        assert_eq!(l.sources[0].config.name, "a & b");
        assert!(!l.sources[0].supported);
        assert!(!l.sources[1].supported);
    }
}
