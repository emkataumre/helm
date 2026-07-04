import { defineConfig } from "vitest/config";

// M8.5 acceptance-harness runner — SEPARATE from vitest.config.ts (`npm run check`). These scenarios drive
// the REAL built Electron app via playwright-core; they are NEVER part of `npm run check`. Run them with
// `npm run accept`, which does `abi:electron && build` first (the app needs the Electron ABI + a fresh
// build). See tests/accept/harness.ts for the operational constraints (close running Helm; the ABI dance).
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        // ONLY the *.accept.ts scenarios. harness.ts / seed.ts are imported, not collected.
        include: ["tests/accept/**/*.accept.ts"],
        // A real Electron app boots per scenario (+ the per-project boot reconcile over real git), so give
        // generous ceilings — a slow FAIL is fine, a false timeout is not.
        testTimeout: 180_000,
        hookTimeout: 180_000,
        // One Electron at a time: no cross-file parallelism (real windows, one shared build, one ABI).
        fileParallelism: false,
    },
});
