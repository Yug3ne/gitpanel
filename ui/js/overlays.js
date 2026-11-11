// Things that float above the panel: toasts, context menus, confirm dialogs, the fuzzy picker.

import { $, esc, fuzzyScore } from "./util.js";
import { ICONS } from "./icons.js";

export function toast(text, error = false) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.textContent = text;
  if (error) el.title = "Click to dismiss";
  el.onclick = () => el.remove();
  $("#toasts").append(el);
  setTimeout(() => el.remove(), error ? 9000 : 3500);
}

export function openMenu(anchor, items, { x, y } = {}) {
  const menu = $("#menu");
  menu.innerHTML = "";
  for (const item of items) {
    if (item === "-") {
      menu.append(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.innerHTML = `<span class="ico">${item.checked ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${ICONS.check}</svg>` : ""}</span><span>${esc(item.label)}</span>${item.hint ? `<span class="spacer"></span><kbd>${esc(item.hint)}</kbd>` : ""}`;
    if (item.danger) b.classList.add("danger");
    b.disabled = !!item.disabled;
    b.onclick = () => {
      closeMenu();
      item.run();
    };
    menu.append(b);
  }
  menu.hidden = false;
  const mr = menu.getBoundingClientRect();
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.right - mr.width;
    y = r.bottom + 2;
    if (y + mr.height > innerHeight - 4) y = r.top - mr.height - 2;
  }
  menu.style.left = Math.max(4, Math.min(x, innerWidth - mr.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - mr.height - 4)) + "px";
}

export function closeMenu() {
  $("#menu").hidden = true;
}

document.addEventListener("mousedown", (e) => {
  if (!$("#menu").hidden && !e.target.closest("#menu")) closeMenu();
});

export function closeModal() {
  $("#modal-backdrop").hidden = true;
  $("#modal").innerHTML = "";
}

$("#modal-backdrop").addEventListener("mousedown", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

export function confirmDialog(text, { ok = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    modal.innerHTML = `<div class="modal-text">${esc(text)}</div>
      <div class="modal-actions"><button class="btn" data-r="0">Cancel</button><button class="btn primary ${danger ? "danger" : ""}" data-r="1">${esc(ok)}</button></div>`;
    $("#modal-backdrop").hidden = false;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    modal.querySelectorAll("button").forEach((b) => (b.onclick = () => done(b.dataset.r === "1")));
    modal.querySelector('[data-r="1"]').focus();
    modal.onkeydown = (e) => {
      if (e.key === "Escape") done(false);
    };
  });
}

/**
 * Filterable list in a modal. items: [{main, sub, current, ...}]. `load` may be a
 * promise of a fresh item list; the picker re-renders when it resolves.
 */
export function picker({ placeholder, items, load, onPick, onCreate }) {
  const modal = $("#modal");
  modal.innerHTML = `<input class="picker-input" placeholder="${esc(placeholder)}" /><div class="picker-list"></div>`;
  $("#modal-backdrop").hidden = false;
  const input = $("input", modal);
  const list = $(".picker-list", modal);
  let shown = [];
  let active = 0;
  let touched = false; // until the user moves/filters, skip past the current item
  const render = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    if (!q) shown = items.slice(0, 300);
    else {
      shown = items
        .map((i) => {
          // Matching the name counts for more than matching the path/subtitle.
          const a = fuzzyScore(q, i.main);
          const b = fuzzyScore(q, i.search ?? "");
          return { i, score: Math.max(a >= 0 ? a + 200 : -1, b) };
        })
        .filter((x) => x.score >= 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 300)
        .map((x) => x.i);
    }
    if (onCreate && raw && !items.some((i) => i.main.toLowerCase() === q)) {
      shown.push({ main: `Create branch "${raw}"`, sub: "", create: raw });
    }
    if (!touched && !q) active = Math.max(0, shown.findIndex((i) => !i.current));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown
          .map(
            (i, n) =>
              `<button class="picker-item ${n === active ? "active" : ""} ${i.current ? "current" : ""}" data-n="${n}"><span class="main">${esc(i.main)}</span><span class="sub">\u200e${esc(i.sub || "")}\u200e</span></button>`,
          )
          .join("")
      : `<div class="empty">No matches</div>`;
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };
  const choose = (n) => {
    const item = shown[n];
    if (!item) return;
    closeModal();
    item.create ? onCreate(item.create) : onPick(item);
  };
  input.oninput = () => {
    touched = true;
    active = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) active = Math.min(active + 1, shown.length - 1);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) active = Math.max(active - 1, 0);
    else if (e.key === "Enter") return choose(active);
    else if (e.key === "Escape") return closeModal();
    else return;
    touched = true;
    e.preventDefault();
    e.stopPropagation();
    render();
  };
  list.onclick = (e) => {
    const b = e.target.closest(".picker-item");
    if (b) choose(+b.dataset.n);
  };
  render();
  input.focus();
  load?.then((fresh) => {
    if (!fresh || !list.isConnected) return;
    items = fresh;
    render();
  });
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Clipboard unavailable", true);
  }
}
