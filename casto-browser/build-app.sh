#!/bin/bash
# Build CastoBrowser.app (macOS, Apple Silicon). Packaging is what registers
# the casto:// URL scheme with macOS — `swift run` alone can't do that.
#
#   ./build-app.sh                  # ad-hoc signed (right-click → Open first time)
#   SIGN_ID="Developer ID Application: Name (TEAMID)" \
#   NOTARY_PROFILE=casto-notary ./build-app.sh   # signed + notarized
#
# After building, move CastoBrowser.app to /Applications and open it once so
# LaunchServices registers the scheme. Then:  open "casto://open?url=apple.com"
set -euo pipefail
cd "$(dirname "$0")"

APP="CastoBrowser.app"
RES="$APP/Contents/Resources"
SIGN_ID="${SIGN_ID:-}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"

echo "› swift build -c release…"
swift build -c release
BIN=".build/release/CastoBrowser"

echo "› Assembling bundle…"
rm -rf "$APP" CastoBrowser.zip
mkdir -p "$APP/Contents/MacOS" "$RES"
cp "$BIN" "$APP/Contents/MacOS/CastoBrowser"
cp Info.plist "$APP/Contents/Info.plist"

# Bundle the caster so casting works from the installed app.
if [[ -f ../casto.js ]]; then cp ../casto.js "$RES/"; fi
echo "› Bundling Node…"
NODE_BIN="$(node -e 'process.stdout.write(process.execPath)')"
cp "$NODE_BIN" "$RES/node"; chmod +x "$RES/node"

# Reuse the wood app icon if present in the repo root.
if [[ -d ../Casto.iconset ]]; then
  iconutil -c icns ../Casto.iconset -o "$RES/AppIcon.icns"
fi

if [[ -n "$SIGN_ID" ]]; then
  echo "› Signing with Developer ID…"
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$RES/node"
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$APP/Contents/MacOS/CastoBrowser"
  codesign --force --options runtime --timestamp -s "$SIGN_ID" "$APP"
  /usr/bin/ditto -c -k --keepParent "$APP" CastoBrowser.zip
  if [[ -n "$NOTARY_PROFILE" ]]; then
    echo "› Notarizing…"
    xcrun notarytool submit CastoBrowser.zip --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    /usr/bin/ditto -c -k --keepParent "$APP" CastoBrowser.zip
  fi
else
  echo "› Ad-hoc signing…"
  codesign --force -s - "$RES/node"
  codesign --force -s - "$APP"
fi

echo "✓ Built $APP"
echo "  Move to /Applications and open once to register the casto:// scheme."
