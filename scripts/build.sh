#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/build/OpenCode Menu Bar.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -framework AppKit "$ROOT/Sources/main.swift" -o "$APP/Contents/MacOS/OpenCodeMenuBar"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
