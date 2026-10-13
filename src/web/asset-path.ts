// Must run before Excalidraw is imported: serve fonts from this origin, never a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/";
export {};
