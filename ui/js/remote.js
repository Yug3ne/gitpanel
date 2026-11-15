// Fetch / pull / push and the branch picker (Ctrl B).

import { $ } from "./util.js";
import { invoke, op, git } from "./api.js";
import { state } from "./state.js";
import { toast, confirmDialog, picker } from "./overlays.js";
import { refresh } from "./changes.js";
import { renderFooter } from "./commit.js";
import { loadCommits } from "./history.js";

export async function remote(opName) {
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

export async function branchPicker() {
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
