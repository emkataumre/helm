// tests/verify/plan/runner.ts
// The runner: build the recording (positive: drive the REAL approve core; probe: take the hand-crafted broken
// recording), run the invariants, compute a verdict. For a PROBE, PASS means "the harness correctly caught the
// broken recording" — its named invariant FAILED. BLOCKED (couldn't observe) is never a pass.
import { runApproval, type PlanApprovalRecording } from "./surface";
import { runPlanInvariants, type InvariantResult } from "./invariants";
import { PLAN_FIXTURES, type PlanFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export function buildRecording(fixture: PlanFixture): PlanApprovalRecording {
    if (fixture.probe) return fixture.recording;
    return runApproval(fixture.scenario);
}

export interface PlanFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export function runPlanFixture(fixture: PlanFixture): PlanFixtureResult {
    const probe = Boolean(fixture.probe);
    let recording: PlanApprovalRecording;
    try {
        recording = buildRecording(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runPlanInvariants(recording);
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

export function runAll(): PlanFixtureResult[] {
    if (PLAN_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return PLAN_FIXTURES.map(runPlanFixture);
}
