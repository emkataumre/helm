// tests/verify/ctl/runner.ts
// The runner: the one loop every fixture goes through — build the recording (positive: drive the REAL
// ctl kernel; probe: take the hand-crafted broken recording), run the invariants, compute a verdict.
// For a PROBE, PASS means "the harness correctly caught the broken recording" — its named invariant
// FAILED. BLOCKED (couldn't observe) is never a pass.
import type { CtlRecording } from "./surface";
import { runCtlInvariants, type InvariantResult } from "./invariants";
import { CTL_FIXTURES, type CtlFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export async function buildRecording(fixture: CtlFixture): Promise<CtlRecording> {
    return fixture.probe ? fixture.recording : fixture.run();
}

export interface CtlFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export async function runCtlFixture(fixture: CtlFixture): Promise<CtlFixtureResult> {
    const probe = Boolean(fixture.probe);
    let recording: CtlRecording;
    try {
        recording = await buildRecording(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runCtlInvariants(recording);
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

export async function runAll(): Promise<CtlFixtureResult[]> {
    if (CTL_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return Promise.all(CTL_FIXTURES.map(runCtlFixture));
}
