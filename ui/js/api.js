// Calls into the Rust backend (src-tauri/src/main.rs).

import { toast } from "./overlays.js";

export const invoke = window.__TAURI__.core.invoke;

// All mutating git calls run one at a time so we never race on index.lock.
let queue = Promise.resolve();

export let pending = 0;

export function op(fn) {
  pending++;
  const run = queue.then(fn).finally(() => pending--);
  queue = run.catch(() => {});
  return run;
}

export async function git(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}
