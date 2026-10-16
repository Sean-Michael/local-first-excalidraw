#!/bin/bash
# Builds "Local Excalidraw.app" (Apple silicon) with the lfx runtime bundled inside it.
#
#   macos/build-app.sh                      build into build/
#   macos/build-app.sh --install            ...and copy it to /Applications
#   macos/build-app.sh --release            ...and zip it, then update Casks/local-first-excalidraw.rb
#   macos/build-app.sh --release --publish  ...then create the GitHub release v<version> and push the cask
#
# Signing: ad-hoc by default. For a release that opens without Gatekeeper prompts, set
#   SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"
#   NOTARY_PROFILE=<profile saved with `xcrun notarytool store-credentials`>
# The version comes from package.json (`npm version patch --no-git-tag-version` to bump it).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
version=$(node -p 'require("./package.json").version')
app="build/Local Excalidraw.app"
contents="$app/Contents"
cask="Casks/local-first-excalidraw.rb"
zip="build/LocalExcalidraw-$version.zip"

install=0 release=0 publish=0
for a in "$@"; do
  case "$a" in
    --install) install=1 ;;
    --release) release=1 ;;
    --publish) publish=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
die() { echo "error: $*" >&2; exit 1; }

# ---- preflight: fail before the slow parts ----
if [ "$publish" = 1 ]; then
  [ "$release" = 1 ] || die "--publish needs --release"
  [ -n "${SIGN_IDENTITY:-}" ] && [ -n "${NOTARY_PROFILE:-}" ] || die "--publish needs SIGN_IDENTITY and NOTARY_PROFILE (releases must be notarized)"
  [ "$(git branch --show-current)" = main ] || die "publish from main"
  git diff --quiet && git diff --cached --quiet || die "commit or stash your changes first"
  git fetch -q origin main && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main"
  ! gh release view "v$version" >/dev/null 2>&1 || die "release v$version already exists; bump the version (npm version patch --no-git-tag-version)"
fi
if [ -n "${SIGN_IDENTITY:-}" ]; then
  security find-identity -v -p codesigning | grep -qF "\"$SIGN_IDENTITY\"" \
    || die "no valid signing identity \"$SIGN_IDENTITY\" in the keychain (see: security find-identity -v -p codesigning)"
  case "$SIGN_IDENTITY" in "Developer ID Application:"*) ;; *) echo "warning: \"$SIGN_IDENTITY\" is not a Developer ID Application certificate; notarization will reject it" >&2 ;; esac
fi
if [ "$release" = 1 ] && [ -n "${NOTARY_PROFILE:-}" ]; then
  [ -n "${SIGN_IDENTITY:-}" ] || die "NOTARY_PROFILE needs SIGN_IDENTITY (Apple only notarizes Developer ID-signed apps)"
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null \
    || die "notarytool profile \"$NOTARY_PROFILE\" doesn't work (create it with: xcrun notarytool store-credentials $NOTARY_PROFILE ...)"
fi

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
# Served by the diagram_reference tool; found relative to dist/src/server.
mkdir -p "$rt/plugin/skills/architecture-diagrams"
cp -R plugin/skills/architecture-diagrams/references "$rt/plugin/skills/architecture-diagrams/"
cp package.json package-lock.json .npmrc LICENSE "$rt/"
(cd "$rt" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
rm -f "$rt/package-lock.json" "$rt/.npmrc"

iconset=$(mktemp -d)/AppIcon.iconset
swift macos/scripts/make-icon.swift "$iconset"
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"

echo "==> Signing"
# Hardened runtime even for ad-hoc builds, so local builds behave like notarized ones.
if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$app"
else
  codesign --force --options runtime --sign - "$app"
fi
codesign --verify --strict "$app"

if [ "$release" = 1 ]; then
  rm -f "$zip"
  ditto -c -k --keepParent "$app" "$zip"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing (usually a few minutes)"
    out=$(xcrun notarytool submit "$zip" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json)
    id=$(echo "$out" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
    status=$(echo "$out" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')
    if [ "$status" != "Accepted" ]; then
      xcrun notarytool log "$id" --keychain-profile "$NOTARY_PROFILE" >&2 || true
      die "notarization $status (submission $id)"
    fi
    xcrun stapler staple "$app"
    xcrun stapler validate "$app"
    spctl --assess --type execute -vv "$app"
    rm -f "$zip"
    ditto -c -k --keepParent "$app" "$zip"
  fi
  sha=$(shasum -a 256 "$zip" | cut -d' ' -f1)
  sed -i '' -e "s/^  version \".*\"/  version \"$version\"/" -e "s/^  sha256 .*/  sha256 \"$sha\"/" "$cask"
  echo "==> $zip"
  echo "    sha256 $sha (written to $cask)"
fi

if [ "$install" = 1 ]; then
  echo "==> Installing to /Applications"
  rm -rf "/Applications/Local Excalidraw.app"
  ditto "$app" "/Applications/Local Excalidraw.app"
fi

if [ "$publish" = 1 ]; then
  echo "==> Publishing v$version"
  gh release create "v$version" "$zip" --target main --title "v$version" --notes "Local Excalidraw.app (macOS 14+, signed and notarized), with the lfx CLI, MCP server and editor bundled.

\`\`\`
brew tap sean-michael/local-first-excalidraw https://github.com/Sean-Michael/local-first-excalidraw
brew trust sean-michael/local-first-excalidraw
brew install --cask local-first-excalidraw
\`\`\`"
  git add "$cask"
  git commit -q -m "Release v$version"
  git push -q origin main
  echo "    https://github.com/Sean-Michael/local-first-excalidraw/releases/tag/v$version"
fi

echo "==> Done: $app"
