// tests/verify/context/startfresh.test.ts
// The proof that a Start-fresh drop-in — a task grabbed with "Start fresh" when there is NO resumable
// claude session (the M5 finding: an iteration killed before claude persisted its session leaves nothing
// to --resume) — is seeded with REAL context from the task's on-disk state instead of opening blank:
//   Part 1 — the composer: a bundle built from .ralph/TASK.md + .ralph/progress.md + the latest
//   iteration-log tail carries all three VERBATIM, under the has-context invariant. Absent/blank inputs
//   compose to "" (the "no seed" signal), and each present input is included on its own.
//   Part 2 — the mandated probe: a Start-fresh that seeds an EMPTY/blank context MUST FAIL the invariant
//   when those files exist. The pre-seam bare-`claude` behaviour (an empty seed) is replayed against the
//   same invariant and shown to violate it — a regression that drops the seed cannot pass.
//   Part 3 — the real reads + launch wiring: readDropinSeedInputs over a real temp worktree + log dir
//   gathers all three (picking the HIGHEST-index iteration log), the composed bundle satisfies the
//   invariant, and buildDropinArgv opens a seeded fresh claude on .ralph/DROPIN.md — while a resume and a
//   no-seed fresh launch are left untouched.
//
// Non-circularity: the invariant re-derives what the bundle must contain from the RAW input bytes the
// fixture wrote — it never calls composeDropinSeed to compute its expectation. Self-contained in this one
// file (the seed.test.ts shape).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    composeDropinSeed,
    readDropinSeedInputs,
    readTranscriptTail,
    type DropinSeedInputs,
} from "../../../src/main/engine/dropinSeed";
import { buildDropinArgv } from "../../../src/main/engine/terminalLaunch";

// ── Fixtures: representative on-disk state, with markdown + backticks so "verbatim" is tested against
// content a naive re-formatter would mangle ─────────────────────────────────────────────────────────
const TASK = `# Task — Seed the drop-in

Make an early Start-fresh drop-in useful instead of blank.

## Acceptance commands
- npm run test -- tests/verify/context/startfresh.test.ts
`;
const PROGRESS = `# Progress — Seed the drop-in

## Current focus
Wiring \`composeDropinSeed\` into the fresh drop-in path.

## Done
- Read the M5 finding.
`;
const TAIL = `{"type":"assistant","text":"running npm run check"}
{"type":"result","subtype":"error","detail":"acceptance red"}
`;

const allInputs = (): DropinSeedInputs => ({ task: TASK, progress: PROGRESS, transcriptTail: TAIL });

// ── The invariant: what a correctly-seeded bundle must satisfy ────────────────────────────────────────
// Derived from the RAW input bytes, not from the builder: every PRESENT input appears verbatim (an exact
// substring — no reflowing, escaping, or truncation), and the bundle is non-empty.
function seedHasContext(bundle: string, raw: DropinSeedInputs): true | string {
    if (!bundle.trim()) return "seed bundle is empty — the fresh session would open with no context";
    if (raw.task && !bundle.includes(raw.task)) return "TASK.md content is missing from the seed bundle";
    if (raw.progress && !bundle.includes(raw.progress)) return "progress.md content is missing from the seed bundle";
    if (raw.transcriptTail && !bundle.includes(raw.transcriptTail)) return "transcript tail is missing from the seed bundle";
    return true;
}

// ── Part 1: the composer — present inputs land verbatim, absent inputs are omitted ────────────────────

describe("verify/context/startfresh Part 1: composeDropinSeed", () => {
    it("composes a bundle carrying TASK.md, progress.md AND the transcript tail verbatim", () => {
        const raw = allInputs();
        const bundle = composeDropinSeed(raw);
        expect(seedHasContext(bundle, raw)).toBe(true);
        // The bundle is additive around each input: a fresh-session preamble, then each source labelled.
        expect(bundle).toContain("Start fresh");
        expect(bundle).toContain(".ralph/TASK.md");
        expect(bundle).toContain(".ralph/progress.md");
        expect(bundle).toContain("transcript tail");
    });

    it("omits an absent input but still carries the ones present (partial state is still useful)", () => {
        const raw: DropinSeedInputs = { task: TASK, progress: null, transcriptTail: TAIL };
        const bundle = composeDropinSeed(raw);
        expect(seedHasContext(bundle, raw)).toBe(true);
        expect(bundle).toContain(TASK);
        expect(bundle).toContain(TAIL);
        expect(bundle).not.toContain(".ralph/progress.md");
    });

    it("nothing on disk → an empty bundle (the 'no seed' signal to the caller)", () => {
        expect(composeDropinSeed({ task: null, progress: null, transcriptTail: null })).toBe("");
        // whitespace-only inputs are treated as absent, not as content
        expect(composeDropinSeed({ task: "  \n\t", progress: "\n", transcriptTail: "   " })).toBe("");
    });
});

// ── Part 2: the mandated probe — an empty/blank seed MUST FAIL when the files exist ───────────────────

describe("verify/context/startfresh Part 2: the probe", () => {
    it("PROBE: a Start-fresh that seeds an EMPTY context MUST FAIL the invariant when the files exist", () => {
        // Replay the pre-seam bare-`claude` Start-fresh: the fresh session opens with no bundle at all,
        // even though TASK.md/progress.md/the log tail are right there on disk. The invariant must catch it.
        const raw = allInputs();
        const verdict = seedHasContext("", raw);
        expect(verdict).not.toBe(true);
        expect(verdict).toContain("empty");
    });

    it("PROBE: a bundle that drops one source (a partial regression) also fails — verbatim means all present", () => {
        const raw = allInputs();
        // A well-meaning composer that forgets the transcript tail still violates the contract.
        const bundleMissingTail = composeDropinSeed({ ...raw, transcriptTail: null });
        expect(seedHasContext(bundleMissingTail, raw)).not.toBe(true);
        expect(seedHasContext(bundleMissingTail, raw)).toContain("transcript tail");
    });
});

// ── Part 3: the real reads + launch wiring ────────────────────────────────────────────────────────────

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "helm-dropin-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// A worktree as the t1 seeding path leaves it, plus a log dir as logSink fills it (iter-<index>.ndjson).
function mkState(taskId: string): { worktree: string; logBase: string } {
    const worktree = join(root, "wt");
    mkdirSync(join(worktree, ".ralph"), { recursive: true });
    writeFileSync(join(worktree, ".ralph", "TASK.md"), TASK);
    writeFileSync(join(worktree, ".ralph", "progress.md"), PROGRESS);
    const logBase = join(root, "logs");
    mkdirSync(join(logBase, taskId), { recursive: true });
    // Two iterations: readTranscriptTail must pick the HIGHEST index (iter-1), not iter-0.
    writeFileSync(join(logBase, taskId, "iter-0.ndjson"), `{"type":"stale","text":"iteration 0"}\n`);
    writeFileSync(join(logBase, taskId, "iter-1.ndjson"), TAIL);
    return { worktree, logBase };
}

describe("verify/context/startfresh Part 3: real reads + drop-in launch wiring", () => {
    it("readTranscriptTail returns the tail of the HIGHEST-index iteration log", () => {
        const { logBase } = mkState("t1");
        expect(readTranscriptTail(logBase, "t1")).toBe(TAIL);
    });

    it("readTranscriptTail is null when the task has no log dir yet (early drop-in)", () => {
        const { logBase } = mkState("t1");
        expect(readTranscriptTail(logBase, "no-such-task")).toBeNull();
    });

    it("readDropinSeedInputs gathers all three, and the composed bundle satisfies the invariant", () => {
        const { worktree, logBase } = mkState("t1");
        const inputs = readDropinSeedInputs(worktree, logBase, "t1");
        expect(inputs).toEqual({ task: TASK, progress: PROGRESS, transcriptTail: TAIL });
        expect(seedHasContext(composeDropinSeed(inputs), inputs)).toBe(true);
    });

    it("buildDropinArgv opens a SEEDED fresh claude on .ralph/DROPIN.md; unseeded/resume are untouched", () => {
        // Fresh + seeded: the launch points claude at the bundle the engine wrote.
        const seeded = buildDropinArgv(null, true);
        expect(seeded[seeded.length - 1]).toContain(".ralph/DROPIN.md");
        // Fresh + no seed (nothing on disk): a bare claude, the pre-seam behaviour.
        expect(buildDropinArgv(null, false)).toEqual(["pwsh.exe", "-NoExit", "-Command", "claude"]);
        // Resume: seeded is ignored — a resumed session already carries its own context.
        expect(buildDropinArgv("sess-123", true)).toEqual(["pwsh.exe", "-NoExit", "-Command", "claude --resume sess-123"]);
    });
});
