#!/bin/bash
# Builds ~/Applications/Agent Hub.app and puts a link to it on the Desktop.
#
# The app is a copy of Electron with Agent Hub's name and icon. Its
# Resources/app folder is a link back to this project folder, so the app
# always runs the current code: after you change the code, quit and reopen
# the app. Run this script again only after `npm install` updates Electron
# or after you change the icon.
#
# Run: npm run make-app

set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Agent Hub.app"
# The app was called AgentDeck before; its old copy and Desktop link are removed.
OLD_APP="$HOME/Applications/AgentDeck.app"
ELECTRON_APP="$PROJECT/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"

# The app should run the stable copy (the folder on master), not the folder
# where you make changes. Pass --force to build from another branch anyway.
BRANCH="$(git -C "$PROJECT" branch --show-current 2>/dev/null || true)"
if [ "$BRANCH" != "master" ] && [ "${1:-}" != "--force" ]; then
  echo "This folder is on the '$BRANCH' branch. Build the app from the stable copy (the folder on master)," >&2
  echo "or run: npm run make-app -- --force" >&2
  exit 1
fi

if [ ! -d "$ELECTRON_APP" ]; then
  echo "Electron is not installed. Run npm install first." >&2
  exit 1
fi

# 1. Turn build/icon.png into a macOS .icns file with all the sizes Finder uses.
ICONSET="$(mktemp -d)/AgentHub.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$PROJECT/build/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$PROJECT/build/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$PROJECT/build/icon.icns"

# 2. Copy Electron.app. On APFS, `cp -c` makes a clone that takes no extra disk space.
mkdir -p "$HOME/Applications"
rm -rf "$APP"
cp -cR "$ELECTRON_APP" "$APP" 2>/dev/null || cp -R "$ELECTRON_APP" "$APP"

# 3. Give it Agent Hub's name and icon. The bundle id keeps the old name, so
#    macOS treats the renamed app as the same app (notification permission).
/usr/libexec/PlistBuddy -c "Set :CFBundleName Agent Hub" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Agent Hub" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Agent Hub" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.agentdeck.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AgentHub.icns" "$PLIST"
cp "$PROJECT/build/icon.icns" "$APP/Contents/Resources/AgentHub.icns"

# 4. Electron loads Resources/app when it exists. Point it at this project.
rm -f "$APP/Contents/Resources/default_app.asar"
ln -s "$PROJECT" "$APP/Contents/Resources/app"

# 5. Changing Info.plist breaks Electron's signature, and Apple Silicon Macs
#    refuse to run unsigned apps, so we sign it again for this Mac only.
codesign --force --deep --sign - "$APP" 2>/dev/null

# 6. Make Finder and the Dock notice the new icon.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true

# 7. A link on the Desktop.
ln -sfn "$APP" "$HOME/Desktop/Agent Hub.app"

# 8. Remove the copy and the Desktop link from when the app was called AgentDeck.
if [ -L "$OLD_APP/Contents/Resources/app" ]; then rm -rf "$OLD_APP"; fi
if [ -L "$HOME/Desktop/AgentDeck.app" ]; then rm -f "$HOME/Desktop/AgentDeck.app"; fi

echo "Built $APP"
echo "Linked $HOME/Desktop/Agent Hub.app"
