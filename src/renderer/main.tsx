// src/renderer/main.tsx
import "@xterm/xterm/css/xterm.css"; // M7: terminal styles, loaded once globally (TerminalPane loads the JS lazily)
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
