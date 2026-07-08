// src/renderer/main.tsx
// Self-hosted webfonts (the design system's Google-CDN @import, swapped for @fontsource
// binaries so the cockpit renders identically offline).
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/geist-sans/300.css";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import "./styles/tokens.css"; // design tokens + base (dark instrument-panel palette)
import "./styles/ds.css";     // design-system component classes
import "./styles/app.css";    // cockpit chrome & layout
import "@xterm/xterm/css/xterm.css"; // M7: terminal styles, loaded once globally (TerminalPane loads the JS lazily)
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<App />);
