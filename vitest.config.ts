import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // Real-git IO tests (worktree/merge) are slow on Windows and flake at the 5s default;
        // give a generous ceiling so the suite is deterministically green.
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
});
