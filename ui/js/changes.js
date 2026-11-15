// Changes tab: polling git status, the file list, staging and discarding.

import { $, esc } from "./util.js";
import { invoke, op, git } from "./api.js";
import { icon, statusIcon, checkbox } from "./icons.js";
import { SECTIONS, state, files, staged, hasStaged, hasUnstaged, tracked, untracked, conflicts, visibleFiles, fileByPath } from "./state.js";
import { toast, openMenu, confirmDialog, copy } from "./overlays.js";
import { renderFooter } from "./commit.js";
import { reloadDiff, showFileDiff, showAllDiff, closeDiff } from "./diff.js";
import { renderPrs } from "./pr-list.js";

export async function refresh() {
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
  // The form describes one branch; drop it if the branch changed underneath.
  if (state.prForm && state.prForm.branch !== st.branch) state.prForm = null;
  renderPrs();
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

export function stageMenuItems() {
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

$("#stage-all").onclick = () => stageAll(hasUnstaged());

$("#view-diff").onclick = () => showAllDiff();
