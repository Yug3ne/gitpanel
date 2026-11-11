// The diff pane on the right: file, working-tree and commit diffs.

import { $, esc } from "./util.js";
import { invoke } from "./api.js";
import { state, fileByPath } from "./state.js";
import { focusList } from "./tabs.js";

/** Keep an open working-tree diff in sync with the latest status. */
export function reloadDiff() {
  const d = state.diff;
  if (d?.kind === "all") showAllDiff({ keepScroll: true });
  if (d?.kind !== "file") return;
  const f = fileByPath(d.path);
  if (f) showFileDiff(f, { keepScroll: true });
  else showDiff("file", d.path, async () => "", { keepScroll: false });
}

// Every load into the pane takes a number; a load that finishes after a newer
// one started is stale and must not touch the pane.
let diffSeq = 0;
export const beginDiffLoad = () => ++diffSeq;
export const isStale = (seq) => seq !== diffSeq;

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

export function showFileDiff(f, opts) {
  state.diff = { kind: "file", path: f.path };
  showDiff("file", f.path, () => invoke("diff_file", { path: f.path, untracked: f.section === "untracked" }), opts);
}

export function showAllDiff(opts) {
  state.diff = { kind: "all" };
  showDiff("all", "Uncommitted Changes", () => invoke("diff_all"), opts);
}

export function showCommitDiff(c) {
  if (!c) return;
  state.diff = { kind: "commit", hash: c.hash };
  showDiff("commit", `${c.short} ${c.subject}`, () => invoke("show_commit", { hash: c.hash }));
}

export function closeDiff() {
  state.diff = null;
  diffSeq++;
  $("#app").classList.remove("with-diff");
  $("#diff-pane").hidden = true;
  $("#diff-body").innerHTML = "";
  $("#diff-body")._html = null;
}

$("#diff-close").onclick = () => {
  closeDiff();
  focusList();
};

export function renderDiff(text) {
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
