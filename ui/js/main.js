// Entry point: loads every module, then wires split-button menus, global shortcuts, polling and boot.

import { $, store } from "./util.js";
import { invoke, pending } from "./api.js";
import { state } from "./state.js";
import { openMenu, closeMenu, closeModal } from "./overlays.js";
import { renderWelcome, openRepo, pickRepo, repoSwitcher, openTarget } from "./repo.js";
import { refresh, stageMenuItems } from "./changes.js";
import { renderFooter, msg, generateMessage, toggleAmend } from "./commit.js";
import { remote, branchPicker } from "./remote.js";
import { setTab } from "./tabs.js";
import { loadPrs } from "./pr-list.js";
import { generatePr } from "./pr-form.js";
import "./icons.js";
import "./ai.js";
import "./history.js";
import "./diff.js";
import "./pr-detail.js";

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
  else if (k === "3") setTab("prs");
  else if (k === "g" && state.root && state.tab === "prs") state.prForm && generatePr();
  else if (k === "m" && state.root) msg.focus();
  else if (k === "g" && state.root) generateMessage();
  else return;
  e.preventDefault();
});

window.addEventListener("focus", () => {
  refresh();
  if (state.tab === "prs" && !state.prForm && Date.now() - state.prsAt > 30_000) loadPrs();
});

let lastPoll = 0;

setInterval(() => {
  // Poll fast while focused, slowly in the background; skip while git is busy.
  const interval = document.hasFocus() ? 2000 : 10000;
  if (pending || state.committing || Date.now() - lastPoll < interval) return;
  lastPoll = Date.now();
  refresh();
}, 1000);

(async () => {
  const launch = await invoke("launch_path");
  if (launch && (await openTarget(launch))) return;
  const last = store.get("lastRepo", null);
  if (last && (await openRepo(last, { quiet: true }))) return;
  renderWelcome();
})();
