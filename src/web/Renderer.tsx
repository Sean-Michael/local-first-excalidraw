import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useEffect, useState } from "react";
import { mermaid, render } from "./Editor";
import { type ServerMsg, Sync } from "./sync";

/**
 * The page the daemon's headless browser loads (`/?renderer=1`). It answers render and
 * Mermaid requests for any drawing and never opens, edits or saves one. Excalidraw is mounted
 * so its bundled fonts are registered exactly as in a normal editor tab.
 */
export function Renderer() {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    document.title = "Renderer · Excalidraw";
  }, []);

  useEffect(() => {
    if (!excalidraw) return;
    const reply = (id: string, p: Promise<unknown>) =>
      p.then(
        (result) => sync.send({ t: "reply", id, ok: true, result }),
        (e: Error) => sync.send({ t: "reply", id, ok: false, error: e.message }),
      );
    // Requests run one at a time so concurrent renders don't compete for fonts and memory.
    let chain: Promise<unknown> = Promise.resolve();
    const sync = new Sync(
      (m: ServerMsg) => {
        if (m.t === "render") chain = chain.then(() => reply(m.id, render(m.scene, m.opts)));
        else if (m.t === "mermaid") chain = chain.then(() => reply(m.id, mermaid(m.text)));
      },
      () => {},
      () => {},
    );
    return () => sync.close();
  }, [excalidraw]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Excalidraw excalidrawAPI={setExcalidraw} viewModeEnabled />
    </div>
  );
}
