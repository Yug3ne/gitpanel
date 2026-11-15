// The one shared state object, plus read-only helpers over the current git status.

export const SECTIONS = [
  ["conflict", "Conflicts"],
  ["tracked", "Tracked"],
  ["untracked", "Untracked"],
];

export const state = {
  root: null,
  status: null,
  statusKey: "",
  selected: null, // path of selected file
  collapsed: new Set(),
  tab: "changes",
  amend: false,
  amendStash: "", // message that was in the editor before toggling amend
  signoff: false,
  skipHooks: false,
  remoteOp: null,
  committing: false,
  generating: false,
  commits: [],
  commitsDone: false,
  selectedCommit: null,
  diff: null, // { kind: 'file'|'all'|'commit'|'pr', path?, untracked?, hash?, number? }
  prs: null, // open pull requests, null until loaded
  prsAt: 0,
  prError: null,
  prLoading: false,
  prForm: null, // { branch, base, commits, needs_push } while the New Pull Request form is open
  prBusy: null, // 'create' | 'generate' | 'merge' | ...
  pr: null, // the pull request shown in the diff pane
  selectedPr: null,
};

export const files = () => state.status?.files ?? [];

export const staged = (f) => f.staged !== "none";

export const hasStaged = () => files().some(staged);

export const hasUnstaged = () => files().some((f) => f.staged !== "full");

export const tracked = () => files().filter((f) => f.section === "tracked");

export const untracked = () => files().filter((f) => f.section === "untracked");

export const conflicts = () => files().filter((f) => f.section === "conflict");

/** Files in display order (respecting collapsed sections). */
export function visibleFiles() {
  return SECTIONS.flatMap(([key]) => (state.collapsed.has(key) ? [] : files().filter((f) => f.section === key)));
}

export const fileByPath = (p) => files().find((f) => f.path === p);
