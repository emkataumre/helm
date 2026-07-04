import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
    // The React plugin transforms the .tsx presentational components so they can be statically
    // rendered (react-dom/server) under Vitest — no jsdom, no browser. Both deps already present.
    plugins: [react()],
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
        // M8.5: the accept scenarios (*.accept.ts) already fall outside `include`, but exclude the whole
        // tests/accept/ dir belt-and-suspenders so `npm run check` can NEVER pick up anything there (even a
        // stray *.test.ts) — those run only under `npm run accept` (vitest.accept.config.ts). Preserve the
        // vitest defaults (node_modules, dist, …) so we only ADD this exclusion.
        exclude: [...configDefaults.exclude, "tests/accept/**"],
        // Real-git IO tests (worktree/merge) are slow on Windows and flake at the 5s default;
        // give a generous ceiling so the suite is deterministically green.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
