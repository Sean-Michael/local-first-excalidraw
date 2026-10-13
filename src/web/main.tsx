import "./asset-path";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./Editor";
import { FileBrowser } from "./FileBrowser";

const file = new URLSearchParams(location.search).get("file");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{file ? <Editor path={file} /> : <FileBrowser />}</StrictMode>,
);
