import "./asset-path";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Renderer } from "./Renderer";
import { Workspace } from "./Workspace";

const params = new URLSearchParams(location.search);

createRoot(document.getElementById("root")!).render(<StrictMode>{params.has("renderer") ? <Renderer /> : <Workspace />}</StrictMode>);
