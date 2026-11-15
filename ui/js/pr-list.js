// Pull Requests tab: the list of open pull requests (via the GitHub CLI).

import { $, esc, ago } from "./util.js";
import { invoke } from "./api.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { openPrForm, renderPrForm } from "./pr-form.js";
import { showPr } from "./pr-detail.js";

/** Roll GitHub's check runs / commit statuses up into counts and one overall state. */
export function checkSummary(rollup) {
  const sum = { pass: 0, fail: 0, pending: 0, failed: [] };
  for (const c of rollup ?? []) {
    const result = c.conclusion || c.state || "";
    if (c.status && c.status !== "COMPLETED") sum.pending++;
    else if (/^(SUCCESS|NEUTRAL|SKIPPED)$/.test(result)) sum.pass++;
    else if (/^(PENDING|EXPECTED|)$/.test(result)) sum.pending++;
    else {
      sum.fail++;
      sum.failed.push(c.name || c.context || "check");
    }
  }
  sum.state = sum.fail ? "fail" : sum.pending ? "pending" : sum.pass ? "pass" : null;
  sum.text = [sum.pass && `${sum.pass} passed`, sum.fail && `${sum.fail} failing`, sum.pending && `${sum.pending} pending`].filter(Boolean).join(", ");
  return sum;
}

export const checkDot = (sum) => (sum.state ? `<span class="dot ${sum.state}" title="Checks: ${esc(sum.text)}"></span>` : "");

const REVIEW = {
  APPROVED: ["Approved", "ok"],
  CHANGES_REQUESTED: ["Changes requested", "bad"],
  REVIEW_REQUIRED: ["Review required", "warn"],
};

export const reviewTag = (pr) => (REVIEW[pr.reviewDecision] ? `<span class="${REVIEW[pr.reviewDecision][1]}">${REVIEW[pr.reviewDecision][0]}</span>` : "");

/** The open pull request for the checked-out branch, if any. */
const branchPr = () => state.prs?.find((p) => p.headRefName === state.status?.branch);

export async function loadPrs() {
  if (!state.root || state.prLoading) return;
  const root = state.root;
  state.prLoading = true;
  renderPrs();
  let list = null;
  let error = null;
  try {
    list = await invoke("pr_list");
  } catch (e) {
    error = String(e);
  }
  state.prLoading = false;
  if (root !== state.root) return loadPrs(); // switched project meanwhile
  state.prs = list;
  state.prError = error;
  state.prsAt = Date.now();
  renderPrs();
}

export function renderPrs() {
  const st = state.status;
  const form = state.prForm;
  $("#pr-count").textContent = state.prs?.length ? `(${state.prs.length})` : "";
  $("#pr-toolbar").hidden = !!form;
  $("#pr-list").hidden = !!form;
  $("#pr-form").hidden = !form;
  if (form) return renderPrForm();

  $("#pr-refresh").innerHTML = icon(state.prLoading ? "loader" : "refresh", state.prLoading ? "spin" : "");
  const mine = branchPr();
  const nb = $("#pr-new");
  nb.textContent = mine ? `View #${mine.number}` : "New Pull Request";
  nb.disabled = !mine && (!st?.branch || !st?.has_remote);
  nb.title = mine
    ? `${st.branch} already has an open pull request`
    : !st?.branch
      ? "Check out a branch first"
      : !st.has_remote
        ? "This repository has no remote"
        : `Open a pull request for ${st.branch}`;

  const list = $("#pr-list");
  if (state.prError) list.innerHTML = `<div class="empty error">${esc(state.prError)}</div>`;
  else if (!state.prs) list.innerHTML = `<div class="empty">${state.prLoading ? "Loading pull requests…" : ""}</div>`;
  else if (!state.prs.length) list.innerHTML = `<div class="empty">No open pull requests</div>`;
  else
    list.innerHTML = state.prs
      .map((p) => {
        const meta = [`${esc(p.headRefName)} → ${esc(p.baseRefName)}`, esc(p.author?.login ?? ""), ago(Date.parse(p.updatedAt) / 1000), reviewTag(p)];
        return `<div class="commit pr ${p.number === state.selectedPr ? "selected" : ""} ${p === mine ? "mine" : ""}" data-n="${p.number}">
        <div class="subject">${checkDot(checkSummary(p.statusCheckRollup))}<span class="num">#${p.number}</span>${esc(p.title)}${p.isDraft ? `<span class="tag-pill">Draft</span>` : ""}</div>
        <div class="meta">${meta.filter(Boolean).map((m) => `<span>${m}</span>`).join("")}</div>
      </div>`;
      })
      .join("");
}

export function selectPr(number) {
  state.selectedPr = number;
  document.querySelectorAll("#pr-list .pr").forEach((el) => el.classList.toggle("selected", +el.dataset.n === number));
  document.querySelector("#pr-list .pr.selected")?.scrollIntoView({ block: "nearest" });
  showPr(number);
}

$("#pr-list").addEventListener("click", (e) => {
  const row = e.target.closest(".pr");
  if (row) selectPr(+row.dataset.n);
});

$("#pr-list").addEventListener("keydown", (e) => {
  const list = state.prs ?? [];
  if (!list.length) return;
  const i = list.findIndex((p) => p.number === state.selectedPr);
  if (e.key === "ArrowDown" || e.key === "j") selectPr(list[Math.min(i + 1, list.length - 1)].number);
  else if (e.key === "ArrowUp" || e.key === "k") selectPr(list[Math.max(i - 1, 0)].number);
  else if (e.key === "Enter" && i >= 0) selectPr(list[i].number);
  else return;
  e.preventDefault();
});

$("#pr-refresh").onclick = loadPrs;

$("#pr-new").onclick = () => {
  const mine = branchPr();
  mine ? selectPr(mine.number) : openPrForm();
};
