#!/usr/bin/env bash
# Instala o painel de widgets: lançador no menu, início automático e atalho Super+W.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CMD="python3 $DIR/widgets.py"
KEY="${1:-<Super>w}"

mkdir -p ~/.local/share/applications ~/.config/autostart
cat > ~/.local/share/applications/mac-widgets.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Painel de Widgets
Comment=Painel de widgets estilo macOS
Exec=$CMD
Icon=preferences-desktop-apps
Categories=Utility;
StartupNotify=false
EOF

cp "$DIR/mac-widgets-settings.desktop" ~/.local/share/applications/
sed -i "s|^Exec=.*|Exec=$CMD --settings|" ~/.local/share/applications/mac-widgets-settings.desktop

cat > ~/.config/autostart/mac-widgets.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Painel de Widgets
Exec=$CMD --hidden
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF

# atalho de teclado (GNOME)
BASE=org.gnome.settings-daemon.plugins.media-keys
PATH_KB=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/mac-widgets/
LIST=$(gsettings get $BASE custom-keybindings)
if [[ "$LIST" != *"$PATH_KB"* ]]; then
  if [[ "$LIST" == "@as []" || "$LIST" == "[]" ]]; then NEW="['$PATH_KB']"
  else NEW="${LIST%]}, '$PATH_KB']"; fi
  gsettings set $BASE custom-keybindings "$NEW"
fi
S="$BASE.custom-keybinding:$PATH_KB"
gsettings set "$S" name "Widgets"
gsettings set "$S" command "$CMD"
gsettings set "$S" binding "$KEY"

echo "Instalado. Atalho: $KEY  |  Menu: Widgets  |  Inicia oculto no login."
