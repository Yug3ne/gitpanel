// Switching between the Changes / History / Pull Requests tabs.

import { $ } from "./util.js";
import { state } from "./state.js";
import { loadCommits } from "./history.js";
import { loadPrs } from "./pr-list.js";

export function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("#changes-view").hidden = tab !== "changes";
  $("#history-view").hidden = tab !== "history";
  $("#prs-view").hidden = tab !== "prs";
  $("#panel").classList.toggle("tab-prs", tab === "prs");
  if (tab === "history" && !state.commits.length) loadCommits(true);
  if (tab === "prs" && !state.prForm && Date.now() - state.prsAt > 15_000) loadPrs();
  focusList();
}

export function focusList() {
  if (state.tab === "prs" && state.prForm) return $("#pr-title").focus();
  $({ changes: "#file-list", history: "#commit-list", prs: "#pr-list" }[state.tab]).focus();
}

document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => setTab(t.dataset.tab)));
