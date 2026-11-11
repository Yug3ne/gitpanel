// One pull request shown in the diff pane: description, checks, merge and other actions.

import { $, esc, store } from "./util.js";
import { invoke, op, git } from "./api.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { toast, openMenu, confirmDialog } from "./overlays.js";
import { refresh } from "./changes.js";
import { renderDiff, beginDiffLoad, isStale } from "./diff.js";
import { checkSummary, checkDot, reviewTag, loadPrs } from "./pr-list.js";

const MERGE_METHODS = {
  merge: ["Merge", "Create a merge commit", "a merge commit"],
  squash: ["Squash & Merge", "Squash and merge", "a squash commit"],
  rebase: ["Rebase & Merge", "Rebase and merge", "a rebase"],
};

const mergeMethod = () => (MERGE_METHODS[store.get("prMergeMethod")] ? store.get("prMergeMethod") : "merge");

const deleteAfterMerge = () => store.get("prDeleteBranch", false) === true;

function prDetail(pr) {
  const open = pr.state === "OPEN";
  const stateLabel = pr.state === "MERGED" ? `<b class="ok">Merged</b>` : pr.state === "CLOSED" ? `<b class="bad">Closed</b>` : pr.isDraft ? `<b>Draft</b>` : `<b class="ok">Open</b>`;
  const sum = checkSummary(pr.statusCheckRollup);
  const n = pr.commits?.length ?? 0;
  const status = [];
  if (sum.state)
    status.push(`<span title="${esc(sum.failed.join("\n"))}">${checkDot(sum)}Checks: <span class="${{ pass: "ok", fail: "bad", pending: "warn" }[sum.state]}">${esc(sum.text)}</span></span>`);
  if (reviewTag(pr)) status.push(`<span>Review: ${reviewTag(pr)}</span>`);
  let blocked = "";
  if (open) {
    if (pr.isDraft) blocked = "Draft pull requests can't be merged. Mark it ready for review first.";
    else if (pr.mergeable === "CONFLICTING") blocked = "This branch has conflicts with the base branch";
    if (pr.mergeable === "CONFLICTING") status.push(`<span class="bad">Conflicts with ${esc(pr.baseRefName)}</span>`);
    else if (pr.mergeStateStatus === "BLOCKED") status.push(`<span class="warn">Merging is blocked by branch rules</span>`);
    else if (pr.mergeStateStatus === "BEHIND") status.push(`<span class="warn">Behind ${esc(pr.baseRefName)}</span>`);
    else if (pr.mergeable === "MERGEABLE") status.push(`<span class="ok">No conflicts</span>`);
  }
  const busy = state.prBusy;
  const dis = busy ? "disabled" : "";
  const actions = [];
  if (open) {
    actions.push(`<div class="split">
        <button class="btn primary" data-pr-act="merge" ${busy || blocked ? "disabled" : ""} title="${esc(blocked || `gh pr merge --${mergeMethod()}${deleteAfterMerge() ? " --delete-branch" : ""}`)}">${busy === "merge" ? "Merging…" : MERGE_METHODS[mergeMethod()][0]}</button>
        <button class="btn caret" data-pr-act="merge-menu" ${dis} title="Merge options">${icon("chevron-down")}</button>
      </div>`);
    if (pr.isDraft) actions.push(`<button class="btn" data-pr-act="ready" ${dis}>Ready for Review</button>`);
    if (pr.headRefName !== state.status?.branch) actions.push(`<button class="btn" data-pr-act="checkout" ${dis} title="gh pr checkout ${pr.number}">Checkout</button>`);
  }
  actions.push(`<button class="btn" data-pr-act="web" title="${esc(pr.url)}">Open in Browser</button>`);
  return `<div class="pr-detail">
    <div class="pr-title">${esc(pr.title)} <span class="num">#${pr.number}</span></div>
    <div class="pr-meta">${stateLabel} · <b>${esc(pr.author?.login ?? "")}</b> · ${n} commit${n === 1 ? "" : "s"} from <b>${esc(pr.headRefName)}</b> into <b>${esc(pr.baseRefName)}</b> · <span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span> in ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}</div>
    ${status.length ? `<div class="pr-status">${status.join("")}</div>` : ""}
    <div class="pr-actions">${actions.join("")}</div>
    ${pr.body?.trim() ? `<pre class="pr-body">${esc(pr.body.trim())}</pre>` : `<pre class="pr-body none">No description</pre>`}
  </div>`;
}

export async function showPr(number, { keepScroll = false } = {}) {
  const seq = beginDiffLoad();
  state.diff = { kind: "pr", number };
  $("#app").classList.add("with-diff");
  $("#diff-pane").hidden = false;
  const known = state.prs?.find((p) => p.number === number);
  $("#diff-title").textContent = `#${number} ${known?.title ?? ""}`;
  const body = $("#diff-body");
  if (!keepScroll) body.innerHTML = `<div class="empty">Loading pull request…</div>`;
  try {
    const [pr, diff] = await Promise.all([invoke("pr_view", { number }), invoke("pr_diff", { number }).catch((e) => String(e))]);
    if (isStale(seq)) return;
    state.pr = pr;
    const top = body.scrollTop;
    $("#diff-title").textContent = `#${pr.number} ${pr.title}`;
    body.innerHTML = `<div id="pr-detail-slot">${prDetail(pr)}</div>${renderDiff(diff)}`;
    body._html = null;
    body.scrollTop = keepScroll ? top : 0;
  } catch (e) {
    if (!isStale(seq)) body.innerHTML = `<pre class="d-pre del">${esc(e)}</pre>`;
  }
}

/** Redraw just the header of the open pull request (button states). */
function renderPrDetail() {
  const slot = $("#pr-detail-slot");
  if (slot && state.pr && state.diff?.kind === "pr") slot.innerHTML = prDetail(state.pr);
}

/** Run a pull request action, then reload everything it may have changed. */
async function prAction(kind, run, done) {
  const pr = state.pr;
  if (!pr || state.prBusy) return;
  state.prBusy = kind;
  renderPrDetail();
  try {
    await op(run);
    toast(done);
    state.commits = [];
    state.commitsDone = false;
  } catch {
    // already toasted
  }
  state.prBusy = null;
  refresh();
  loadPrs();
  if (state.diff?.kind === "pr" && state.diff.number === pr.number) showPr(pr.number, { keepScroll: true });
}

async function mergePr() {
  const pr = state.pr;
  if (!pr || state.prBusy) return;
  const method = mergeMethod();
  const del = deleteAfterMerge();
  const ok = await confirmDialog(
    `Merge #${pr.number} into ${pr.baseRefName} with ${MERGE_METHODS[method][2]}?\n\n${pr.title}${del ? `\n\nThe branch ${pr.headRefName} will be deleted afterwards.` : ""}`,
    { ok: MERGE_METHODS[method][0] },
  );
  if (!ok) return;
  prAction("merge", () => git("pr_merge", { number: pr.number, method, delete: del }), `Merged #${pr.number} into ${pr.baseRefName}`);
}

$("#diff-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pr-act]");
  const pr = state.pr;
  if (!b || !pr) return;
  const act = b.dataset.prAct;
  if (act === "merge") mergePr();
  else if (act === "ready") prAction("ready", () => git("pr_ready", { number: pr.number }), `#${pr.number} is ready for review`);
  else if (act === "checkout") prAction("checkout", () => git("pr_checkout", { number: pr.number }), `Checked out ${pr.headRefName}`);
  else if (act === "web") git("pr_open_web", { number: pr.number }).catch(() => {});
  else if (act === "merge-menu")
    openMenu(b, [
      ...Object.entries(MERGE_METHODS).map(([id, [, label]]) => ({
        label,
        checked: id === mergeMethod(),
        run: () => (store.set("prMergeMethod", id), renderPrDetail()),
      })),
      "-",
      { label: "Delete branch after merge", checked: deleteAfterMerge(), run: () => (store.set("prDeleteBranch", !deleteAfterMerge()), renderPrDetail()) },
    ]);
});
