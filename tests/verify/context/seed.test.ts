// tests/verify/context/seed.test.ts
// The proof that a repo-committed .helm/context.md is seeded into each task's .ralph/INSTRUCTIONS.md
// at worktree setup — the first-class replacement for the hand-maintained per-repo CLAUDE.md hack:
//   Part 1 — the seam itself: a present context.md lands VERBATIM in the seeded INSTRUCTIONS.md
//   (ritual intact above it), an absent one leaves INSTRUCTIONS.md at its byte-identical default,
//   and a blank manifest is the same no-op. Write-if-absent survives: an already-seeded
//   INSTRUCTIONS.md is never re-written, context or not.
//   Part 2 — the mandated probe: a present context.md that does NOT appear in INSTRUCTIONS.md MUST
//   FAIL. The pre-seam legacy behaviour (ritual written ignoring the manifest) is replayed against
//   the same invariant and shown to violate it — a regression that drops the injection cannot pass.
//   Part 3 — "at worktree setup" in the REAL loop: runTaskLoop wired to the real writeRalphFiles
//   over a real temp worktree (whose fake clone checks out a tracked .helm/context.md) produces an
//   INSTRUCTIONS.md carrying the context before the first iteration runs.
//
// Non-circularity: the invariant re-derives what the seeded file must contain from the RAW manifest
// bytes written by the fixture, independent of the builders — it never calls withProjectContext to
// compute its expectation. Self-contained in this one file — the retire-dollars.test.ts shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRalphFiles, readProjectContext } from "../../../src/main/engine/ralph";
import { buildInstructions, seedProgress, buildTaskDirective } from "../../../src/main/engine/prompt";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TokenTotals } from "../../../src/shared/types";

// ── Fixtures: a temp worktree, with or without the manifest ───────────────────────────────────────────

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "helm-ctx-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// The manifest a repo's humans would commit: pointers, not prose — including markdown headings and
// backticks, so "verbatim" is tested against content that would break a naive re-formatter.
const CONTEXT = `# Key files
- \`src/main/engine/runTask.ts\` — the loop. Read it before touching any breaker.
- docs/spec.md §5.5 — the prompt contract.

## House rules
Never stage docs/ — stage src/tests explicitly.
`;

// A worktree as createWorktree leaves it: the checkout carries the tracked manifest (or doesn't).
function mkWorktree(context: string | null): string {
    const wt = join(root, `wt-${context === null ? "bare" : "ctx"}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(wt, { recursive: true });
    if (context !== null) {
        mkdirSync(join(wt, ".helm"), { recursive: true });
        writeFileSync(join(wt, ".helm", "context.md"), context);
    }
    return wt;
}

const seedFiles = () => ({ instructions: buildInstructions(), progress: "SEED", task: "DIRECTIVE" });
const readInstructions = (wt: string): string => readFileSync(join(wt, ".ralph", "INSTRUCTIONS.md"), "utf8");

// ── The invariant: what a correctly-seeded INSTRUCTIONS.md must satisfy ───────────────────────────────
// Derived from the RAW manifest bytes, not from the builder: the ritual is intact at the top, and the
// manifest appears verbatim (an exact substring — no reflowing, no escaping, no truncation).
function contextSeeded(instructions: string, rawContext: string): true | string {
    if (!instructions.startsWith(buildInstructions())) return "ritual is not intact at the top of INSTRUCTIONS.md";
    if (!instructions.includes(rawContext)) return "context.md contents do NOT appear verbatim in INSTRUCTIONS.md";
    return true;
}

// ── Part 1: the seam — present lands verbatim, absent/blank is the no-op ──────────────────────────────

describe("verify/context/seed Part 1: .helm/context.md → .ralph/INSTRUCTIONS.md at seeding", () => {
    it("a present context.md lands VERBATIM in the seeded INSTRUCTIONS.md, ritual intact above it", () => {
        const wt = mkWorktree(CONTEXT);
        writeRalphFiles(wt, seedFiles());
        const instr = readInstructions(wt);
        expect(contextSeeded(instr, CONTEXT)).toBe(true);
        // The injection is additive-only: strip the ritual prefix and the remainder still carries the
        // manifest bytes untouched — nothing of the context was merged INTO the ritual.
        expect(instr.slice(buildInstructions().length)).toContain(CONTEXT);
        // The other two seeds are untouched by the context seam.
        expect(readFileSync(join(wt, ".ralph", "progress.md"), "utf8")).toBe("SEED");
        expect(readFileSync(join(wt, ".ralph", "TASK.md"), "utf8")).toBe("DIRECTIVE");
    });

    it("an absent context.md leaves INSTRUCTIONS.md at its byte-identical default", () => {
        const wt = mkWorktree(null);
        writeRalphFiles(wt, seedFiles());
        expect(readInstructions(wt)).toBe(buildInstructions());
    });

    it("a blank (whitespace-only) context.md is the same no-op as an absent one", () => {
        const wt = mkWorktree("   \n\t\n");
        writeRalphFiles(wt, seedFiles());
        expect(readInstructions(wt)).toBe(buildInstructions());
        expect(readProjectContext(wt)).toBeNull();
    });

    it("write-if-absent survives the seam: an existing INSTRUCTIONS.md is never re-written", () => {
        const wt = mkWorktree(CONTEXT);
        mkdirSync(join(wt, ".ralph"), { recursive: true });
        writeFileSync(join(wt, ".ralph", "INSTRUCTIONS.md"), "ALREADY SEEDED");
        writeRalphFiles(wt, seedFiles());
        expect(readInstructions(wt)).toBe("ALREADY SEEDED");
    });
});

// ── Part 2: the mandated probe — a present-but-not-injected manifest MUST FAIL ────────────────────────

describe("verify/context/seed Part 2: the probe", () => {
    it("PROBE: a present context.md that does NOT appear in INSTRUCTIONS.md MUST FAIL the invariant", () => {
        // Replay the pre-seam legacy seeding: the ritual written as-is, the manifest ignored. This is
        // exactly what a regression that drops the injection would produce — the invariant must catch it.
        const wt = mkWorktree(CONTEXT);
        mkdirSync(join(wt, ".ralph"), { recursive: true });
        writeFileSync(join(wt, ".ralph", "INSTRUCTIONS.md"), buildInstructions()); // legacy: context ignored
        const verdict = contextSeeded(readInstructions(wt), readFileSync(join(wt, ".helm", "context.md"), "utf8"));
        expect(verdict).not.toBe(true);
        expect(verdict).toContain("do NOT appear verbatim");
    });

    it("PROBE: a mangled (non-verbatim) injection also fails — verbatim means verbatim", () => {
        const wt = mkWorktree(CONTEXT);
        mkdirSync(join(wt, ".ralph"), { recursive: true });
        // A well-meaning reformatter that reflows the manifest (strips the backticks) breaks the contract.
        writeFileSync(join(wt, ".ralph", "INSTRUCTIONS.md"), buildInstructions() + "\n" + CONTEXT.replaceAll("`", ""));
        expect(contextSeeded(readInstructions(wt), CONTEXT)).not.toBe(true);
    });
});

// ── Part 3: the REAL loop seeds it at worktree setup ──────────────────────────────────────────────────

const mkProject = (): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees", setupCommand: null,
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null,
    terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
const mkTask = (): Task => ({
    id: "t1", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null,
    createdAt: 0, updatedAt: 0,
});
const TEST_CONFIG: LoopConfig = { iterationCap: 1, noProgressK: 99, denyWallK: 99, mergeRecycleK: 0, tokenCap: 1_000_000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };
const usage = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 });

describe("verify/context/seed Part 3: runTaskLoop seeds the context at worktree setup", () => {
    it("the loop's fresh-start seeding, via the REAL writeRalphFiles, carries the manifest before iteration 0", async () => {
        let wt = "";
        let instructionsAtSpawn: string | null = null; // read when the agent runs — proves seeding preceded it
        const deps: RunTaskDeps = {
            ensureBranch: async () => {},
            checkoutBranch: async () => {},
            // The fake clone: a real temp dir whose checkout carries the tracked .helm/context.md.
            createWorktree: async () => { wt = mkWorktree(CONTEXT); return wt; },
            removeWorktree: async () => {},
            ensureRalphExcluded: () => {},
            writeRalphFiles, // the REAL seeding chokepoint under test
            runSetup: async () => ({ ok: true, output: "" }),
            spawnAgent: async () => {
                instructionsAtSpawn = readInstructions(wt);
                return { ok: true, output: "did work", sessionId: "s0", stalled: false, usage: usage(), durationMs: 1, deniedCommands: [] };
            },
            commitAll: async () => {},
            headSha: async () => "sha",
            runCheck: async () => ({ green: false, timedOut: false, output: "red" }),
            runAcceptance: async () => ({ ok: true, output: "" }),
            squashMergeInto: async () => ({ merged: false, conflict: false }),
            diffStat: async () => "",
            mergeStage: async () => ({ outcome: "merged", diffstat: "" }),
            setStatus: () => {},
            addIteration: () => ({ id: "it-0" }),
            finishIteration: () => {},
            log: () => {},
        };
        await runTaskLoop(mkProject(), mkTask(), TEST_CONFIG, deps);
        expect(instructionsAtSpawn).not.toBeNull();
        expect(contextSeeded(instructionsAtSpawn as unknown as string, CONTEXT)).toBe(true);
        // The seed carried the real progress/TASK builders' output too — the seam changed ONLY instructions.
        expect(readFileSync(join(wt, ".ralph", "progress.md"), "utf8")).toBe(seedProgress(mkTask()));
        expect(readFileSync(join(wt, ".ralph", "TASK.md"), "utf8")).toBe(buildTaskDirective(mkTask()));
    });

    it("the same loop over a bare checkout (no manifest) seeds the byte-identical default ritual", async () => {
        let wt = "";
        const deps: RunTaskDeps = {
            ensureBranch: async () => {}, checkoutBranch: async () => {},
            createWorktree: async () => { wt = mkWorktree(null); return wt; },
            removeWorktree: async () => {}, ensureRalphExcluded: () => {},
            writeRalphFiles,
            runSetup: async () => ({ ok: true, output: "" }),
            spawnAgent: async () => ({ ok: true, output: "", sessionId: "s0", stalled: false, usage: usage(), durationMs: 1, deniedCommands: [] }),
            commitAll: async () => {}, headSha: async () => "sha",
            runCheck: async () => ({ green: false, timedOut: false, output: "red" }),
            runAcceptance: async () => ({ ok: true, output: "" }),
            squashMergeInto: async () => ({ merged: false, conflict: false }), diffStat: async () => "",
            mergeStage: async () => ({ outcome: "merged", diffstat: "" }),
            setStatus: () => {}, addIteration: () => ({ id: "it-0" }), finishIteration: () => {}, log: () => {},
        };
        await runTaskLoop(mkProject(), mkTask(), TEST_CONFIG, deps);
        expect(readInstructions(wt)).toBe(buildInstructions());
    });
});
