// tests/verify/reconcile/runner.ts
// The runner: the one loop every fixture goes through — build the recording (positive: drive the REAL
// planner; probe: take the hand-crafted broken plan), read it, run the invariants, compute a verdict.
// For a PROBE, PASS means "the harness correctly caught the broken plan" — its named invariant FAILED.
// BLOCKED (couldn't observe) is never a pass.
import type { ReconcileRecording } from "./surface";
import { runReconcileInvariants, type InvariantResult } from "./invariants";
import { RECONCILE_FIXTURES, type ReconcileFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export function buildRecording(fixture: ReconcileFixture): ReconcileRecording {
    return fixture.probe ? fixture.recording : fixture.run();
}

export interface ReconcileFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export function runReconcileFixture(fixture: ReconcileFixture): ReconcileFixtureResult {
    const probe = Boolean(fixture.probe);
    let recording: ReconcileRecording;
    try {
        recording = buildRecording(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runReconcileInvariants(recording);
    if (checks.length === 0) return { fixture: fixture.id, probe, verdict: "BLOCKED", checks, notes: ["no verifiers ran"] };

    if (probe) {
        const mustFail = (fixture as ProbeFixture).mustFail;
        const named = checks.find((c) => c.name === mustFail);
        const caught = named !== undefined && !named.ok;
        const notes = caught ? [] : [`probe expected invariant "${mustFail}" to FAIL, but it held (the harness missed the lie)`];
        return { fixture: fixture.id, probe, verdict: caught ? "PASS" : "FAIL", checks, notes };
    }

    const notes = checks.filter((c) => !c.ok).map((c) => `invariant ${c.name}: ${c.detail ?? "violated"}`);
    return { fixture: fixture.id, probe, verdict: notes.length === 0 ? "PASS" : "FAIL", checks, notes };
}

export function runAll(): ReconcileFixtureResult[] {
    if (RECONCILE_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return RECONCILE_FIXTURES.map(runReconcileFixture);
}
