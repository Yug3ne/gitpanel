// Opening repositories: welcome screen, project switcher (Ctrl P), repo discovery.

import { $, esc, store, tilde, ago } from "./util.js";
import { invoke, git } from "./api.js";
import { state } from "./state.js";
import { toast, picker } from "./overlays.js";
import { refresh } from "./changes.js";
import { loadCommits } from "./history.js";
import { focusList } from "./tabs.js";
import { closeDiff } from "./diff.js";
import { loadPrs, renderPrs } from "./pr-list.js";

function recents() {
  return store.get("recentRepos", []);
}

export function renderWelcome() {
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

export async function openRepo(path, { quiet = false } = {}) {
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

export async function pickRepo() {
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
  state.prs = null;
  state.prsAt = 0;
  state.prError = null;
  state.prForm = null;
  closeDiff();
  store.set("recentRepos", [root, ...recents().filter((p) => p !== root)].slice(0, 10));
  store.set("lastRepo", root);
  $("#msg").value = store.get("draft:" + root, "");
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  await refresh();
  if (state.tab === "history") loadCommits(true);
  renderPrs();
  if (state.tab === "prs") loadPrs();
  focusList();
}

export function saveDraft() {
  if (state.root && !state.amend) store.set("draft:" + state.root, $("#msg").value);
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

export function repoSwitcher() {
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
export async function openTarget(target, { quiet = true } = {}) {
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

$("#repo-btn").onclick = repoSwitcher;
