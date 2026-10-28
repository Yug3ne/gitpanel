"use strict";

const { invoke } = window.__TAURI__.core;

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- icons
const ICONS = {
  "chevron-down": '<path d="m4 6 4 4 4-4"/>',
  "chevron-right": '<path d="m6 4 4 4-4 4"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
  undo: '<path d="M5 3 2 6l3 3"/><path d="M2 6h7.5a4 4 0 0 1 0 8H7"/>',
  diff: '<path d="M8 2v6M5 5h6M5 12h6"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7" stroke-width="2"/>',
  dash: '<path d="M4 8h8" stroke-width="2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5V5h-2.5"/>',
  "arrow-up": '<path d="M8 13V3M4 7l4-4 4 4"/>',
  "arrow-down": '<path d="M8 3v10M4 9l4 4 4-4"/>',
  upload: '<path d="M8 11V3M5 6l3-3 3 3M3 13h10"/>',
  loader: '<path d="M8 2a6 6 0 1 0 6 6"/>',
  sparkle: '<path d="M7 1.5 8.3 5.2 12 6.5 8.3 7.8 7 11.5 5.7 7.8 2 6.5 5.7 5.2Z"/><path d="M12.5 10v4M10.5 12h4"/>',
  folder: '<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z"/>',
};
const icon = (name, cls = "") =>
  `<span class="ico ${cls}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg></span>`;

function statusIcon(f) {
  // Zed-style: rounded square with a glyph describing the change.
  let kind = f.section === "conflict" ? "C" : f.section === "untracked" ? "U" : null;
  if (!kind) {
    const code = f.x !== "." ? f.x : f.y;
    kind = code === "A" ? "A" : code === "D" ? "D" : code === "R" || code === "C" ? "R" : "M";
  }
  const glyph = {
    M: '<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
    A: '<path d="M8 5v6M5 8h6"/>',
    U: '<path d="M8 5v6M5 8h6"/>',
    D: '<path d="M5 8h6"/>',
    R: '<path d="M5 8h6M8.5 5.5 11 8l-2.5 2.5"/>',
    C: '<path d="M8 4.8v4"/><circle cx="8" cy="11.2" r=".6" fill="currentColor"/>',
  }[kind];
  return `<svg class="status-icon st-${kind}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5"/>${glyph}</svg>`;
}

function checkbox(state) {
  const cls = state === "full" ? "on" : state === "partial" ? "mixed" : "";
  const glyph = state === "full" ? ICONS.check : state === "partial" ? ICONS.dash : "";
  return `<span class="check ${cls}" role="checkbox"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}

document.querySelectorAll("[data-icon]").forEach((el) => (el.outerHTML = icon(el.dataset.icon)));

// ---------------------------------------------------------------- state
const SECTIONS = [
  ["conflict", "Conflicts"],
  ["tracked", "Tracked"],
  ["untracked", "Untracked"],
];

const state = {
  root: null,
  status: null,
  statusKey: "",
  selected: null, // path of selected file
  collapsed: new Set(),
  tab: "changes",
  amend: false,
  amendStash: "", // message that was in the editor before toggling amend
  signoff: false,
  skipHooks: false,
  remoteOp: null,
  committing: false,
  generating: false,
  commits: [],
  commitsDone: false,
  selectedCommit: null,
  diff: null, // { kind: 'file'|'all'|'commit', path?, untracked?, hash? }
};

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

// All mutating git calls run one at a time so we never race on index.lock.
let queue = Promise.resolve();
let pending = 0;
function op(fn) {
  pending++;
  const run = queue.then(fn).finally(() => pending--);
  queue = run.catch(() => {});
  return run;
}

async function git(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

// ---------------------------------------------------------------- toasts / menus / modals
function toast(text, error = false) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.textContent = text;
  if (error) el.title = "Click to dismiss";
  el.onclick = () => el.remove();
  $("#toasts").append(el);
  setTimeout(() => el.remove(), error ? 9000 : 3500);
}

function openMenu(anchor, items, { x, y } = {}) {
  const menu = $("#menu");
  menu.innerHTML = "";
  for (const item of items) {
    if (item === "-") {
      menu.append(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.innerHTML = `<span class="ico">${item.checked ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${ICONS.check}</svg>` : ""}</span><span>${esc(item.label)}</span>${item.hint ? `<span class="spacer"></span><kbd>${esc(item.hint)}</kbd>` : ""}`;
    if (item.danger) b.classList.add("danger");
    b.disabled = !!item.disabled;
    b.onclick = () => {
      closeMenu();
      item.run();
    };
    menu.append(b);
  }
  menu.hidden = false;
  const mr = menu.getBoundingClientRect();
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.right - mr.width;
    y = r.bottom + 2;
    if (y + mr.height > innerHeight - 4) y = r.top - mr.height - 2;
  }
  menu.style.left = Math.max(4, Math.min(x, innerWidth - mr.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - mr.height - 4)) + "px";
}
function closeMenu() {
  $("#menu").hidden = true;
}
document.addEventListener("mousedown", (e) => {
  if (!$("#menu").hidden && !e.target.closest("#menu")) closeMenu();
});

function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal").innerHTML = "";
}
$("#modal-backdrop").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

function confirmDialog(text, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    modal.innerHTML = `<div class="modal-text">${esc(text)}</div>
      <div class="modal-actions"><button class="btn" data-r="0">Cancel</button><button class="btn primary ${danger ? "danger" : ""}" data-r="1">${esc(ok)}</button></div>`;
    $("#modal-backdrop").hidden = false;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    modal.querySelectorAll("button").forEach((b) => (b.onclick = () => done(b.dataset.r === "1")));
    modal.querySelector('[data-r="1"]').focus();
    modal.onkeydown = (e) => {
      if (e.key === "Escape") done(false);
    };
  });
}

/** Subsequence match score (higher is better), or -1 when `q` doesn't match. */
function fuzzyScore(q, text) {
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub !== -1) return 1000 - sub * 2 - t.length / 100 + (sub === 0 ? 500 : 0);
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (const ch of q) {
    const k = t.indexOf(ch, pos);
    if (k === -1) return -1;
    score += k === prev + 1 ? 8 : 1;
    prev = k;
    pos = k + 1;
  }
  return score;
}

/**
 * Filterable list in a modal. items: [{main, sub, current, ...}]. `load` may be a
 * promise of a fresh item list; the picker re-renders when it resolves.
 */
function picker({ placeholder, items, load, onPick, onCreate }) {
  const modal = $("#modal");
  modal.innerHTML = `<input class="picker-input" placeholder="${esc(placeholder)}" /><div class="picker-list"></div>`;
  $("#modal-backdrop").hidden = false;
  const input = $("input", modal);
  const list = $(".picker-list", modal);
  let shown = [];
  let active = 0;
  let touched = false; // until the user moves/filters, skip past the current item
  const render = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    if (!q) shown = items.slice(0, 300);
    else {
      shown = items
        .map((i) => {
          // Matching the name counts for more than matching the path/subtitle.
          const a = fuzzyScore(q, i.main);
          const b = fuzzyScore(q, i.search ?? "");
          return { i, score: Math.max(a >= 0 ? a + 200 : -1, b) };
        })
        .filter((x) => x.score >= 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 300)
        .map((x) => x.i);
    }
    if (onCreate && raw && !items.some((i) => i.main.toLowerCase() === q)) {
      shown.push({ main: `Create branch "${raw}"`, sub: "", create: raw });
    }
    if (!touched && !q) active = Math.max(0, shown.findIndex((i) => !i.current));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown
          .map(
            (i, n) =>
              `<button class="picker-item ${n === active ? "active" : ""} ${i.current ? "current" : ""}" data-n="${n}"><span class="main">${esc(i.main)}</span><span class="sub">\u200e${esc(i.sub || "")}\u200e</span></button>`,
          )
          .join("")
      : `<div class="empty">No matches</div>`;
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (n) => {
    const item = shown[n];
    if (!item) return;
    closeModal();
    item.create ? onCreate(item.create) : onPick(item);
  };
  input.oninput = () => {
    touched = true;
    active = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) active = Math.min(active + 1, shown.length - 1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) active = Math.max(active - 1, 0);
    else if (e.key === "Enter") return choose(active);
    else if (e.key === "Escape") return closeModal();
    else return;
    touched = true;
    e.preventDefault();
    e.stopPropagation();
    render();
  };
  list.onclick = (e) => {
    const b = e.target.closest(".picker-item");
    if (b) choose(+b.dataset.n);
  };
  render();
  input.focus();
  load?.then((fresh) => {
    if (!fresh || !list.isConnected) return;
    items = fresh;
    render();
  });
}

// ---------------------------------------------------------------- repo open / welcome
function recents() {
  return store.get("recentRepos", []);
}

function renderWelcome() {
  $("#app").hidden = true;
  $("#welcome").hidden = false;
  const list = recents();
  $("#recent-list").innerHTML = list.length
    ? `<div class="section-header">Recent</div>` +
      list
        .map(
          (p) =>
            `<button class="picker-item" data-path="${esc(p)}"><span class="main">${esc(p.split("/").pop())}</span><span class="sub">${esc(tilde(p))}</span></button>`,
        )
        .join("")
    : "";
}
$("#recent-list").onclick = (e) => {
  const b = e.target.closest("[data-path]");
  if (b) openRepo(b.dataset.path);
};
$("#welcome-open").onclick = () => pickRepo();
$("#welcome-project").onclick = () => repoSwitcher();

async function openRepo(path, { quiet = false } = {}) {
  let root;
  try {
    root = await invoke("open_repo", { path });
  } catch (e) {
    if (!quiet) toast(String(e), true);
    return false;
  }
  await activate(root);
  return true;
}

async function pickRepo() {
  const root = await git("pick_repo");
  if (root) await activate(root);
}

async function activate(root) {
  if (state.root && state.root !== root) saveDraft();
  state.root = root;
  state.status = null;
  state.statusKey = "";
  state.selected = null;
  state.commits = [];
  state.commitsDone = false;
  state.amend = false;
  closeDiff();
  store.set("recentRepos", [root, ...recents().filter((p) => p !== root)].slice(0, 10));
  store.set("lastRepo", root);
  $("#msg").value = store.get("draft:" + root, "");
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  await refresh();
  if (state.tab === "history") loadCommits(true);
  $("#file-list").focus();
}

function saveDraft() {
  if (state.root && !state.amend) store.set("draft:" + state.root, $("#msg").value);
}

const tilde = (p) => p.replace(/^\/home\/[^/]+/, "~");

function ago(secs) {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  if (d < 90) return "just now";
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400 * 7, "w"], [86400, "d"], [3600, "h"], [60, "m"]]) {
    if (d >= n) return `${Math.floor(d / n)}${unit} ago`;
  }
  return "";
}

let discovered = null; // { at, repos }
async function discoverRepos({ force = false } = {}) {
  if (!force && discovered && Date.now() - discovered.at < 60_000) return discovered.repos;
  const repos = await invoke("discover_repos").catch(() => []);
  discovered = { at: Date.now(), repos };
  return repos;
}

/** Recently opened repos first, then everything discovered by last git activity. */
function projectItems(repos) {
  const byPath = new Map(repos.map((r) => [r.path, r]));
  const recent = recents().slice(0, 5);
  const ordered = [...recent.map((p) => byPath.get(p) ?? { path: p, name: p.split("/").pop(), active: 0 }), ...repos.filter((r) => !recent.includes(r.path))];
  return [
    ...ordered.map((r) => ({
      main: r.name,
      sub: [tilde(r.path), ago(r.active)].filter(Boolean).join(" · "),
      search: tilde(r.path),
      path: r.path,
      current: r.path === state.root,
    })),
    { main: "Open Folder…", sub: "Ctrl O", search: "", openFolder: true },
  ];
}

function repoSwitcher() {
  picker({
    placeholder: "Switch project…",
    items: projectItems(discovered?.repos ?? []),
    load: discoverRepos({ force: true }).then(projectItems),
    onPick: (i) => (i.openFolder ? pickRepo() : openRepo(i.path)),
  });
}

/**
 * Open a path (any directory inside a repo) or, failing that, a project
 * name such as the one in a Zed window title.
 */
async function openTarget(target, { quiet = true } = {}) {
  if (!target) return false;
  if (await openRepo(target, { quiet: true })) return true;
  if (!target.includes("/")) {
    const name = target.toLowerCase();
    const hit = (await discoverRepos()).find((r) => r.name.toLowerCase() === name);
    if (hit && (await openRepo(hit.path, { quiet: true }))) return true;
  }
  if (!quiet) toast(`${tilde(target)} isn't inside a git repository`, true);
  return false;
}

// A second `gitpanel <path>` launch forwards its target here.
window.__TAURI__.event?.listen("open-path", (e) => openTarget(e.payload, { quiet: !state.root }));

// ---------------------------------------------------------------- status
async function refresh() {
  if (!state.root) return;
  let st;
  try {
    st = await invoke("status");
  } catch (e) {
    toast(String(e), true);
    return;
  }
  const key = JSON.stringify(st);
  if (key === state.statusKey) return;
  state.statusKey = key;
  state.status = st;
  render();
  reloadDiff();
}

/** Keep an open working-tree diff in sync with the latest status. */
function reloadDiff() {
  const d = state.diff;
  if (d?.kind === "all") showAllDiff({ keepScroll: true });
  if (d?.kind !== "file") return;
  const f = fileByPath(d.path);
  if (f) showFileDiff(f, { keepScroll: true });
  else showDiff("file", d.path, async () => "", { keepScroll: false });
}

const files = () => state.status?.files ?? [];
const staged = (f) => f.staged !== "none";
const hasStaged = () => files().some(staged);
const hasUnstaged = () => files().some((f) => f.staged !== "full");
const tracked = () => files().filter((f) => f.section === "tracked");
const untracked = () => files().filter((f) => f.section === "untracked");
const conflicts = () => files().filter((f) => f.section === "conflict");

/** Files in display order (respecting collapsed sections). */
function visibleFiles() {
  return SECTIONS.flatMap(([key]) => (state.collapsed.has(key) ? [] : files().filter((f) => f.section === key)));
}

function render() {
  const st = state.status;
  if (!st) return;
  // Keep the window title fixed: Hyprland's persistent_size rule keys on it.

  // header
  $("#change-count").textContent = files().length ? `(${files().length})` : "";
  let add = 0;
  let del = 0;
  for (const f of files()) {
    add += f.added ?? 0;
    del += f.removed ?? 0;
  }
  $("#total-add").textContent = `+${add}`;
  $("#total-del").textContent = `−${del}`;
  $("#view-diff").disabled = !files().length;

  // Zed: primary action is "Stage All" unless everything is already staged.
  const stageMode = !files().length || hasUnstaged();
  $("#stage-all").textContent = stageMode ? "Stage All" : "Unstage All";
  $("#stage-all").title = stageMode ? "git add --all" : "git reset";
  $("#stage-all").disabled = !files().length;

  const banner = $("#banner");
  banner.hidden = !st.operation;
  if (st.operation) banner.textContent = `A ${st.operation.replace("ing", "e")} is in progress.` + (conflicts().length ? " Resolve conflicts, stage them, then commit." : "");

  renderFiles();
  renderFooter();
}

function renderFiles() {
  const list = $("#file-list");
  if (!files().length) {
    list.innerHTML = `<div class="empty">No changes to commit</div>`;
    return;
  }
  let html = "";
  for (const [key, title] of SECTIONS) {
    const group = files().filter((f) => f.section === key);
    if (!group.length) continue;
    const collapsed = state.collapsed.has(key);
    const n = group.filter(staged).length;
    const partial = group.some((f) => f.staged === "partial");
    const sectionState = n === group.length && !partial ? "full" : n || partial ? "partial" : "none";
    html += `<div class="section-header" data-section="${key}">
      <span class="chev">${icon(collapsed ? "chevron-right" : "chevron-down")}</span>
      <span class="title">${title}</span>
      ${checkbox(sectionState)}
    </div>`;
    if (collapsed) continue;
    for (const f of group) {
      const slash = f.path.lastIndexOf("/");
      const name = f.path.slice(slash + 1);
      const dir = slash > 0 ? f.path.slice(0, slash) : "";
      const deleted = f.x === "D" || f.y === "D";
      const stats =
        f.added == null
          ? ""
          : `${f.added ? `<span class="add">+${f.added}</span>` : ""}${f.removed ? `<span class="del">−${f.removed}</span>` : ""}`;
      html += `<div class="file ${f.path === state.selected ? "selected" : ""} ${deleted ? "deleted" : ""}" data-path="${esc(f.path)}" title="${esc(f.orig_path ? `${f.orig_path} → ${f.path}` : f.path)}">
        ${statusIcon(f)}
        <span class="name">${esc(name)}</span>
        <span class="dir">‎${esc(dir)}‎</span>
        <span class="stats">${stats}</span>
        ${checkbox(f.staged)}
      </div>`;
    }
  }
  list.innerHTML = html;
}

function commitTitle() {
  if (state.amend) return hasStaged() ? "Amend" : tracked().length ? "Amend Tracked" : "Amend";
  return hasStaged() ? "Commit" : "Commit Tracked";
}

/** Mirrors Zed's configure_commit_button: [enabled, tooltip]. */
function commitEnabled() {
  if (state.generating) return [false, "Generating commit message…"];
  if (state.committing) return [false, "Commit in progress"];
  if (conflicts().some((f) => f.staged !== "full")) return [false, "You must resolve conflicts before committing"];
  if (!hasStaged() && !tracked().length && !state.amend) return [false, "No changes to commit"];
  if (!$("#msg").value.trim()) return [false, "No commit message"];
  return [true, "Ctrl Enter"];
}

function renderFooter() {
  const st = state.status;
  if (!st) return;
  $("#repo-btn").textContent = st.root.split("/").pop();
  $("#repo-btn").title = `${st.root}\nSwitch project (Ctrl P)`;
  $("#branch-name").textContent = st.branch ?? (st.head ? st.head.slice(0, 7) : "detached");

  // Remote button — same decision table as Zed's render_remote_button.
  const btn = $("#remote-btn");
  $("#remote-split").hidden = !st.has_remote || !st.branch;
  let primary;
  if (!st.upstream) primary = { op: "publish", label: "Publish", ico: "upload", tip: "git push --set-upstream" };
  else if (st.upstream_gone) primary = { op: "republish", label: "Republish", ico: "upload", tip: "git push --set-upstream" };
  else if (st.behind) primary = { op: "pull", label: `Pull`, count: `${st.ahead ? `↑${st.ahead} ` : ""}↓${st.behind}`, ico: "arrow-down", tip: "git pull" };
  else if (st.ahead) primary = { op: "push", label: "Push", count: `↑${st.ahead}`, ico: "arrow-up", tip: "git push" };
  else primary = { op: "fetch", label: "Fetch", ico: "refresh", tip: "git fetch" };
  const busy = state.remoteOp;
  btn.innerHTML = `${busy ? icon("loader", "spin") : icon(primary.ico)}<span>${busy ? busyLabel(busy) : primary.label}</span>${!busy && primary.count ? `<span class="count">${primary.count}</span>` : ""}`;
  btn.title = primary.tip;
  btn.dataset.op = primary.op;
  btn.disabled = !!busy;

  // Commit button
  const [enabled, tip] = commitEnabled();
  const cb = $("#commit-btn");
  cb.textContent = state.committing ? "Committing…" : commitTitle();
  cb.disabled = !enabled;
  cb.title = tip;
  $("#amend-tag").hidden = !state.amend;
  const gen = $("#generate");
  gen.disabled = state.generating || (!hasStaged() && !tracked().length);
  gen.innerHTML = icon(state.generating ? "loader" : "sparkle", state.generating ? "spin" : "");
  msg.readOnly = state.generating;

  // Last commit + uncommit
  $("#last-commit").hidden = !st.last_commit;
  $("#last-commit-text").textContent = st.last_commit ?? "";
  $("#last-commit-text").title = st.last_commit ?? "";
}

const busyLabel = (o) => ({ fetch: "Fetching…", pull: "Pulling…", push: "Pushing…", force_push: "Pushing…", publish: "Publishing…", republish: "Publishing…" })[o];

// ---------------------------------------------------------------- staging
function setStagedLocally(paths, value) {
  const set = new Set(paths);
  for (const f of files()) if (set.has(f.path)) f.staged = value ? "full" : "none";
  state.statusKey = "";
  render();
}

function toggleFiles(list) {
  // Like Zed: if anything in the group is unstaged, stage everything; otherwise unstage.
  const stage = list.some((f) => f.staged !== "full");
  const paths = list.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path]));
  setStagedLocally(
    list.map((f) => f.path),
    stage,
  );
  return op(() => git(stage ? "stage" : "unstage", { paths }))
    .catch(() => {})
    .finally(refresh);
}

function stageAll(stage) {
  setStagedLocally(
    files().map((f) => f.path),
    stage,
  );
  return op(() => git(stage ? "stage_all" : "unstage_all"))
    .catch(() => {})
    .finally(refresh);
}

async function discardFiles(list) {
  if (!list.length) return;
  const trackedList = list.filter((f) => f.section !== "untracked");
  const untrackedList = list.filter((f) => f.section === "untracked");
  const names = list.length === 1 ? list[0].path : `${list.length} files`;
  const ok = await confirmDialog(
    untrackedList.length && !trackedList.length
      ? `Move ${names} to the trash?`
      : `Discard all changes to ${names}?\n\nStaged and unstaged changes will be lost. New files are moved to the trash.`,
    { ok: untrackedList.length && !trackedList.length ? "Trash" : "Discard", danger: true },
  );
  if (!ok) return;
  await op(async () => {
    if (trackedList.length) await git("discard", { paths: trackedList.flatMap((f) => (f.orig_path ? [f.path, f.orig_path] : [f.path])) });
    if (!untrackedList.length) return;
    const paths = untrackedList.map((f) => f.path);
    try {
      await invoke("trash", { paths });
    } catch (e) {
      const ok = await confirmDialog(`Couldn't move to the trash:\n${e}\n\nDelete permanently instead? This cannot be undone.`, { ok: "Delete", danger: true });
      if (ok) await git("delete_files", { paths });
    }
  }).catch(() => {});
  if (state.diff?.kind === "file" && list.some((f) => f.path === state.diff.path)) closeDiff();
  refresh();
}

function stageMenuItems() {
  return [
    { label: "Stage All", disabled: !hasUnstaged(), run: () => stageAll(true) },
    { label: "Unstage All", disabled: !hasStaged(), run: () => stageAll(false) },
    "-",
    {
      label: "Stash All",
      disabled: !files().length,
      run: () => op(() => git("stash_all")).then(() => toast("Stashed all changes"), () => {}).finally(refresh),
    },
    {
      label: "Stash Pop",
      disabled: !state.status?.has_stash,
      run: () => op(() => git("stash_pop")).catch(() => {}).finally(refresh),
    },
    "-",
    { label: "Discard Tracked Changes", danger: true, disabled: !tracked().length, run: () => discardFiles(tracked()) },
    { label: "Trash Untracked Files", danger: true, disabled: !untracked().length, run: () => discardFiles(untracked()) },
  ];
}

// ---------------------------------------------------------------- file list interactions
const fileByPath = (p) => files().find((f) => f.path === p);

function select(path, { reveal = true } = {}) {
  state.selected = path;
  document.querySelectorAll("#file-list .file").forEach((el) => el.classList.toggle("selected", el.dataset.path === path));
  if (reveal) document.querySelector(`#file-list .file.selected`)?.scrollIntoView({ block: "nearest" });
  // If the diff pane is already open, follow the selection.
  const f = fileByPath(path);
  if (f && state.diff?.kind === "file") showFileDiff(f);
}

$("#file-list").addEventListener("click", (e) => {
  const header = e.target.closest(".section-header");
  if (header) {
    const key = header.dataset.section;
    if (e.target.closest(".check")) {
      toggleFiles(files().filter((f) => f.section === key));
    } else {
      state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
      renderFiles();
    }
    return;
  }
  const row = e.target.closest(".file");
  if (!row) return;
  const f = fileByPath(row.dataset.path);
  if (!f) return;
  if (e.target.closest(".check")) {
    toggleFiles([f]);
    return;
  }
  select(f.path);
  showFileDiff(f);
});

$("#file-list").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const row = e.target.closest(".file");
  if (!row) {
    openMenu(null, stageMenuItems(), { x: e.clientX, y: e.clientY });
    return;
  }
  const f = fileByPath(row.dataset.path);
  select(f.path);
  openMenu(
    null,
    [
      { label: f.staged === "full" ? "Unstage" : "Stage", hint: "Space", run: () => toggleFiles([f]) },
      { label: "Open Diff", hint: "Enter", run: () => showFileDiff(f) },
      "-",
      { label: "Copy Path", run: () => copy(`${state.root}/${f.path}`) },
      { label: "Copy Relative Path", run: () => copy(f.path) },
      "-",
      f.section === "untracked"
        ? { label: "Trash File", danger: true, run: () => discardFiles([f]) }
        : { label: "Discard Changes", danger: true, run: () => discardFiles([f]) },
    ],
    { x: e.clientX, y: e.clientY },
  );
});

$("#file-list").addEventListener("keydown", (e) => {
  const list = visibleFiles();
  if (!list.length) return;
  const i = list.findIndex((f) => f.path === state.selected);
  const cur = list[i];
  if (e.key === "ArrowDown" || e.key === "j") select(list[Math.min(i + 1, list.length - 1)].path);
  else if (e.key === "ArrowUp" || e.key === "k") select(list[Math.max(i - 1, 0)].path);
  else if (e.key === " " && cur) toggleFiles([cur]);
  else if (e.key === "Enter" && cur) showFileDiff(cur);
  else if ((e.key === "Delete" || e.key === "Backspace") && cur) discardFiles([cur]);
  else return;
  e.preventDefault();
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Clipboard unavailable", true);
  }
}

$("#stage-all").onclick = () => stageAll(hasUnstaged());
$("#view-diff").onclick = () => showAllDiff();

// ---------------------------------------------------------------- commit
const msg = $("#msg");
msg.addEventListener("input", () => {
  renderFooter();
  clearTimeout(msg._t);
  msg._t = setTimeout(saveDraft, 400);
});
msg.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    doCommit();
  }
});

async function doCommit() {
  if (!commitEnabled()[0]) return;
  const message = msg.value;
  const options = {
    tracked: !hasStaged(),
    amend: state.amend,
    signoff: state.signoff,
    skip_hooks: state.skipHooks,
  };
  state.committing = true;
  renderFooter();
  try {
    const summary = await op(() => git("commit", { message, options }));
    msg.value = state.amend ? state.amendStash : "";
    state.amend = false;
    state.amendStash = "";
    store.set("draft:" + state.root, msg.value);
    toast(summary || "Committed");
    state.commits = [];
    state.commitsDone = false;
    if (state.tab === "history") loadCommits(true);
  } catch {
    // error already toasted (hook output etc.)
  } finally {
    state.committing = false;
    await refresh();
    renderFooter();
  }
}
$("#commit-btn").onclick = doCommit;

async function generateMessage() {
  if (state.generating || $("#generate").disabled) return;
  state.generating = true;
  renderFooter();
  try {
    msg.value = await invoke("generate_commit_message");
    saveDraft();
  } catch (e) {
    toast(String(e), true);
  } finally {
    state.generating = false;
    renderFooter();
    msg.focus();
  }
}
$("#generate").onclick = generateMessage;

async function toggleAmend() {
  if (!state.amend) {
    const head = await git("head_message").catch(() => null);
    if (head == null) return;
    state.amendStash = msg.value;
    msg.value = head;
    state.amend = true;
  } else {
    msg.value = state.amendStash;
    state.amend = false;
  }
  renderFooter();
  msg.focus();
}
$("#amend-cancel").onclick = () => state.amend && toggleAmend();

async function uncommit() {
  const pushedTo = await git("head_pushed_to").catch(() => null);
  if (pushedTo == null) return;
  // Zed asks for confirmation only when the commit already exists on a remote.
  if (pushedTo.length && !(await confirmDialog(`Are you sure?\n\nThis commit was already pushed to ${pushedTo.join(", ")}.`, { ok: "Uncommit", danger: true }))) return;
  try {
    const message = await op(() => git("uncommit"));
    if (state.amend) state.amend = false;
    msg.value = message;
    saveDraft();
    state.commits = [];
    state.commitsDone = false;
    if (state.tab === "history") loadCommits(true);
  } catch {}
  refresh();
}
$("#uncommit").onclick = uncommit;

// ---------------------------------------------------------------- remote
async function remote(opName) {
  if (state.remoteOp) return;
  if (opName === "force_push" && !(await confirmDialog("Force push (with lease) to the upstream branch?", { ok: "Force Push", danger: true }))) return;
  state.remoteOp = opName;
  renderFooter();
  try {
    const out = await invoke("remote", { op: opName });
    const done = { fetch: "Fetched", pull: "Pulled", push: "Pushed", force_push: "Force pushed", publish: "Published", republish: "Published" }[opName];
    // Fetch is chatty about nothing; only show its output if it has any.
    toast(opName === "fetch" && !out ? "Already up to date" : `${done}${out ? `\n${lastLines(out, 4)}` : ""}`);
  } catch (e) {
    toast(String(e), true);
  } finally {
    state.remoteOp = null;
    await refresh();
    renderFooter();
  }
}
const lastLines = (s, n) => s.trim().split("\n").filter((l) => !/^(remote: *$|To |Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l)).slice(-n).join("\n");

$("#remote-btn").onclick = (e) => remote(e.currentTarget.dataset.op);

// ---------------------------------------------------------------- branches
async function branchPicker() {
  const branches = await git("branches").catch(() => null);
  if (!branches) return;
  picker({
    placeholder: "Switch to branch…",
    items: branches.map((b) => ({ main: b.name, sub: b.date, current: b.current, value: b.name })),
    onPick: (b) => !b.current && switchBranch(b.value, false),
    onCreate: (name) => switchBranch(name, true),
  });
}
async function switchBranch(name, create) {
  try {
    await op(() => git("switch_branch", { name, create }));
    toast(create ? `Created and switched to ${name}` : `Switched to ${name}`);
  } catch {}
  state.commits = [];
  state.commitsDone = false;
  if (state.tab === "history") loadCommits(true);
  refresh();
}
$("#branch-btn").onclick = branchPicker;
$("#repo-btn").onclick = repoSwitcher;

// ---------------------------------------------------------------- split-button menus
document.querySelectorAll("[data-menu]").forEach((b) => {
  b.onclick = () => {
    if (b.dataset.menu === "stage") openMenu(b, stageMenuItems());
    if (b.dataset.menu === "remote")
      openMenu(b, [
        { label: "Fetch", run: () => remote("fetch") },
        { label: "Pull", disabled: !state.status?.upstream, run: () => remote("pull") },
        { label: "Push", disabled: !state.status?.upstream, run: () => remote("push") },
        { label: "Force Push", danger: true, disabled: !state.status?.upstream, run: () => remote("force_push") },
        "-",
        { label: "Publish Branch", run: () => remote("publish") },
      ]);
    if (b.dataset.menu === "commit")
      openMenu(b, [
        { label: "Amend", checked: state.amend, disabled: !state.status?.head, run: toggleAmend },
        { label: "Signoff", checked: state.signoff, run: () => ((state.signoff = !state.signoff), renderFooter()) },
        { label: "Skip Hooks", hint: "--no-verify", checked: state.skipHooks, run: () => ((state.skipHooks = !state.skipHooks), renderFooter()) },
      ]);
  };
});

// ---------------------------------------------------------------- tabs / history
function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#changes-view").hidden = tab !== "changes";
  $("#history-view").hidden = tab !== "history";
  if (tab === "history" && !state.commits.length) loadCommits(true);
  (tab === "history" ? $("#commit-list") : $("#file-list")).focus();
}
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));

let loadingCommits = false;
async function loadCommits(reset = false) {
  if (loadingCommits || (!reset && state.commitsDone)) return;
  loadingCommits = true;
  try {
    const skip = reset ? 0 : state.commits.length;
    const batch = await git("log", { skip, limit: 150 });
    state.commits = reset ? batch : state.commits.concat(batch);
    state.commitsDone = batch.length < 150;
    renderCommits();
  } catch {
  } finally {
    loadingCommits = false;
  }
}

function renderCommits() {
  const list = $("#commit-list");
  if (!state.commits.length) {
    list.innerHTML = `<div class="empty">No commits yet</div>`;
    return;
  }
  list.innerHTML = state.commits
    .map((c) => {
      const refs = c.refs
        ? c.refs
            .split(", ")
            .map((r) => `<span class="ref ${r.startsWith("HEAD") ? "head" : ""}">${esc(r.replace("HEAD -> ", ""))}</span>`)
            .join("")
        : "";
      return `<div class="commit ${c.hash === state.selectedCommit ? "selected" : ""}" data-hash="${c.hash}">
        <div class="subject">${refs}${esc(c.subject)}</div>
        <div class="meta"><span class="hash">${c.short}</span><span>${esc(c.author)}</span><span>${esc(c.date)}</span></div>
      </div>`;
    })
    .join("");
}

function selectCommit(hash) {
  state.selectedCommit = hash;
  document.querySelectorAll("#commit-list .commit").forEach((el) => el.classList.toggle("selected", el.dataset.hash === hash));
  document.querySelector("#commit-list .commit.selected")?.scrollIntoView({ block: "nearest" });
  showCommitDiff(state.commits.find((c) => c.hash === hash));
}

$("#commit-list").addEventListener("click", (e) => {
  const row = e.target.closest(".commit");
  if (row) selectCommit(row.dataset.hash);
});
$("#commit-list").addEventListener("scroll", (e) => {
  const el = e.currentTarget;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) loadCommits();
});
$("#commit-list").addEventListener("keydown", (e) => {
  const i = state.commits.findIndex((c) => c.hash === state.selectedCommit);
  if (e.key === "ArrowDown" || e.key === "j") selectCommit(state.commits[Math.min(i + 1, state.commits.length - 1)].hash);
  else if (e.key === "ArrowUp" || e.key === "k") selectCommit(state.commits[Math.max(i - 1, 0)].hash);
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- diff pane
let diffSeq = 0;
async function showDiff(kind, title, load, { keepScroll = false } = {}) {
  const seq = ++diffSeq;
  $("#app").classList.add("with-diff");
  $("#diff-pane").hidden = false;
  $("#diff-title").textContent = title;
  try {
    const text = await load();
    if (seq !== diffSeq) return;
    const body = $("#diff-body");
    const html = renderDiff(text);
    if (keepScroll && body._html === html) return;
    const top = body.scrollTop;
    body.innerHTML = html;
    body._html = html;
    body.scrollTop = keepScroll ? top : 0;
  } catch (e) {
    if (seq === diffSeq) $("#diff-body").innerHTML = `<pre class="d-pre del">${esc(e)}</pre>`;
  }
}
function showFileDiff(f, opts) {
  state.diff = { kind: "file", path: f.path };
  showDiff("file", f.path, () => invoke("diff_file", { path: f.path, untracked: f.section === "untracked" }), opts);
}
function showAllDiff(opts) {
  state.diff = { kind: "all" };
  showDiff("all", "Uncommitted Changes", () => invoke("diff_all"), opts);
}
function showCommitDiff(c) {
  if (!c) return;
  state.diff = { kind: "commit", hash: c.hash };
  showDiff("commit", `${c.short} ${c.subject}`, () => invoke("show_commit", { hash: c.hash }));
}
function closeDiff() {
  state.diff = null;
  diffSeq++;
  $("#app").classList.remove("with-diff");
  $("#diff-pane").hidden = true;
  $("#diff-body").innerHTML = "";
  $("#diff-body")._html = null;
}
$("#diff-close").onclick = () => {
  closeDiff();
  (state.tab === "history" ? $("#commit-list") : $("#file-list")).focus();
};

function renderDiff(text) {
  if (!text.trim()) return `<div class="empty">No changes</div>`;
  const out = [];
  const lines = text.split("\n");
  let i = 0;
  // Anything before the first "diff --git" (commit header / stat) is shown verbatim.
  const first = lines.findIndex((l) => l.startsWith("diff --git") || l.startsWith("diff --cc"));
  if (first !== 0) {
    const head = (first === -1 ? lines : lines.slice(0, first)).join("\n").trim();
    if (head) out.push(`<pre class="d-pre">${esc(head)}</pre>`);
    if (first === -1) return out.join("");
    i = first;
  }
  let oldN = 0;
  let newN = 0;
  let file = null;
  const flushFile = () => {
    if (!file) return;
    out.push(`<div class="d-file"><span>${esc(file.name)}</span>${file.tag ? `<span class="tag">${esc(file.tag)}</span>` : ""}</div>`);
    out.push(file.body.join(""));
    file = null;
  };
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git") || l.startsWith("diff --cc")) {
      flushFile();
      const m = l.match(/ b\/(.*)$/) || l.match(/diff --cc (.*)$/);
      file = { name: m ? m[1] : l, tag: "", body: [] };
      continue;
    }
    if (!file) continue;
    if (l.startsWith("@@")) {
      const m = l.match(/^@@+ -(\d+)(?:,\d+)? .*?\+(\d+)/);
      if (m) {
        oldN = +m[1];
        newN = +m[2];
      }
      file.body.push(`<div class="d-hunk">${esc(l)}</div>`);
    } else if (l.startsWith("new file")) file.tag = "new file";
    else if (l.startsWith("deleted file")) file.tag = "deleted";
    else if (l.startsWith("rename from ")) file.tag = `renamed from ${l.slice(12)}`;
    else if (l.startsWith("Binary files")) file.body.push(`<div class="d-meta">Binary file</div>`);
    else if (/^(index |--- |\+\+\+ |old mode|new mode|similarity|rename to|copy )/.test(l)) continue;
    else if (l.startsWith("+")) file.body.push(line("add", "", newN++, l));
    else if (l.startsWith("-")) file.body.push(line("del", oldN++, "", l));
    else if (l.startsWith(" ")) file.body.push(line("", oldN++, newN++, l));
    else if (l.startsWith("\\")) file.body.push(`<div class="d-meta">${esc(l.slice(2))}</div>`);
  }
  flushFile();
  return out.join("");
}
const line = (cls, a, b, text) => `<div class="d-line ${cls}"><span class="ln">${a}</span><span class="ln">${b}</span><span class="tx">${esc(text)}</span></div>`;

// ---------------------------------------------------------------- global keys & polling
document.addEventListener("keydown", (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") {
    if (!$("#menu").hidden) return closeMenu();
    if (!$("#modal-backdrop").hidden) return closeModal();
    if (state.diff) return $("#diff-close").click();
  }
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  if (k === "o") pickRepo();
  else if (k === "r") refresh();
  else if (k === "b" && state.root) branchPicker();
  else if (k === "p") repoSwitcher();
  else if (k === "1") setTab("changes");
  else if (k === "2") setTab("history");
  else if (k === "m" && state.root) msg.focus();
  else if (k === "g" && state.root) generateMessage();
  else return;
  e.preventDefault();
});

window.addEventListener("focus", () => refresh());
let lastPoll = 0;
setInterval(() => {
  // Poll fast while focused, slowly in the background; skip while git is busy.
  const interval = document.hasFocus() ? 2000 : 10000;
  if (pending || state.committing || Date.now() - lastPoll < interval) return;
  lastPoll = Date.now();
  refresh();
}, 1000);

// ---------------------------------------------------------------- boot
(async () => {
  const launch = await invoke("launch_path");
  if (launch && (await openTarget(launch))) return;
  const last = store.get("lastRepo", null);
  if (last && (await openRepo(last, { quiet: true }))) return;
  renderWelcome();
})();
