#!/usr/bin/env bash
# Build gitpanel and install it for the current user (binary, icon, launcher entry).
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --manifest-path src-tauri/Cargo.toml
install -Dm755 src-tauri/target/release/gitpanel "$HOME/.local/bin/gitpanel"
install -Dm755 scripts/gitpanel-here "$HOME/.local/bin/gitpanel-here"
install -Dm644 src-tauri/icons/icon.png "$HOME/.local/share/icons/hicolor/256x256/apps/gitpanel.png"
install -Dm644 /dev/stdin "$HOME/.local/share/applications/gitpanel.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Git Panel
GenericName=Git Commit Panel
Comment=Stage, commit and push — Zed's git panel as a standalone app
Exec=$HOME/.local/bin/gitpanel %f
Icon=gitpanel
Terminal=false
Categories=Development;RevisionControl;
Keywords=git;commit;stage;diff;
StartupWMClass=gitpanel
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "Installed: $HOME/.local/bin/gitpanel"
