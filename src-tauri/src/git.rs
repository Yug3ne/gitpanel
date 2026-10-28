//! Thin wrapper around the `git` CLI. Every operation shells out so the app
//! behaves exactly like the user's own git (hooks, config, credentials).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

type Res<T> = Result<T, String>;

/// Diffs larger than this are truncated before being sent to the UI.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
/// Diff size sent to the model when generating a commit message.
const MAX_PROMPT_DIFF_BYTES: usize = 60 * 1024;
/// Instructions for generating a commit message from a diff.
const COMMIT_PROMPT: &str = include_str!("commit_message_prompt.txt");

/// Untracked files larger than this don't get a line count.
const MAX_COUNT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct RepoEntry {
    path: String,
    name: String,
    /// Last git activity (index / HEAD / reflog mtime), unix seconds.
    active: u64,
}

/// Directories never worth descending into when looking for repositories.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "vendor", "dist", "build", "venv", "__pycache__"];
const DISCOVER_DEPTH: usize = 5;

/// Find git repositories under `$GITPANEL_ROOTS` (colon-separated) or `$HOME`,
/// most recently active first. Hidden directories are skipped.
pub fn discover_repos() -> Vec<RepoEntry> {
    let roots: Vec<PathBuf> = match std::env::var_os("GITPANEL_ROOTS") {
        Some(v) => std::env::split_paths(&v).collect(),
        None => std::env::var_os("HOME").map(PathBuf::from).into_iter().collect(),
    };
    let mut out = Vec::new();
    for root in roots {
        walk(&root, 0, &mut out);
    }
    out.sort_by(|a, b| b.active.cmp(&a.active));
    out
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<RepoEntry>) {
    let git = dir.join(".git");
    if git.exists() {
        out.push(repo_entry(dir, &git));
        // A dotfiles repo at the root shouldn't hide the projects beneath it.
        if depth > 0 {
            return;
        }
    }
    if depth >= DISCOVER_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        // file_type() doesn't follow symlinks, so link loops are impossible.
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
            continue;
        }
        walk(&e.path(), depth + 1, out);
    }
}

fn repo_entry(dir: &Path, git: &Path) -> RepoEntry {
    let mtime = |p: PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let active = ["index", "HEAD", "logs/HEAD", "FETCH_HEAD"]
        .iter()
        .filter_map(|f| mtime(git.join(f)))
        .chain(mtime(git.to_path_buf()))
        .max()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    RepoEntry {
        path: dir.to_string_lossy().into_owned(),
        name: dir.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        active,
    }
}

#[derive(Clone)]
pub struct Repo {
    pub root: String,
    git_dir: PathBuf,
}

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    orig_path: Option<String>,
    /// Index status letter (porcelain v2 `X`), `?` for untracked.
    x: char,
    /// Worktree status letter (porcelain v2 `Y`).
    y: char,
    /// `tracked` | `untracked` | `conflict`
    section: &'static str,
    /// `none` | `partial` | `full`
    staged: &'static str,
    added: Option<u64>,
    removed: Option<u64>,
}

#[derive(Serialize)]
pub struct Status {
    root: String,
    branch: Option<String>,
    head: Option<String>,
    upstream: Option<String>,
    /// Upstream configured but the remote branch no longer exists.
    upstream_gone: bool,
    ahead: u32,
    behind: u32,
    has_remote: bool,
    has_stash: bool,
    last_commit: Option<String>,
    /// `merging` | `rebasing` | `cherry-picking` | `reverting`
    operation: Option<&'static str>,
    files: Vec<FileEntry>,
}

#[derive(Deserialize)]
pub struct CommitOptions {
    /// Stage all tracked changes first (`commit -a`), used when nothing is staged.
    tracked: bool,
    amend: bool,
    signoff: bool,
    skip_hooks: bool,
}

#[derive(Serialize)]
pub struct Commit {
    hash: String,
    short: String,
    author: String,
    date: String,
    subject: String,
    refs: String,
}

#[derive(Serialize)]
pub struct Branch {
    name: String,
    current: bool,
    date: String,
    subject: String,
}

fn git(dir: &str) -> Command {
    let mut c = Command::new("git");
    c.arg("-C")
        .arg(dir)
        // Normalise output the UI parses, regardless of the user's config.
        .args(["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false"])
        .args(["-c", "color.ui=false", "-c", "core.quotePath=false"])
        // Never block on prompts or steal index.lock from the user's own git.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null());
    c
}

fn output(mut cmd: Command, ok_codes: &[i32]) -> Res<String> {
    let out = cmd.output().map_err(|e| format!("failed to run git: {e}"))?;
    let code = out.status.code().unwrap_or(-1);
    if out.status.success() || ok_codes.contains(&code) {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.is_empty() {
        Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(err)
    }
}

/// Locate the `claude` CLI. Desktop launchers often have a minimal PATH, so
/// check the usual install locations too.
fn claude_bin() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("GITPANEL_CLAUDE") {
        return Some(PathBuf::from(p));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join("claude")).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain([home.join(".local/bin/claude"), home.join(".claude/local/claude")])
        .find(|p| p.is_file())
}

fn truncate(mut s: String) -> String {
    if s.len() > MAX_DIFF_BYTES {
        let mut cut = MAX_DIFF_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n\n… diff truncated …\n");
    }
    s
}

/// Line count of a text file, `None` for binaries / huge files.
fn count_lines(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_COUNT_BYTES {
        return None;
    }
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.read_to_end(&mut buf).ok()?;
    if buf[..buf.len().min(8000)].contains(&0) {
        return None;
    }
    let mut n = buf.iter().filter(|&&b| b == b'\n').count() as u64;
    if buf.last().is_some_and(|&b| b != b'\n') {
        n += 1;
    }
    Some(n)
}

impl Repo {
    pub fn open(path: &str) -> Res<Repo> {
        let out = output(
            {
                let mut c = git(path);
                c.args(["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
                c
            },
            &[],
        )
        .map_err(|e| {
            if e.contains("not a git repository") {
                format!("{path} is not inside a git repository")
            } else {
                e
            }
        })?;
        let mut lines = out.lines();
        let root = lines.next().unwrap_or_default().to_string();
        let git_dir = PathBuf::from(lines.next().unwrap_or_default());
        if root.is_empty() {
            return Err("Bare repositories are not supported".into());
        }
        Ok(Repo { root, git_dir })
    }

    fn cmd(&self) -> Command {
        git(&self.root)
    }

    fn run(&self, args: &[&str]) -> Res<String> {
        let mut c = self.cmd();
        c.args(args);
        output(c, &[])
    }

    fn run_paths(&self, args: &[&str], paths: &[String]) -> Res<String> {
        if paths.is_empty() {
            return Ok(String::new());
        }
        let mut c = self.cmd();
        c.args(args).arg("--").args(paths);
        output(c, &[])
    }

    fn has_head(&self) -> bool {
        self.run(&["rev-parse", "-q", "--verify", "HEAD"]).is_ok()
    }

    /// HEAD, or the empty tree when the branch has no commits yet.
    fn base(&self) -> Res<String> {
        if self.has_head() {
            Ok("HEAD".into())
        } else {
            let tree = self.run(&["hash-object", "-t", "tree", "/dev/null"])?;
            Ok(tree.trim().to_string())
        }
    }

    fn operation(&self) -> Option<&'static str> {
        let g = &self.git_dir;
        if g.join("rebase-merge").exists() || g.join("rebase-apply").exists() {
            Some("rebasing")
        } else if g.join("MERGE_HEAD").exists() {
            Some("merging")
        } else if g.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-picking")
        } else if g.join("REVERT_HEAD").exists() {
            Some("reverting")
        } else {
            None
        }
    }

    pub fn status(&self) -> Res<Status> {
        let out = self.run(&[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ])?;

        let mut st = Status {
            root: self.root.clone(),
            branch: None,
            head: None,
            upstream: None,
            upstream_gone: false,
            ahead: 0,
            behind: 0,
            has_remote: false,
            has_stash: false,
            last_commit: None,
            operation: self.operation(),
            files: Vec::new(),
        };

        let mut has_ab = false;
        let mut toks = out.split('\0');
        while let Some(t) = toks.next() {
            if t.is_empty() {
                continue;
            }
            if let Some(h) = t.strip_prefix("# ") {
                if let Some(v) = h.strip_prefix("branch.oid ") {
                    st.head = (v != "(initial)").then(|| v.to_string());
                } else if let Some(v) = h.strip_prefix("branch.head ") {
                    st.branch = (v != "(detached)").then(|| v.to_string());
                } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                    st.upstream = Some(v.to_string());
                } else if let Some(v) = h.strip_prefix("branch.ab ") {
                    has_ab = true;
                    for part in v.split(' ') {
                        if let Some(n) = part.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                continue;
            }

            let (xy, path, orig, section) = match t.as_bytes()[0] {
                b'1' => {
                    let p: Vec<&str> = t.splitn(9, ' ').collect();
                    (p[1], p[8], None, "tracked")
                }
                b'2' => {
                    let p: Vec<&str> = t.splitn(10, ' ').collect();
                    (p[1], p[9], toks.next(), "tracked")
                }
                b'u' => {
                    let p: Vec<&str> = t.splitn(11, ' ').collect();
                    (p[1], p[10], None, "conflict")
                }
                b'?' => ("??", &t[2..], None, "untracked"),
                _ => continue,
            };
            let mut c = xy.chars();
            let (x, y) = (c.next().unwrap_or('.'), c.next().unwrap_or('.'));
            let staged = match (section, x != '.', y != '.') {
                ("tracked", true, false) => "full",
                ("tracked", true, true) => "partial",
                _ => "none",
            };
            st.files.push(FileEntry {
                path: path.to_string(),
                orig_path: orig.map(str::to_string),
                x,
                y,
                section,
                staged,
                added: None,
                removed: None,
            });
        }

        st.upstream_gone = st.upstream.is_some() && !has_ab;

        // Line counts relative to HEAD (index + worktree combined), like Zed.
        let base = self.base()?;
        let stats = self.numstat(&base)?;
        for f in &mut st.files {
            if f.section == "untracked" {
                f.added = count_lines(&Path::new(&self.root).join(&f.path));
                f.removed = Some(0);
            } else if let Some(&(a, r)) = stats.get(&f.path) {
                f.added = a;
                f.removed = r;
            }
        }

        if st.head.is_some() {
            st.last_commit = self.run(&["log", "-1", "--format=%s"]).ok().map(|s| s.trim().to_string());
        }
        st.has_remote = !self.run(&["remote"])?.trim().is_empty();
        st.has_stash = self.run(&["rev-parse", "-q", "--verify", "refs/stash"]).is_ok();
        Ok(st)
    }

    fn numstat(&self, base: &str) -> Res<HashMap<String, (Option<u64>, Option<u64>)>> {
        let out = self.run(&["diff", base, "--numstat", "-z", "--no-renames", "--no-ext-diff"])?;
        let mut map = HashMap::new();
        for rec in out.split('\0') {
            let mut p = rec.splitn(3, '\t');
            if let (Some(a), Some(r), Some(path)) = (p.next(), p.next(), p.next()) {
                map.insert(path.to_string(), (a.parse().ok(), r.parse().ok()));
            }
        }
        Ok(map)
    }

    pub fn stage(&self, paths: &[String]) -> Res<()> {
        self.run_paths(&["add", "-A"], paths).map(drop)
    }

    pub fn unstage(&self, paths: &[String]) -> Res<()> {
        if self.has_head() {
            self.run_paths(&["restore", "--staged"], paths).map(drop)
        } else {
            self.run_paths(&["rm", "--cached", "-r", "-q"], paths).map(drop)
        }
    }

    pub fn stage_all(&self) -> Res<()> {
        self.run(&["add", "-A"]).map(drop)
    }

    pub fn unstage_all(&self) -> Res<()> {
        if self.has_head() {
            self.run(&["reset", "-q"]).map(drop)
        } else {
            self.run(&["rm", "--cached", "-r", "-q", "."]).map(drop)
        }
    }

    /// Revert tracked files to HEAD (both index and worktree). Files that
    /// don't exist in HEAD (newly added) are unstaged and moved to the trash.
    pub fn discard(&self, paths: &[String]) -> Res<()> {
        let has_head = self.has_head();
        let (in_head, new): (Vec<String>, Vec<String>) = paths.iter().cloned().partition(|p| {
            has_head && self.run(&["cat-file", "-e", &format!("HEAD:{p}")]).is_ok()
        });
        self.run_paths(&["restore", "--source=HEAD", "--staged", "--worktree"], &in_head)?;
        if !new.is_empty() {
            self.run_paths(&["rm", "--cached", "-r", "-q", "--ignore-unmatch"], &new)?;
            self.trash(&new)?;
        }
        Ok(())
    }

    /// Move files to the desktop trash (recoverable) via `gio trash`.
    pub fn trash(&self, paths: &[String]) -> Res<()> {
        let existing: Vec<PathBuf> = paths
            .iter()
            .map(|p| Path::new(&self.root).join(p))
            .filter(|p| p.symlink_metadata().is_ok())
            .collect();
        if existing.is_empty() {
            return Ok(());
        }
        let out = Command::new("gio")
            .arg("trash")
            .arg("--")
            .args(&existing)
            .output()
            .map_err(|e| format!("failed to run `gio trash`: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// Permanently delete untracked files (fallback when trashing fails).
    pub fn delete_files(&self, paths: &[String]) -> Res<()> {
        let root = Path::new(&self.root);
        for p in paths {
            let full = root.join(p);
            let parent = full.parent().and_then(|d| d.canonicalize().ok());
            if p.split('/').any(|c| c == "..") || !parent.is_some_and(|d| d.starts_with(root)) {
                return Err(format!("refusing to delete {p}: outside the repository"));
            }
            let meta = full.symlink_metadata().map_err(|e| format!("{p}: {e}"))?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&full)
            } else {
                std::fs::remove_file(&full)
            }
            .map_err(|e| format!("{p}: {e}"))?;
        }
        Ok(())
    }

    pub fn stash_all(&self) -> Res<()> {
        self.run(&["stash", "push", "--include-untracked"]).map(drop)
    }

    pub fn stash_pop(&self) -> Res<()> {
        self.run(&["stash", "pop"]).map(drop)
    }

    pub fn head_message(&self) -> Res<String> {
        Ok(self.run(&["log", "-1", "--format=%B"])?.trim_end().to_string())
    }

    pub fn commit(&self, message: &str, opts: &CommitOptions) -> Res<String> {
        let mut c = self.cmd();
        c.args(["commit", "-F", "-"]);
        for (on, flag) in [
            (opts.tracked, "--all"),
            (opts.amend, "--amend"),
            (opts.signoff, "--signoff"),
            (opts.skip_hooks, "--no-verify"),
        ] {
            if on {
                c.arg(flag);
            }
        }
        c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = c.spawn().map_err(|e| format!("failed to run git: {e}"))?;
        child
            .stdin
            .take()
            .ok_or("no stdin")?
            .write_all(message.as_bytes())
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() {
            Ok(stdout.lines().next().unwrap_or_default().to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { stdout } else { err })
        }
    }

    /// Soft-reset HEAD by one commit and return its message so the UI can
    /// put it back into the editor.
    pub fn uncommit(&self) -> Res<String> {
        let message = self.run(&["log", "-1", "--format=%B"])?;
        if self.run(&["rev-parse", "-q", "--verify", "HEAD~1"]).is_ok() {
            self.run(&["reset", "--soft", "HEAD~1"])?;
        } else {
            // Root commit: drop the branch ref, keeping the index intact.
            self.run(&["update-ref", "-d", "HEAD"])?;
        }
        Ok(message.trim_end().to_string())
    }

    /// Remote branches that already contain HEAD.
    pub fn head_pushed_to(&self) -> Res<Vec<String>> {
        Ok(self
            .run(&["branch", "-r", "--contains", "HEAD", "--format=%(refname:short)"])?
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.ends_with("/HEAD"))
            .collect())
    }

    /// `op`: `fetch` | `pull` | `push` | `force_push` | `publish`
    pub fn remote(&self, op: &str) -> Res<String> {
        let mut c = self.cmd();
        match op {
            "fetch" => c.args(["fetch", "--all", "--prune"]),
            "pull" => c.args(["pull"]),
            "push" => c.args(["push"]),
            "force_push" => c.args(["push", "--force-with-lease"]),
            "publish" | "republish" => {
                let remotes = self.run(&["remote"])?;
                let remote = remotes
                    .lines()
                    .find(|r| *r == "origin")
                    .or_else(|| remotes.lines().next())
                    .ok_or("No remote configured")?
                    .to_string();
                c.args(["push", "-u", &remote, "HEAD"])
            }
            _ => return Err(format!("unknown remote op {op}")),
        };
        c.stdout(Stdio::piped()).stderr(Stdio::piped());
        let out = c.output().map_err(|e| e.to_string())?;
        // git prints progress / summaries on stderr even on success.
        let text = [out.stdout, out.stderr]
            .iter()
            .map(|b| String::from_utf8_lossy(b).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if out.status.success() {
            Ok(text)
        } else {
            Err(text)
        }
    }

    pub fn log(&self, skip: u32, limit: u32) -> Res<Vec<Commit>> {
        if !self.has_head() {
            return Ok(vec![]);
        }
        let out = self.run(&[
            "log",
            &format!("--skip={skip}"),
            &format!("-n{limit}"),
            "--format=%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1e",
        ])?;
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
                (f.len() == 6).then(|| Commit {
                    hash: f[0].into(),
                    short: f[1].into(),
                    author: f[2].into(),
                    date: f[3].into(),
                    subject: f[4].into(),
                    refs: f[5].into(),
                })
            })
            .collect())
    }

    pub fn diff_file(&self, path: &str, untracked: bool) -> Res<String> {
        let mut c = self.cmd();
        if untracked {
            c.args(["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path]);
            // --no-index exits 1 when the files differ.
            return output(c, &[1]).map(truncate);
        }
        c.args(["diff", "--no-ext-diff", &self.base()?, "--", path]);
        output(c, &[]).map(truncate)
    }

    pub fn diff_all(&self) -> Res<String> {
        let mut out = self.run(&["diff", "--no-ext-diff", &self.base()?])?;
        let untracked = self.run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
        for path in untracked.split('\0').filter(|p| !p.is_empty()) {
            if out.len() > MAX_DIFF_BYTES {
                break;
            }
            out.push_str(&self.diff_file(path, true)?);
        }
        Ok(truncate(out))
    }

    pub fn show_commit(&self, hash: &str) -> Res<String> {
        self.run(&[
            "show",
            "--no-ext-diff",
            "--diff-merges=first-parent",
            "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%B",
            "--stat",
            "--patch",
            hash,
        ])
        .map(truncate)
    }

    /// Draft a commit message with the `claude` CLI, from the staged diff or,
    /// when nothing is staged, all tracked changes (what Commit Tracked takes).
    pub fn generate_commit_message(&self) -> Res<String> {
        let claude = claude_bin().ok_or("Couldn't find the `claude` CLI (set GITPANEL_CLAUDE to its path)")?;
        let staged = !self.run(&["diff", "--cached", "--name-only"])?.trim().is_empty();
        let mut diff = if staged {
            self.run(&["diff", "--cached", "--no-ext-diff"])?
        } else {
            self.run(&["diff", "--no-ext-diff", &self.base()?])?
        };
        if diff.trim().is_empty() {
            return Err("No tracked changes to describe".into());
        }
        if diff.len() > MAX_PROMPT_DIFF_BYTES {
            let mut cut = MAX_PROMPT_DIFF_BYTES;
            while !diff.is_char_boundary(cut) {
                cut -= 1;
            }
            diff.truncate(cut);
            diff.push_str("\n[diff truncated]\n");
        }
        let recent = self.run(&["log", "-10", "--format=%s"]).unwrap_or_default();
        let prompt = format!(
            "{COMMIT_PROMPT}\nRecent commit subjects in this repository, for style reference:\n{recent}\nHere are the changes in this commit:\n\n{diff}"
        );

        // Headless and tool-less: no settings, plugins, hooks or MCP servers, nothing saved.
        let mut child = Command::new(claude)
            .args(["-p", "--model", "haiku", "--tools", "", "--no-session-persistence"])
            .args(["--strict-mcp-config", "--setting-sources", ""])
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to run claude: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        loop {
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                break;
            }
            if std::time::Instant::now() > deadline {
                let _ = child.kill();
                return Err("claude timed out".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || text.is_empty() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { text } else { err });
        }
        // Drop a code fence if the model wrapped its answer in one.
        let text = text
            .strip_prefix("```")
            .map(|t| t.trim_start_matches(|c: char| c != '\n').trim_end_matches("```").trim())
            .unwrap_or(&text);
        Ok(text.to_string())
    }

    pub fn branches(&self) -> Res<Vec<Branch>> {
        let out = self.run(&[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%1f%(HEAD)%1f%(committerdate:relative)%1f%(contents:subject)",
            "refs/heads",
        ])?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() == 4).then(|| Branch {
                    name: f[0].into(),
                    current: f[1] == "*",
                    date: f[2].into(),
                    subject: f[3].into(),
                })
            })
            .collect())
    }

    pub fn switch_branch(&self, name: &str, create: bool) -> Res<()> {
        if name.starts_with('-') || name.trim().is_empty() {
            return Err(format!("invalid branch name {name:?}"));
        }
        if create {
            self.run(&["switch", "-c", name]).map(drop)
        } else {
            self.run(&["switch", name]).map(drop)
        }
    }
}
