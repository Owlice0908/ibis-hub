import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Prevent WebView from navigating to dropped files (shows file contents).
// Our custom drag-and-drop handler in TerminalPane handles file drops instead.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
