import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        // M16: a second main-side entry — the `helm` control CLI (out/main/cli.js). The PATH shims Helm
        // writes under userData call it via the plain `node` on PATH; it imports node builtins only and
        // never loads Electron. Listing `index` explicitly keeps the app entry name unchanged.
        build: { rollupOptions: { input: { index: "src/main/index.ts", cli: "src/main/ctl/cli.ts" } } },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        // package.json is "type": "module", so electron-vite would emit the preload as
        // ESM (index.mjs). A sandboxed renderer (Electron's default) cannot load an ESM
        // preload, so force CommonJS output (index.cjs) — keeps sandbox: true intact.
        build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
    },
    renderer: { plugins: [react()] },
});
