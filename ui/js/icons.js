// Inline SVG icons, file status badges and checkboxes.

export const ICONS = {
  "chevron-down": '<path d="m4 6 4 4 4-4"/>',
  "chevron-right": '<path d="m6 4 4 4-4 4"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
  undo: '<path d="M5 3 2 6l3 3"/><path d="M2 6h7.5a4 4 0 0 1 0 8H7"/>',
  diff: '<path d="M8 2v6M5 5h6M5 12h6"/>',
  x: '<path d="m4 4 8 8M12 4l-8 8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7" stroke-width="2"/>',
  dash: '<path d="M4 8h8" stroke-width="2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5V5h-2.5"/>',
  "arrow-up": '<path d="M8 13V3M4 7l4-4 4 4"/>',
  "arrow-down": '<path d="M8 3v10M4 9l4 4 4-4"/>',
  upload: '<path d="M8 11V3M5 6l3-3 3 3M3 13h10"/>',
  loader: '<path d="M8 2a6 6 0 1 0 6 6"/>',
  sparkle: '<path d="M7 1.5 8.3 5.2 12 6.5 8.3 7.8 7 11.5 5.7 7.8 2 6.5 5.7 5.2Z"/><path d="M12.5 10v4M10.5 12h4"/>',
  folder: '<path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3A1 1 0 0 0 2 4.5Z"/>',
};

export const icon = (name, cls = "") =>
  `<span class="ico ${cls}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg></span>`;

export function statusIcon(f) {
  // Zed-style: rounded square with a glyph describing the change.
  let kind = f.section === "conflict" ? "C" : f.section === "untracked" ? "U" : null;
  if (!kind) {
    const code = f.x !== "." ? f.x : f.y;
    kind = code === "A" ? "A" : code === "D" ? "D" : code === "R" || code === "C" ? "R" : "M";
  }
  const glyph = {
    M: '<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
    A: '<path d="M8 5v6M5 8h6"/>',
    U: '<path d="M8 5v6M5 8h6"/>',
    D: '<path d="M5 8h6"/>',
    R: '<path d="M5 8h6M8.5 5.5 11 8l-2.5 2.5"/>',
    C: '<path d="M8 4.8v4"/><circle cx="8" cy="11.2" r=".6" fill="currentColor"/>',
  }[kind];
  return `<svg class="status-icon st-${kind}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5"/>${glyph}</svg>`;
}

export function checkbox(state) {
  const cls = state === "full" ? "on" : state === "partial" ? "mixed" : "";
  const glyph = state === "full" ? ICONS.check : state === "partial" ? ICONS.dash : "";
  return `<span class="check ${cls}" role="checkbox"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></span>`;
}

document.querySelectorAll("[data-icon]").forEach((el) => (el.outerHTML = icon(el.dataset.icon)));
