// tests/verify/runner.ts
// The RUNNER: the one loop every fixture goes through —
//   mount (build recording deps) → act (run the REAL runTaskSinglePass) → read the surface
//   (buildSnapshot) → run the verifiers (runInvariants) → compute a verdict.
// Verdict vocabulary from ~/.claude/verification.md:
//   PASS    — observed and right
//   FAIL    — observed and wrong (an invariant failed, or the run defied the fixture's expectation)
//   BLOCKED — couldn't observe (the run threw during setup, or no verifiers ran). NOT a pass.
//   SKIP    — nothing to observe (no fixtures)
import { buildRecordingDeps, buildSnapshot, PROJECT, TASK, type Snapshot } from "./surface";
import { runTaskSinglePass } from "../../src/main/engine/runTask";
import { runInvariants, type InvariantResult } from "./invariants";
import { FIXTURES, type Fixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export interface FixtureResult {
    fixture: string;
    probe: boolean;
    verdict: Verdict;
    snapshot?: Snapshot;
    checks: InvariantResult[];
    notes: string[];
}

export async function runFixture(fixture: Fixture): Promise<FixtureResult> {
    const probe = Boolean(fixture.probe);
    let snapshot: Snapshot;

    // ── mount + act: drive the real engine. If it throws, we COULDN'T observe → BLOCKED.
    try {
        const { deps, recording } = buildRecordingDeps(fixture.config);
        const status = await runTaskSinglePass(PROJECT, TASK, deps);
        snapshot = buildSnapshot(recording, status);
    } catch (err) {
        return {
            fixture: fixture.id,
            probe,
            verdict: "BLOCKED",
            checks: [],
            notes: [`could not observe — run threw: ${(err as Error)?.message ?? String(err)}`],
        };
    }

    // ── run the verifiers. No verifiers ⇒ nothing actually checked ⇒ BLOCKED, never PASS.
    const checks = runInvariants(snapshot);
    if (checks.length === 0) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", snapshot, checks, notes: ["could not observe — no verifiers ran"] };
    }

    // ── compute the verdict: universal invariants AND this fixture's stated expectation.
    const notes: string[] = [];
    if (snapshot.finalStatus !== fixture.expect.finalStatus) {
        notes.push(`expected finalStatus=${fixture.expect.finalStatus}, observed ${snapshot.finalStatus}`);
    }
    if (snapshot.gateVerdict !== fixture.expect.gateVerdict) {
        notes.push(`expected gateVerdict=${fixture.expect.gateVerdict}, observed ${snapshot.gateVerdict}`);
    }
    for (const c of checks.filter((c) => !c.ok)) {
        notes.push(`invariant ${c.name}: ${c.detail ?? "violated"}`);
    }

    const verdict: Verdict = notes.length === 0 ? "PASS" : "FAIL";
    return { fixture: fixture.id, probe, verdict, snapshot, checks, notes };
}

// Run the whole matrix. With no fixtures there is nothing to observe → a single SKIP.
export async function runAll(): Promise<FixtureResult[]> {
    if (FIXTURES.length === 0) {
        return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    }
    return Promise.all(FIXTURES.map(runFixture));
}
