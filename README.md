# gitpanel

Zed's git panel (Changes / History, stage checkboxes, commit box) as a
standalone desktop app. Tauri 2 + plain HTML/JS; every operation shells out
to your own `git`, so hooks, config, signing and credentials behave as usual.

Behaviour follows Zed's `crates/git_ui/src/git_panel.rs`:

- **Stage All / Unstage All** split button, with Stash All, Stash Pop, Discard
  Tracked Changes, and Trash Untracked Files.
- **Commit / Commit Tracked / Amend / Amend Tracked** labels, plus Amend,
  Signoff, and Skip Hooks toggles.
- Remote button picks **Fetch / Push ↑n / Pull ↓n / Publish / Republish**
  from ahead/behind state.
- **Uncommit** soft-resets HEAD and puts the message back in the editor. It
  asks for confirmation if the commit was already pushed.

## Build & run

    cargo build --release --manifest-path src-tauri/Cargo.toml
    src-tauri/target/release/gitpanel [path/to/repo]

The argument can be any folder inside a repo, or just a project name
(`gitpanel payd-web-app`), which is looked up among discovered repos. With no
argument it uses the current directory, else the last opened repo. Repo
discovery scans `$HOME` (5 levels deep, skipping hidden directories and
`node_modules`/`target`/…). Set `GITPANEL_ROOTS=~/Code:~/work` to scan
specific folders instead.

## Keys

| Key | Action |
| --- | --- |
| ↑/↓ or j/k | move selection |
| Space | stage / unstage file |
| Enter | open diff |
| Delete | discard file |
| Ctrl+Enter | commit |
| Ctrl+G | generate commit message with Claude (Haiku, via the `claude` CLI) |
| Ctrl+B | branch picker (type a new name to create it) |
| Ctrl+P | project switcher: every git repo under `$HOME`, most recently active first, fuzzy search |
| Ctrl+O | open any folder |
| Ctrl+1 / Ctrl+2 | Changes / History |
| Ctrl+R | refresh |
| Esc | close diff / menu |

Right-click a file for Stage, Open Diff, Copy Path, and Discard.

## Hyprland

Hyprland tiles new windows by default. This rule (in `~/.config/hypr/hyprland.lua`)
makes gitpanel float, centred and fully opaque, 620 px wide and 88% of the
height of whichever monitor it opens on:

    o.window("^(gitpanel)$", { float = true, center = true, size = { 620, "(monitor_h*0.88)" }, tag = "-default-opacity" })

(`persistent_size` would remember a manual resize, but only as one size
shared by all monitors, so a size that suits the external screen overflows the
laptop screen.)

`SUPER + CTRL + G` (in `~/.config/hypr/bindings.lua`) runs `gitpanel-here`,
which opens gitpanel on the focused window's project: Zed's project (from its
window title) or a terminal's working directory. If gitpanel is already open,
it switches that window to the project and focuses it.

## Install

    ./install.sh   # ~/.local/bin/gitpanel + app launcher entry + icon

## UI development

`ui/` is embedded into the binary at build time. To iterate on it in a
browser against a real repo, using the same Rust git backend:

    cargo run --release --manifest-path src-tauri/Cargo.toml --example dev_server -- /path/to/repo
    # open http://localhost:1420, then reload after editing ui/*

## Credits

Behaviour and labels are modelled on [Zed](https://github.com/zed-industries/zed)'s
git panel (`crates/git_ui`). No Zed code is included.

## License

[MIT](LICENSE)
