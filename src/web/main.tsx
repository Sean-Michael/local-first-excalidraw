import "./asset-path";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./Editor";
import { FileBrowser } from "./FileBrowser";
import { Renderer } from "./Renderer";

const params = new URLSearchParams(location.search);
const file = params.get("file");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{params.has("renderer") ? <Renderer /> : file ? <Editor path={file} /> : <FileBrowser />}</StrictMode>,
);
