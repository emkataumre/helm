import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
    main: { plugins: [externalizeDepsPlugin()] },
    preload: {
        plugins: [externalizeDepsPlugin()],
        // package.json is "type": "module", so electron-vite would emit the preload as
        // ESM (index.mjs). A sandboxed renderer (Electron's default) cannot load an ESM
        // preload, so force CommonJS output (index.cjs) — keeps sandbox: true intact.
        build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
    },
    renderer: { plugins: [react()] },
});
