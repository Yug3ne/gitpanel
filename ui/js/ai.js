// Which Claude model writes commit messages and pull requests.

import { store } from "./util.js";
import { openMenu } from "./overlays.js";
import { renderFooter } from "./commit.js";
import { renderPrs } from "./pr-list.js";

// Which of the user's Claude models writes commit messages and pull requests.
const MODELS = [
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
];

export const aiModel = () => (MODELS.some(([id]) => id === store.get("aiModel")) ? store.get("aiModel") : "sonnet");

export const modelName = () => MODELS.find(([id]) => id === aiModel())[1];

export function modelMenu(e) {
  e.preventDefault();
  openMenu(
    null,
    MODELS.map(([id, label]) => ({
      label: `Generate with ${label}`,
      checked: id === aiModel(),
      run: () => {
        store.set("aiModel", id);
        renderFooter();
        renderPrs();
      },
    })),
    { x: e.clientX, y: e.clientY },
  );
}
