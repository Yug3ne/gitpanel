// History tab: the commit log.

import { $, esc } from "./util.js";
import { git } from "./api.js";
import { state } from "./state.js";
import { showCommitDiff } from "./diff.js";

let loadingCommits = false;

export async function loadCommits(reset = false) {
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
