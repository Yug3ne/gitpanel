// Pull Requests tab: the New Pull Request form.

import { $, store } from "./util.js";
import { invoke, op, git } from "./api.js";
import { icon } from "./icons.js";
import { state } from "./state.js";
import { toast } from "./overlays.js";
import { refresh } from "./changes.js";
import { aiModel, modelName, modelMenu } from "./ai.js";
import { focusList } from "./tabs.js";
import { loadPrs, renderPrs, selectPr } from "./pr-list.js";

$("#pr-generate").oncontextmenu = modelMenu;

const prDraftKey = () => `prDraft:${state.root}:${state.prForm.branch}`;

function savePrDraft() {
  if (state.prForm) store.set(prDraftKey(), { title: $("#pr-title").value, body: $("#pr-body").value });
}

export async function openPrForm() {
  const ctx = await git("pr_context", { base: null }).catch(() => null);
  if (!ctx) return;
  state.prForm = ctx;
  const draft = store.get(prDraftKey(), {});
  $("#pr-base").value = ctx.base;
  // A single commit is its own best title, the way GitHub prefills it.
  $("#pr-title").value = draft.title ?? (ctx.commits.length === 1 ? ctx.commits[0] : "");
  $("#pr-body").value = draft.body ?? "";
  renderPrs();
  $("#pr-title").focus();
}

function closePrForm() {
  state.prForm = null;
  renderPrs();
  focusList();
}

/** [enabled, tooltip] for the Create button. */
function prCreateEnabled() {
  const f = state.prForm;
  if (state.prBusy) return [false, "Working…"];
  if (f.branch === f.base) return [false, `${f.branch} is the base branch. Switch to another branch first.`];
  if (!f.commits.length) return [false, `${f.branch} has no commits that ${f.base} doesn't`];
  if (!$("#pr-title").value.trim()) return [false, "No title"];
  return [true, "Ctrl Enter"];
}

export function renderPrForm() {
  const f = state.prForm;
  const busy = state.prBusy;
  $("#pr-head").textContent = f.branch;
  $("#pr-head").title = f.branch;
  const n = f.commits.length;
  $("#pr-note").textContent =
    f.branch === f.base
      ? `${f.branch} is the base branch. Switch to another branch (Ctrl B) to open a pull request.`
      : !n
        ? `No commits on ${f.branch} that aren't already on ${f.base}.`
        : `${n} commit${n > 1 ? "s" : ""}${f.needs_push ? " · the branch will be pushed first" : ""}\n` + f.commits.map((c) => `• ${c}`).join("\n");
  const [enabled, tip] = prCreateEnabled();
  const create = $("#pr-create");
  create.disabled = !enabled;
  create.title = tip;
  create.textContent = busy === "create" ? "Creating…" : f.needs_push && n ? "Push & Create Pull Request" : "Create Pull Request";
  const gen = $("#pr-generate");
  gen.disabled = !!busy || !n;
  gen.innerHTML = icon(busy === "generate" ? "loader" : "sparkle", busy === "generate" ? "spin" : "");
  gen.title = `Generate title and description with Claude ${modelName()} (Ctrl G)\nRight-click to change model`;
  for (const id of ["#pr-title", "#pr-body", "#pr-base"]) $(id).readOnly = !!busy;
  $("#pr-cancel").disabled = busy === "create";
}

for (const id of ["#pr-title", "#pr-body"]) {
  $(id).addEventListener("input", () => {
    renderPrForm();
    clearTimeout(savePrDraft._t);
    savePrDraft._t = setTimeout(savePrDraft, 400);
  });
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      createPr();
    } else if (e.key === "Enter" && id === "#pr-title") {
      e.preventDefault();
      $("#pr-body").focus();
    }
  });
}

$("#pr-base").addEventListener("change", async (e) => {
  const base = e.target.value.trim();
  const f = state.prForm;
  if (!f) return;
  const ctx = base && (await git("pr_context", { base }).catch(() => null));
  if (state.prForm !== f) return;
  if (ctx) state.prForm = ctx;
  else e.target.value = f.base; // unknown branch: keep the previous base
  renderPrForm();
});

$("#pr-base").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});

$("#pr-cancel").onclick = () => {
  savePrDraft();
  closePrForm();
};

export async function generatePr() {
  const f = state.prForm;
  if (!f || state.prBusy || !f.commits.length) return;
  state.prBusy = "generate";
  renderPrForm();
  try {
    const draft = await invoke("generate_pr", { base: f.base, model: aiModel() });
    if (state.prForm === f) {
      $("#pr-title").value = draft.title;
      $("#pr-body").value = draft.body;
      savePrDraft();
    }
  } catch (e) {
    toast(String(e), true);
  } finally {
    state.prBusy = null;
    if (state.prForm) {
      renderPrForm();
      $("#pr-title").focus();
    }
  }
}

$("#pr-generate").onclick = generatePr;

async function createPr() {
  const f = state.prForm;
  if (!f || !prCreateEnabled()[0]) return;
  const args = { title: $("#pr-title").value, body: $("#pr-body").value, base: f.base, draft: $("#pr-draft").checked };
  state.prBusy = "create";
  renderPrForm();
  let url;
  try {
    // Queued with the other git operations: it may push the branch.
    url = await op(() => git("pr_create", args));
  } catch {
    // already toasted
  }
  state.prBusy = null;
  if (!url) {
    if (state.prForm) renderPrForm();
    return refresh();
  }
  toast(`Pull request created\n${url}`);
  if (state.prForm === f) {
    localStorage.removeItem(prDraftKey());
    state.prForm = null;
  }
  refresh();
  await loadPrs();
  const created = state.prs?.find((p) => p.url === url);
  if (created) selectPr(created.number);
  else focusList();
}

$("#pr-create").onclick = createPr;
