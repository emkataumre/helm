// tests/verify/jail/runner.ts
// The runner: build the recording (positive → drive the REAL unit; probe → the hand-crafted broken recording),
// run the invariants, compute a verdict. For a PROBE, PASS means "the harness caught the lie" — its named
// invariant FAILED. BLOCKED (couldn't observe) is never a pass.
import type { JailRecording } from "./surface";
import { runJailInvariants, type InvariantResult } from "./invariants";
import { JAIL_FIXTURES, type JailFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export interface JailFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export async function runJailFixture(fixture: JailFixture): Promise<JailFixtureResult> {
    const probe = Boolean(fixture.probe);
    let recording: JailRecording;
    try {
        recording = fixture.probe ? fixture.recording : await fixture.run();
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runJailInvariants(recording);
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

export async function runAll(): Promise<JailFixtureResult[]> {
    if (JAIL_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return Promise.all(JAIL_FIXTURES.map(runJailFixture));
}
