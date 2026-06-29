// tests/verify/snapshot/runner.ts
// The runner: the one loop every fixture goes through — build the snapshot (positive: reduce a real
// event script through the REAL reducer; probe: take the hand-crafted broken snapshot), read it,
// run the invariants, compute a verdict. For a PROBE, PASS means "the harness correctly caught the
// broken snapshot" — i.e. its named invariant FAILED. BLOCKED (couldn't observe) is never a pass.
import { emptySnapshot, applyEvent } from "../../../src/main/engine/verifyState";
import { runSnapshotInvariants, type InvariantResult } from "./invariants";
import { SNAPSHOT_FIXTURES, type SnapshotFixture } from "./fixtures";
import type { EngineSnapshot } from "../../../src/shared/types";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export function buildSnapshot(fixture: SnapshotFixture): EngineSnapshot {
    if (fixture.probe) return fixture.snapshot;
    return fixture.events.reduce((draft, e) => applyEvent(draft, e), emptySnapshot("verify-task", "running"));
}

export interface SnapshotFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export function runSnapshotFixture(fixture: SnapshotFixture): SnapshotFixtureResult {
    const probe = Boolean(fixture.probe);
    let snapshot: EngineSnapshot;
    try {
        snapshot = buildSnapshot(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build snapshot — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runSnapshotInvariants(snapshot);
    if (checks.length === 0) return { fixture: fixture.id, probe, verdict: "BLOCKED", checks, notes: ["no verifiers ran"] };

    if (probe) {
        const mustFail = (fixture as Extract<SnapshotFixture, { probe: true }>).mustFail;
        const named = checks.find((c) => c.name === mustFail);
        const caught = named !== undefined && !named.ok;
        const notes = caught ? [] : [`probe expected invariant "${mustFail}" to FAIL, but it held (the harness missed the lie)`];
        return { fixture: fixture.id, probe, verdict: caught ? "PASS" : "FAIL", checks, notes };
    }

    const notes = checks.filter((c) => !c.ok).map((c) => `invariant ${c.name}: ${c.detail ?? "violated"}`);
    return { fixture: fixture.id, probe, verdict: notes.length === 0 ? "PASS" : "FAIL", checks, notes };
}

export function runAll(): SnapshotFixtureResult[] {
    if (SNAPSHOT_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return SNAPSHOT_FIXTURES.map(runSnapshotFixture);
}
