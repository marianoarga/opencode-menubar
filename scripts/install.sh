#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/OpenCode Menu Bar.app"
PLUGIN="$HOME/.config/opencode/plugins/opencode-menubar.js"
SUPPORT="$HOME/Library/Application Support/OpenCode Menu Bar"
AGENT="$HOME/Library/LaunchAgents/local.opencode.menubar.plist"
DOMAIN="gui/$(id -u)"
bash "$ROOT/scripts/build.sh"
if [[ -e "$PLUGIN" ]] && ! cmp -s "$ROOT/plugin/opencode-menubar.js" "$PLUGIN"; then
    cp "$PLUGIN" "$PLUGIN.backup-$(date +%Y%m%d%H%M%S)"
fi
mkdir -p "$HOME/Applications" "$(dirname "$PLUGIN")" "$SUPPORT/states" "$(dirname "$AGENT")"
chmod 700 "$SUPPORT" "$SUPPORT/states"
launchctl bootout "$DOMAIN/local.opencode.menubar" 2>/dev/null || true
ditto "$ROOT/build/OpenCode Menu Bar.app" "$APP"
cp "$ROOT/plugin/opencode-menubar.js" "$PLUGIN"
# plistlib escapes home-directory characters and writes a valid launchd plist.
python3 - "$APP" "$AGENT" "$SUPPORT" <<'PY'
import plistlib, sys
app, agent, support = sys.argv[1:]
with open(agent, "wb") as handle:
    plistlib.dump({
        "Label": "local.opencode.menubar",
        "ProgramArguments": [app + "/Contents/MacOS/OpenCodeMenuBar"],
        "RunAtLoad": True,
        "ProcessType": "Interactive",
        "LimitLoadToSessionType": "Aqua",
        "StandardOutPath": support + "/app.log",
        "StandardErrorPath": support + "/app-error.log",
    }, handle)
PY
plutil -lint "$AGENT"
launchctl bootstrap "$DOMAIN" "$AGENT"
