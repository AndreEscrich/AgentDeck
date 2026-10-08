#!/bin/bash
# Builds ~/Applications/AgentDeck.app and puts a link to it on the Desktop.
#
# The app is a copy of Electron with AgentDeck's name and icon. Its
# Resources/app folder is a link back to this project folder, so the app
# always runs the current code: after you change the code, quit and reopen
# the app. Run this script again only after `npm install` updates Electron
# or after you change the icon.
#
# Run: npm run make-app

set -euo pipefail

PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/AgentDeck.app"
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
ICONSET="$(mktemp -d)/AgentDeck.iconset"
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

# 3. Give it AgentDeck's name, bundle id and icon.
/usr/libexec/PlistBuddy -c "Set :CFBundleName AgentDeck" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName AgentDeck" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string AgentDeck" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.agentdeck.app" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile AgentDeck.icns" "$PLIST"
cp "$PROJECT/build/icon.icns" "$APP/Contents/Resources/AgentDeck.icns"

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
ln -sfn "$APP" "$HOME/Desktop/AgentDeck.app"

echo "Built $APP"
echo "Linked $HOME/Desktop/AgentDeck.app"
