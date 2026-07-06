// src/main/engine/ralph.ts
// Manages the two git-excluded .ralph/ files that carry reasoning across cold iterations.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Idempotently append one entry to the repo-local .git/info/exclude (shared across worktrees via the common
// git dir), so per-iteration commits never stage it and it can never reach the target branch. A tracked
// .gitignore is not an option — it would itself be committable. Write-if-absent + tolerant of a missing file.
function ensureExcluded(repoPath: string, entry: string): void {
    const excludePath = join(repoPath, ".git", "info", "exclude");
    let current = "";
    try { current = readFileSync(excludePath, "utf8"); } catch { /* may not exist yet */ }
    if (current.split(/\r?\n/).some((l) => l.trim() === entry)) return;
    const prefix = current.length && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${prefix}${entry}\n`);
}

// Exclude .ralph/ (the per-worktree reasoning files).
export function ensureRalphExcluded(repoPath: string): void {
    ensureExcluded(repoPath, ".ralph/");
}

// M10: exclude the whole .helm/ dir (the transient .helm/plan/ drop seam + .helm/worktrees), so the plan
// files a planning session writes never land in a commit. One line covers both; write-if-absent (openPlanner
// calls it each time the planner opens — idempotent).
export function ensureHelmExcluded(repoPath: string): void {
    ensureExcluded(repoPath, ".helm/");
}

// Seed the two .ralph files write-if-absent: INSTRUCTIONS is static, progress is owned by the
// agent after seeding, so a cold iteration never clobbers the running notes (and it's crash-safe).
export function writeRalphFiles(worktreePath: string, files: { instructions: string; progress: string }): void {
    const dir = join(worktreePath, ".ralph");
    mkdirSync(dir, { recursive: true });
    const instr = join(dir, "INSTRUCTIONS.md");
    const prog = join(dir, "progress.md");
    if (!existsSync(instr)) writeFileSync(instr, files.instructions);
    if (!existsSync(prog)) writeFileSync(prog, files.progress);
}
