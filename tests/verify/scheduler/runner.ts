// tests/verify/scheduler/runner.ts
// The runner: the one loop every fixture goes through — build the recording (positive: drive the REAL
// scheduler + mutex + runMergeStage; probe: take the hand-crafted broken recording), read it, run the
// invariants, compute a verdict. For a PROBE, PASS means "the harness correctly caught the broken
// recording" — its named invariant FAILED. BLOCKED (couldn't observe) is never a pass.
import { runScenario, type SchedulerRecording } from "./surface";
import { runSchedulerInvariants, type InvariantResult } from "./invariants";
import { SCHEDULER_FIXTURES, type SchedulerFixture, type ProbeFixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export async function buildRecording(fixture: SchedulerFixture): Promise<SchedulerRecording> {
    if (fixture.probe) return fixture.recording;
    return runScenario(fixture.scenario);
}

export interface SchedulerFixtureResult { fixture: string; probe: boolean; verdict: Verdict; checks: InvariantResult[]; notes: string[] }

export async function runSchedulerFixture(fixture: SchedulerFixture): Promise<SchedulerFixtureResult> {
    const probe = Boolean(fixture.probe);
    let recording: SchedulerRecording;
    try {
        recording = await buildRecording(fixture);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build recording — threw: ${(err as Error)?.message ?? String(err)}`] };
    }

    const checks = runSchedulerInvariants(recording);
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

export async function runAll(): Promise<SchedulerFixtureResult[]> {
    if (SCHEDULER_FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return Promise.all(SCHEDULER_FIXTURES.map(runSchedulerFixture));
}
