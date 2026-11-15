// Footer: branch row, commit message box, commit / amend / uncommit.

import { $, store } from "./util.js";
import { invoke, op, git } from "./api.js";
import { icon } from "./icons.js";
import { state, hasStaged, tracked, conflicts } from "./state.js";
import { toast, confirmDialog } from "./overlays.js";
import { saveDraft } from "./repo.js";
import { refresh } from "./changes.js";
import { aiModel, modelName, modelMenu } from "./ai.js";
import { loadCommits } from "./history.js";

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

export function renderFooter() {
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
  gen.title = `Generate commit message with Claude ${modelName()} (Ctrl G)\nRight-click to change model`;
  msg.readOnly = state.generating;

  // Last commit + uncommit
  $("#last-commit").hidden = !st.last_commit;
  $("#last-commit-text").textContent = st.last_commit ?? "";
  $("#last-commit-text").title = st.last_commit ?? "";
}

const busyLabel = (o) => ({ fetch: "Fetching…", pull: "Pulling…", push: "Pushing…", force_push: "Pushing…", publish: "Publishing…", republish: "Publishing…" })[o];

export const msg = $("#msg");

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

export async function generateMessage() {
  if (state.generating || $("#generate").disabled) return;
  state.generating = true;
  renderFooter();
  try {
    msg.value = await invoke("generate_commit_message", { model: aiModel() });
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

$("#generate").oncontextmenu = modelMenu;

export async function toggleAmend() {
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
