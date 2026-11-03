#!/bin/bash
# Builds src/voice/voice-mac (macOS voice input, see src/voice.js) from
# voice-mac.swift: one binary for Apple Silicon and Intel Macs, macOS 12 or
# later, with an Info.plist inside it, signed for any Mac (ad hoc). The binary
# is in the repository, so only run this after changing the Swift file.
set -euo pipefail
cd "$(dirname "$0")/../src/voice"
TMP="$(mktemp -d)"
cat > "$TMP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.agentdeck.voice</string>
  <key>CFBundleName</key><string>Agent Hub Voice</string>
  <key>NSMicrophoneUsageDescription</key><string>Agent Hub listens while you speak a message to an agent.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Agent Hub turns what you say into the text of your message.</string>
</dict></plist>
PLIST
# Some Command Line Tools have the SwiftBridging module twice (module.modulemap
# and bridging.modulemap), which stops every build; this hides one of them.
: > "$TMP/empty.modulemap"
INC="$(dirname "$(dirname "$(xcrun -f swiftc)")")/include/swift"
cat > "$TMP/overlay.yaml" <<YAML
{ "version": 0, "roots": [ { "name": "$INC", "type": "directory", "contents": [ { "name": "module.modulemap", "type": "file", "external-contents": "$TMP/empty.modulemap" } ] } ] }
YAML
OVERLAY=()
if [ -f "$INC/module.modulemap" ] && [ -f "$INC/bridging.modulemap" ]; then
  OVERLAY=(-vfsoverlay "$TMP/overlay.yaml" -Xcc -ivfsoverlay -Xcc "$TMP/overlay.yaml")
fi
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" ${OVERLAY[@]+"${OVERLAY[@]}"} voice-mac.swift -o "$TMP/voice-$arch" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$TMP/Info.plist"
done
lipo -create "$TMP/voice-arm64" "$TMP/voice-x86_64" -output voice-mac
codesign --force --sign - --identifier com.agentdeck.voice voice-mac
rm -rf "$TMP"
echo "Built src/voice/voice-mac"
