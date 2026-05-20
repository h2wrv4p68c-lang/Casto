#!/bin/bash
# Build Casto.app from menubar.swift. Run on macOS (needs Xcode CLT + Node).
#   ./build-app.sh   then open Casto.app  (or drag it to /Applications)
set -euo pipefail
cd "$(dirname "$0")"

APP="Casto.app"
echo "› Compiling menubar.swift…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O menubar.swift -o "$APP/Contents/MacOS/Casto"

echo "› Assembling bundle…"
cp Info.plist "$APP/Contents/Info.plist"
# Node scripts the app drives, alongside it in Resources.
cp casto.js server.js "$APP/Contents/Resources/"

echo "› Building icon…"
iconutil -c icns Casto.iconset -o "$APP/Contents/Resources/AppIcon.icns"

echo "✓ Built $APP"
echo "  Run it:  open $APP"
echo "  Install: mv $APP /Applications/"
