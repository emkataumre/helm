// M8.5 accept runner — runs EACH tests/accept/*.accept.ts in its OWN vitest process, sequentially.
//
// Why not one `vitest run`: a single process launches several real Electron + node-pty apps back-to-back.
// Even though every scenario try/finally-closes its app (app.close() is leak-free), the ConPTY/OpenConsole
// host resources don't fully release within the one host process, and a LATER scenario's shell kill or
// worktree reap then flakes (each file is rock-solid in isolation — verified). A fresh process per file
// tears those OS resources down completely between files, so the suite is deterministic. This is a
// test-harness robustness measure, not a product concern (the real app hosts one long-lived process).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const vitest = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const files = readdirSync(here).filter((f) => f.endsWith(".accept.ts")).sort();

if (files.length === 0) { console.error("no *.accept.ts scenarios found"); process.exit(1); }

let failed = 0;
for (const f of files) {
    const rel = `tests/accept/${f}`;
    console.log(`\n=== accept: ${rel} ===`);
    const r = spawnSync(process.execPath, [vitest, "run", "--config", "vitest.accept.config.ts", rel], { cwd: repoRoot, stdio: "inherit" });
    if (r.status !== 0) { failed++; console.error(`FAILED: ${rel} (exit ${r.status ?? "signal " + r.signal})`); }
}
console.log(`\n=== accept summary: ${files.length - failed}/${files.length} files passed ===`);
process.exit(failed ? 1 : 0);
