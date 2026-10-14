#!/bin/bash
# Builds "Local Excalidraw.app" (Apple silicon) with the lfx runtime bundled inside it.
#
#   macos/build-app.sh             build into build/
#   macos/build-app.sh --install   ...and copy it to /Applications
#   macos/build-app.sh --release   ...and zip it, then update Casks/local-first-excalidraw.rb
#
# Signing: ad-hoc by default. Set SIGN_IDENTITY="Developer ID Application: …" for a real signature,
# and NOTARY_PROFILE=<notarytool keychain profile> to notarize and staple (needed for Gatekeeper on
# machines that download the release).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
version=$(node -p 'require("./package.json").version')
app="build/Local Excalidraw.app"
contents="$app/Contents"

install=0 release=0
for a in "$@"; do
  case "$a" in
    --install) install=1 ;;
    --release) release=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

echo "==> Building the lfx runtime"
[ -d node_modules ] || npm ci
npm run build

echo "==> Building the native app"
swift build -c release --package-path macos --arch arm64
bin=$(swift build -c release --package-path macos --arch arm64 --show-bin-path)

echo "==> Assembling $app"
rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources/bin" "$contents/Resources/lfx/dist"
cp "$bin/LocalExcalidraw" "$contents/MacOS/"
sed "s/__VERSION__/$version/g" macos/Resources/Info.plist > "$contents/Info.plist"
printf 'APPL????' > "$contents/PkgInfo"
install -m 0755 macos/Resources/lfx "$contents/Resources/bin/lfx"

# The JS runtime: compiled daemon/MCP/CLI, the prebuilt editor, and the three production dependencies.
rt="$contents/Resources/lfx"
cp -R dist/src dist/web "$rt/dist/"
cp -R libraries "$rt/"
cp package.json package-lock.json .npmrc LICENSE "$rt/"
(cd "$rt" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$rt/package-lock.json" "$rt/.npmrc"

iconset=$(mktemp -d)/AppIcon.iconset
swift macos/scripts/make-icon.swift "$iconset"
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"

echo "==> Signing"
if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app"
fi
codesign --verify --strict "$app"

if [ "$install" = 1 ]; then
  echo "==> Installing to /Applications"
  rm -rf "/Applications/Local Excalidraw.app"
  ditto "$app" "/Applications/Local Excalidraw.app"
fi

if [ "$release" = 1 ]; then
  zip="build/LocalExcalidraw-$version.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing"
    xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$app"
    rm -f "$zip"
    ditto -c -k --keepParent "$app" "$zip"
  fi
  sha=$(shasum -a 256 "$zip" | cut -d' ' -f1)
  sed -i '' -e "s/^  version \".*\"/  version \"$version\"/" -e "s/^  sha256 .*/  sha256 \"$sha\"/" Casks/local-first-excalidraw.rb
  echo "==> $zip"
  echo "    sha256 $sha (written to Casks/local-first-excalidraw.rb)"
  echo "    Upload it to a GitHub release tagged v$version, then commit the cask."
fi

echo "==> Done: $app"
