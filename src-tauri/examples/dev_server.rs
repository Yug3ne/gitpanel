//! Browser dev server: serves `ui/` and answers `invoke()` over HTTP using the
//! same git backend as the app, so the UI can be iterated on / tested in any
//! browser without a Tauri window.
//!
//!   cargo run --example dev_server -- /path/to/repo [port]
//!
//! then open http://localhost:<port> (default 1420).

#[path = "../src/git.rs"]
#[allow(dead_code)]
mod git;

use git::{CommitOptions, Repo};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const SHIM: &str = r#"<script>
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      const r = await fetch('/invoke/' + cmd, { method: 'POST', body: JSON.stringify(args || {}) });
      const j = await r.json();
      if (!r.ok) throw j;
      return j;
    },
  },
  window: { getCurrentWindow: () => ({ setTitle: async (t) => { document.title = t; } }) },
};
</script>"#;

struct Server {
    ui: PathBuf,
    launch: Option<String>,
    repo: Option<Repo>,
}

fn to<T: serde::Serialize>(v: Result<T, String>) -> Result<Value, String> {
    v.map(|x| json!(x))
}

fn arg<T: serde::de::DeserializeOwned>(v: &Value, k: &str) -> Result<T, String> {
    serde_json::from_value(v.get(k).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{k}: {e}"))
}

impl Server {
    fn invoke(&mut self, cmd: &str, a: &Value) -> Result<Value, String> {
        if cmd == "launch_path" {
            return Ok(json!(self.launch));
        }
        if cmd == "discover_repos" {
            return to(Ok(git::discover_repos()));
        }
        if cmd == "pick_repo" {
            return Ok(Value::Null);
        }
        if cmd == "open_repo" {
            let repo = Repo::open(&arg::<String>(a, "path")?)?;
            let root = repo.root.clone();
            self.repo = Some(repo);
            return Ok(json!(root));
        }
        let r = self.repo.as_ref().ok_or("No repository open")?;
        match cmd {
            "status" => to(r.status()),
            "stage" => to(r.stage(&arg::<Vec<String>>(a, "paths")?)),
            "unstage" => to(r.unstage(&arg::<Vec<String>>(a, "paths")?)),
            "stage_all" => to(r.stage_all()),
            "unstage_all" => to(r.unstage_all()),
            "discard" => to(r.discard(&arg::<Vec<String>>(a, "paths")?)),
            "trash" => to(r.trash(&arg::<Vec<String>>(a, "paths")?)),
            "delete_files" => to(r.delete_files(&arg::<Vec<String>>(a, "paths")?)),
            "stash_all" => to(r.stash_all()),
            "stash_pop" => to(r.stash_pop()),
            "head_message" => to(r.head_message()),
            "commit" => {
                let opts: CommitOptions = arg(a, "options")?;
                to(r.commit(&arg::<String>(a, "message")?, &opts))
            }
            "uncommit" => to(r.uncommit()),
            "head_pushed_to" => to(r.head_pushed_to()),
            "remote" => to(r.remote(&arg::<String>(a, "op")?)),
            "log" => to(r.log(arg(a, "skip")?, arg(a, "limit")?)),
            "diff_file" => to(r.diff_file(&arg::<String>(a, "path")?, arg(a, "untracked")?)),
            "diff_all" => to(r.diff_all()),
            "show_commit" => to(r.show_commit(&arg::<String>(a, "hash")?)),
            "generate_commit_message" => to(r.generate_commit_message()),
            "branches" => to(r.branches()),
            "switch_branch" => to(r.switch_branch(&arg::<String>(a, "name")?, arg(a, "create")?)),
            _ => Err(format!("unknown command {cmd}")),
        }
    }

    fn handle(server: &Mutex<Server>, mut stream: TcpStream) -> std::io::Result<()> {
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));
        let mut len = 0;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h)? == 0 || h == "\r\n" {
                break;
            }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body)?;

        let (status, ctype, out): (&str, &str, Vec<u8>) = if let Some(cmd) = path.strip_prefix("/invoke/") {
            let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let res = server.lock().unwrap().invoke(cmd, &args);
            match res {
                Ok(v) => ("200 OK", "application/json", v.to_string().into_bytes()),
                Err(e) => ("500 Error", "application/json", json!(e).to_string().into_bytes()),
            }
        } else if method == "GET" {
            let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
            let file = server.lock().unwrap().ui.join(rel.split('?').next().unwrap_or(rel));
            match (rel.contains(".."), std::fs::read(&file)) {
                (false, Ok(mut data)) => {
                    if rel == "index.html" {
                        let html = String::from_utf8_lossy(&data).replace("<script src=\"app.js\">", &format!("{SHIM}<script src=\"app.js\">"));
                        data = html.into_bytes();
                    }
                    let ctype = match file.extension().and_then(|e| e.to_str()) {
                        Some("html") => "text/html; charset=utf-8",
                        Some("css") => "text/css",
                        Some("js") => "text/javascript",
                        Some("png") => "image/png",
                        _ => "application/octet-stream",
                    };
                    ("200 OK", ctype, data)
                }
                _ => ("404 Not Found", "text/plain", b"not found".to_vec()),
            }
        } else {
            ("405 Method Not Allowed", "text/plain", vec![])
        };
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            out.len()
        )?;
        stream.write_all(&out)
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let launch = args.next();
    let port = args.next().unwrap_or_else(|| "1420".into());
    let ui = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    println!("gitpanel dev server on http://localhost:{port}");
    let server = Arc::new(Mutex::new(Server { ui, launch, repo: None }));
    for stream in listener.incoming().flatten() {
        let server = server.clone();
        // One thread per connection so idle pre-connects can't stall the loop.
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            if let Err(e) = Server::handle(&server, stream) {
                eprintln!("request error: {e}");
            }
        });
    }
}
