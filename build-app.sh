#!/bin/bash
# Build a self-contained, signed Casto.app (macOS, Apple Silicon).
#
# Plain build (ad-hoc signed, fine for your own Mac / right-click-Open):
#   ./build-app.sh
#
# Signed + notarized build (zero Gatekeeper warnings for Misti):
#   1) One-time: store notarization creds in the keychain:
#        xcrun notarytool store-credentials casto-notary \
#          --apple-id you@example.com --team-id TEAMID --password <app-specific-pw>
#   2) Build:
#        SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
#        NOTARY_PROFILE=casto-notary ./build-app.sh
#
# Result: Casto.app (and Casto.zip to AirDrop). She drags it to /Applications.
set -euo pipefail
cd "$(dirname "$0")"

APP="Casto.app"
RES="$APP/Contents/Resources"
SIGN_ID="${SIGN_ID:-}"            # Developer ID Application identity, or empty for ad-hoc
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

echo "› Compiling menubar.swift (arm64)…"
rm -rf "$APP" Casto.zip
mkdir -p "$APP/Contents/MacOS" "$RES"
swiftc -O -target arm64-apple-macos11 menubar.swift -o "$APP/Contents/MacOS/Casto"

echo "› Assembling bundle…"
cp Info.plist "$APP/Contents/Info.plist"
cp casto.js server.js "$RES/"

echo "› Bundling Node so nothing need be preinstalled…"
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
cp "$NODE_BIN" "$RES/node"
chmod +x "$RES/node"

echo "› Building icon…"
iconutil -c icns Casto.iconset -o "$RES/AppIcon.icns"

if [[ -n "$SIGN_ID" ]]; then
  echo "› Signing with Developer ID (hardened runtime)…"
  # Sign inside-out: bundled node first, then the app.
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$RES/node"
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$APP/Contents/MacOS/Casto"
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"

  /usr/bin/ditto -c -k --keepParent "$APP" Casto.zip
  if [[ -n "$NOTARY_PROFILE" ]]; then
    echo "› Notarizing (this can take a few minutes)…"
    xcrun notarytool submit Casto.zip --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    /usr/bin/ditto -c -k --keepParent "$APP" Casto.zip   # re-zip the stapled app
    echo "✓ Notarized + stapled."
  else
    echo "⚠ Signed but NOT notarized (set NOTARY_PROFILE to notarize)."
  fi
else
  echo "› Ad-hoc signing (no Developer ID provided)…"
  codesign --force -s - "$RES/node"
  codesign --force -s - "$APP"
  /usr/bin/ditto -c -k --keepParent "$APP" Casto.zip
  echo "⚠ Ad-hoc only: first open needs right-click → Open."
fi

echo "✓ Built $APP  (+ Casto.zip to share)"
echo "  Install: move to /Applications, then open."
