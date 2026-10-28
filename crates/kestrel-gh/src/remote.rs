//! Reads GitHub repositories from `git remote -v` text.

/// A remote address that points to `host/owner/name`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub remote: String,
    pub host: String,
    pub owner: String,
    pub name: String,
}

/// Parses one remote URL into (host in lower case, owner, name).
/// Forms: `https://host/o/r(.git)`, `git@host:o/r(.git)`,
/// `ssh://git@host(:port)/o/r(.git)`.
pub fn parse_url(url: &str) -> Option<(String, String, String)> {
    let url = url.trim();
    let (host_part, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
            return None;
        }
        rest.split_once('/')?
    } else {
        // scp-like form: [user@]host:path. A path that starts with / or a
        // Windows drive letter is not a host.
        let (h, p) = url.split_once(':')?;
        if h.is_empty() || h.contains('/') || h.contains('\\') || h.len() == 1 {
            return None;
        }
        (h, p)
    };
    // Drop the user and password, then the port.
    let host_port = host_part.rsplit_once('@').map(|(_, h)| h).unwrap_or(host_part);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split_once(']')?.0
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let name = parts.next().filter(|s| !s.is_empty())?;
    if parts.next().is_some() {
        return None;
    }
    Some((host.to_ascii_lowercase(), owner.to_string(), name.to_string()))
}

/// Parses the output of `git remote -v`. `origin` comes first, then the
/// other remotes in the order of the text. Each remote appears once.
pub fn parse_remotes(text: &str) -> Vec<Remote> {
    let mut seen: Vec<String> = Vec::new();
    let mut list = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(name), Some(url)) = (it.next(), it.next()) else { continue };
        if seen.iter().any(|s| s == name) {
            continue;
        }
        if let Some((host, owner, repo)) = parse_url(url) {
            seen.push(name.to_string());
            list.push(Remote { remote: name.to_string(), host, owner, name: repo });
        }
    }
    // A stable sort keeps the order of the others.
    list.sort_by_key(|r| r.remote != "origin");
    list
}
