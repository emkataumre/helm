// tests/verify/guards/runner.ts
// The runner: the one loop every fixture goes through — build the recording (positive: drive the REAL loop;
// probe: take the hand-crafted broken recording), run the invariants, compute a verdict. For a PROBE, PASS
// means "the harness correctly caught the broken recording" — its named invariant FAILED. BLOCKED (couldn't
// observe) is never a pass.
import type { GuardsRecording } from "./surface";
import { runGuardInvariants, type InvariantResult } from "./invariants";
import { GUARD_FIXTURES, type GuardFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export async function buildRecording(fixture: GuardFixture): Promise<GuardsRecording> {
    if (fixture.probe) return fixture.recording;
    return fixture.run();
}

export interface GuardFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export async function runGuardFixture(fixture: GuardFixture): Promise<GuardFixtureResult> {
    const probe = Boolean(fixture.probe);
    let recording: GuardsRecording;
    try {
        recording = await buildRecording(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runGuardInvariants(recording);
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

export async function runAll(): Promise<GuardFixtureResult[]> {
    if (GUARD_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return Promise.all(GUARD_FIXTURES.map(runGuardFixture));
}
