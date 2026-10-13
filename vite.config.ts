import { cpSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Ship Excalidraw's fonts with the bundle so nothing is ever fetched from a CDN.
function copyExcalidrawFonts(): Plugin {
  return {
    name: "copy-excalidraw-fonts",
    apply: "build",
    closeBundle() {
      cpSync(
        resolve("node_modules/@excalidraw/excalidraw/dist/prod/fonts"),
        resolve("dist/web/fonts"),
        { recursive: true },
      );
    },
  };
}

// Excalidraw falls back to esm.sh when a font isn't found locally. Point that fallback at
// our own origin instead, and fail the build if any CDN reference survives.
function stripCdnFallback(): Plugin {
  const FALLBACK = /`https:\/\/esm\.sh\/\$\{[\s\S]*?\}\/dist\/prod\/`/g;
  let patched = 0;
  return {
    name: "strip-cdn-fallback",
    apply: "build",
    transform(code, id) {
      if (!id.includes("@excalidraw") || !code.includes("esm.sh")) return null;
      const out = code.replace(FALLBACK, () => {
        patched++;
        // Must be absolute: Excalidraw passes it to new URL(path, base).
        return '((globalThis.location && globalThis.location.origin) || "http://localhost") + "/"';
      });
      return out === code ? null : { code: out, map: null };
    },
    generateBundle(_opts, bundle) {
      if (!patched) this.error("Excalidraw CDN fallback not found; update stripCdnFallback for this version");
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type === "chunk" && /esm\.sh|unpkg\.com|jsdelivr/.test(chunk.code)) {
          this.error(`CDN reference left in ${name}`);
        }
      }
    },
  };
}

export default defineConfig({
  root: "src/web",
  base: "/",
  plugins: [react(), stripCdnFallback(), copyExcalidrawFonts()],
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: resolve("dist/web"),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    // Inlined assets would be data: URLs; keep everything as real same-origin files.
    assetsInlineLimit: 0,
  },
});
