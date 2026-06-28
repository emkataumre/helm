// tests/verify/runner.ts
// The RUNNER: the one loop every fixture goes through — mount (recording deps) → act (run the
// REAL runTaskLoop) → read the surface (buildSnapshot) → run the verifiers → compute a verdict.
//   PASS — observed and right · FAIL — observed and wrong · BLOCKED — couldn't observe (NOT a
//   pass) · SKIP — nothing to observe.
import { buildRecordingDeps, buildSnapshot, PROJECT, TASK, type Snapshot, type DepConfig } from "./surface";
import { runTaskLoop } from "../../src/main/engine/runTask";
import { runInvariants, type InvariantResult } from "./invariants";
import { FIXTURES, type Fixture } from "./fixtures";

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

export async function runScenario(config: DepConfig): Promise<Snapshot> {
    const { deps, recording, loopConfig } = buildRecordingDeps(config);
    const task = { ...TASK, acceptance: config.acceptance ?? TASK.acceptance };
    const finalStatus = await runTaskLoop(PROJECT, task, loopConfig, deps);
    return buildSnapshot(recording, finalStatus, loopConfig);
}

export interface FixtureResult { fixture: string; probe: boolean; verdict: Verdict; snapshot?: Snapshot; checks: InvariantResult[]; notes: string[]; }

export async function runFixture(fixture: Fixture): Promise<FixtureResult> {
    const probe = Boolean(fixture.probe);
    let snapshot: Snapshot;
    try {
        snapshot = await runScenario(fixture.config);
    } catch (err) {
        return { fixture: fixture.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not observe — threw: ${(err as Error)?.message ?? String(err)}`] };
    }
    const checks = runInvariants(snapshot);
    if (checks.length === 0) return { fixture: fixture.id, probe, verdict: "BLOCKED", snapshot, checks, notes: ["no verifiers ran"] };

    const notes: string[] = [];
    if (snapshot.finalStatus !== fixture.expect.finalStatus) notes.push(`expected finalStatus=${fixture.expect.finalStatus}, observed ${snapshot.finalStatus}`);
    for (const c of checks.filter((c) => !c.ok)) notes.push(`invariant ${c.name}: ${c.detail ?? "violated"}`);
    return { fixture: fixture.id, probe, verdict: notes.length === 0 ? "PASS" : "FAIL", snapshot, checks, notes };
}

export async function runAll(): Promise<FixtureResult[]> {
    if (FIXTURES.length === 0) return [{ fixture: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return Promise.all(FIXTURES.map(runFixture));
}
