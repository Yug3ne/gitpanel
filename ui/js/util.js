// Small helpers with no app knowledge: DOM lookup, escaping, storage, formatting.

export const $ = (sel, root = document) => root.querySelector(sel);

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

/** Subsequence match score (higher is better), or -1 when `q` doesn't match. */
export function fuzzyScore(q, text) {
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub !== -1) return 1000 - sub * 2 - t.length / 100 + (sub === 0 ? 500 : 0);
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (const ch of q) {
    const k = t.indexOf(ch, pos);
    if (k === -1) return -1;
    score += k === prev + 1 ? 8 : 1;
    prev = k;
    pos = k + 1;
  }
  return score;
}

export const tilde = (p) => p.replace(/^\/home\/[^/]+/, "~");

export function ago(secs) {
  if (!secs) return "";
  const d = Date.now() / 1000 - secs;
  if (d < 90) return "just now";
  for (const [n, unit] of [[86400 * 365, "y"], [86400 * 30, "mo"], [86400 * 7, "w"], [86400, "d"], [3600, "h"], [60, "m"]]) {
    if (d >= n) return `${Math.floor(d / n)}${unit} ago`;
  }
  return "";
}
