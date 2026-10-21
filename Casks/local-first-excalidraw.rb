cask "local-first-excalidraw" do
  version "1.3.0"
  sha256 "97b234c544938689bd6f27a58be4513c16ced7e4f948c1e70df4205532d0427e"

  url "https://github.com/Sean-Michael/local-first-excalidraw/releases/download/v#{version}/LocalExcalidraw-#{version}.zip"
  name "Local Excalidraw"
  desc "Offline Excalidraw editor with an MCP server for coding agents"
  homepage "https://github.com/Sean-Michael/local-first-excalidraw"

  depends_on formula: "node"
  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Local Excalidraw.app"
  binary "#{appdir}/Local Excalidraw.app/Contents/Resources/bin/lfx"

  uninstall quit: "io.github.sean-michael.local-first-excalidraw"

  # ~/.local-first-excalidraw (token, sessions, folders, shape library) is shared with the CLI and is left alone.
  zap trash: [
    "~/Library/Caches/io.github.sean-michael.local-first-excalidraw",
    "~/Library/HTTPStorages/io.github.sean-michael.local-first-excalidraw",
    "~/Library/Preferences/io.github.sean-michael.local-first-excalidraw.plist",
    "~/Library/Saved Application State/io.github.sean-michael.local-first-excalidraw.savedState",
    "~/Library/WebKit/io.github.sean-michael.local-first-excalidraw",
  ]
end
