// src/main/engine/detect.ts
// Best-effort project-config auto-detect for the registration form. The pure core (detectFromInputs)
// is unit-tested; detectProjectConfig is the thin IO wrapper (reads package.json, looks for a
// lockfile, asks git for the current branch). Everything is a proposal — the form lets the user edit.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run, type ExecFn } from "./exec";
import type { DetectedConfig } from "../../shared/types";

const LOCKFILE_SETUP: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm install"],
    ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm ci"],
    ["bun.lockb", "bun install"],
];

export function detectFromInputs(packageJsonText: string | null, lockfiles: string[], currentBranch: string | null): DetectedConfig {
    let checkCommand: string | null = null;
    if (packageJsonText) {
        try {
            const scripts = (JSON.parse(packageJsonText) as { scripts?: Record<string, string> }).scripts ?? {};
            if (scripts.check) checkCommand = "npm run check";
            else if (scripts.test) checkCommand = "npm test";
        } catch { /* malformed package.json → no check guess */ }
    }
    const setupCommand = LOCKFILE_SETUP.find(([f]) => lockfiles.includes(f))?.[1] ?? null;
    return { targetBranch: currentBranch, checkCommand, setupCommand };
}

export async function detectProjectConfig(repoPath: string, exec: ExecFn = run): Promise<DetectedConfig> {
    let pkg: string | null = null;
    try { pkg = readFileSync(join(repoPath, "package.json"), "utf8"); } catch { /* none */ }
    const lockfiles = LOCKFILE_SETUP.map(([f]) => f).filter((f) => existsSync(join(repoPath, f)));
    let branch: string | null = null;
    try {
        const res = await exec("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"]);
        if (res.code === 0) branch = res.stdout.trim() || null;
    } catch { /* not a git repo */ }
    return detectFromInputs(pkg, lockfiles, branch);
}
