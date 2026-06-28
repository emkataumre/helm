// tests/verify/engine.test.ts
// Engine-first runtime verification for runTaskSinglePass — drives the REAL orchestrator
// into known states, reads one machine-readable snapshot, asserts invariants.
// Vocabulary + rules from ~/.claude/verification.md (PASS/FAIL/BLOCKED/SKIP; "when in
// doubt, FAIL"; "BLOCKED is never a PASS"). Lives under tests/ — zero production footprint.
import { buildRecordingDeps, buildSnapshot, PROJECT, TASK, type Snapshot } from "./surface";
import { runTaskSinglePass } from "../../src/main/engine/runTask";
import type { DepConfig } from "./surface";
import { INVARIANTS, runInvariants } from "./invariants";
import { FIXTURES } from "./fixtures";
import { runFixture, runAll, type Verdict } from "./runner";

async function snap(config: DepConfig = {}): Promise<Snapshot> {
    const { deps, recording } = buildRecordingDeps(config);
    const status = await runTaskSinglePass(PROJECT, TASK, deps);
    return buildSnapshot(recording, status);
}

describe("verify/surface: the snapshot reflects what the real run actually did", () => {
    it("green-merge run snapshots a clean, gated squash-merge", async () => {
        const s = await snap(); // defaults = green-merge
        expect(s.unit).toBe("runTaskSinglePass");
        expect(s.finalStatus).toBe("merged");
        expect(s.squashMergeApplied).toBe(true);
        expect(s.mergedWithoutGreenGate).toBe(false);
        expect(s.worktreeRemoved).toBe(true);
        expect(s.branchKept).toBe(false);
        expect(s.diffstatRecorded).toBe(true);
        expect(s.failureReasonSet).toBe(false);
        expect(s.iterationsAdded).toBe(1);
        expect(s.iterationsFinished).toBe(1);
    });

    it("agent-fails run snapshots needs-human, retained branch, no merge, no check", async () => {
        const s = await snap({ agent: { ok: false } });
        expect(s.finalStatus).toBe("needs-human");
        expect(s.squashMergeApplied).toBe(false);
        expect(s.mergedWithoutGreenGate).toBe(false);
        expect(s.worktreeRemoved).toBe(true);
        expect(s.branchKept).toBe(true);
        expect(s.failureReasonSet).toBe(true);
        expect(s.diffstatRecorded).toBe(false);
    });
});

describe("verify/invariants: predicates hold over the real run, and catch a lie", () => {
    it("every invariant holds for the green-merge run", async () => {
        const results = runInvariants(await snap());
        const broken = results.filter((r) => !r.ok);
        expect(broken).toEqual([]);
        // sanity: we are actually evaluating the declared set, not an empty list
        expect(results.map((r) => r.name).sort()).toEqual(INVARIANTS.map((i) => i.name).sort());
    });

    it("NEGATIVE CONTROL: a merge-without-green-gate snapshot FAILS no-merge-on-red", () => {
        const lie: Snapshot = {
            unit: "runTaskSinglePass",
            finalStatus: "merged",
            gateVerdict: "green",
            squashMergeApplied: true,
            mergedWithoutGreenGate: true, // the lie: it merged though the gate never went green
            worktreeRemoved: true,
            branchKept: false,
            diffstatRecorded: true,
            failureReasonSet: false,
            iterationsAdded: 1,
            iterationsFinished: 1,
        };
        const failed = runInvariants(lie).filter((r) => !r.ok).map((r) => r.name);
        expect(failed).toContain("no-merge-on-red");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        // when-in-doubt-FAIL: feed a snapshot whose shape breaks an invariant's internals
        const broken = { unit: "runTaskSinglePass" } as unknown as Snapshot;
        const results = runInvariants(broken);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});

describe("verify/runner: the CI matrix over every fixture", () => {
    it.each(FIXTURES.map((f) => [f.id, f] as const))(
        "fixture %s → PASS (real run observed and right)",
        async (_id, fixture) => {
            const result = await runFixture(fixture);
            // BLOCKED ('couldn't observe') must never be reported as a pass.
            expect<Verdict>(result.verdict).toBe("PASS");
        },
    );

    it("every unit declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("the probes are genuinely off-happy-path and the engine still handles them", async () => {
        const probes = FIXTURES.filter((f) => f.probe);
        expect(probes.length).toBeGreaterThanOrEqual(1);
        const results = await Promise.all(probes.map(runFixture));
        for (const r of results) {
            expect(r.probe).toBe(true);
            expect(r.snapshot?.finalStatus).toBe("needs-human"); // off the happy path
            expect(r.verdict).toBe("PASS"); // ...yet correctly handled
        }
    });

    it("runAll reports a verdict for every fixture and none are BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(FIXTURES.length);
        expect(results.map((r) => r.verdict).every((v) => v === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});
