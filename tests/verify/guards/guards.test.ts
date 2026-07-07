// tests/verify/guards/guards.test.ts
// M12 deny fail-fast — the verify slice for the deny-wall breaker in the REAL runTaskLoop. Part 1 drives the
// real loop directly to pin the observable behaviour (escalate at denyWallK before the cap; recover when the
// deny stops; fold the deny into the no-progress reason; deny wall wins a tie). Part 2 is the CI matrix over
// every fixture + the declared invariants and their must-FAIL probes. Runs headless under `npm run check`,
// zero prod footprint.
import { describe, it, expect } from "vitest";
import { runScenario, pureWall, adaptedRecovers, distinctKeys, noProgressCourtesy, denyWallWinsTie, WALL } from "./surface";
import { runGuardFixture, runAll, type Verdict } from "./runner";
import { GUARDS_INVARIANTS, runGuardInvariants, firstDenyWallIteration } from "./invariants";
import { GUARD_FIXTURES } from "./fixtures";
import type { GuardsRecording } from "./surface";

const failed = (r: GuardsRecording) => runGuardInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/guards Part 1: the deny-wall breaker in the REAL runTaskLoop", () => {
    it("a repeated same-key deny (with red gates + junk commits) escalates at denyWallK, before the cap", async () => {
        const r = await runScenario(pureWall());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedDenyWall).toBe(true);
        expect(r.terminalReason).toBe(`deny wall: "${WALL}" denied on 3 consecutive iterations`);
        expect(r.iterationsRun).toBe(3);            // exactly denyWallK — not the cap of 8
        expect(r.iterationsRun).toBeLessThan(r.iterationCap);
        expect(failed(r)).toEqual([]);
    });

    it("a deny that STOPS repeating (agent adapted) never escalates — the task merges", async () => {
        const r = await runScenario(adaptedRecovers());
        expect(r.finalStatus).toBe("merged");
        expect(r.escalatedDenyWall).toBe(false);
        expect(r.terminalReason).toBeNull();        // merged clears any stale reason
        expect(failed(r)).toEqual([]);
    });

    it("a DIFFERENT wall each iteration never accumulates a streak → runs to the cap, no escalation", async () => {
        const r = await runScenario(distinctKeys());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedDenyWall).toBe(false);
        expect(r.terminalReason).toContain("iteration cap reached");
        expect(r.iterationsRun).toBe(4);
        expect(failed(r)).toEqual([]);
    });

    it("when the no-progress breaker fires first, it FOLDS IN the denied command (courtesy) — not a deny wall", async () => {
        const r = await runScenario(noProgressCourtesy());
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedDenyWall).toBe(false);            // no-progress won (K=2 < denyWallK=3)
        expect(r.terminalReason).toContain("no progress for 2 iterations");
        expect(r.terminalReason).toContain(`denied: ${WALL}`); // the wall is named in the reason
        expect(r.iterationsRun).toBe(2);
        expect(failed(r)).toEqual([]);
    });

    it("when both breakers reach threshold on the SAME iteration, the specific deny-wall reason wins", async () => {
        const r = await runScenario(denyWallWinsTie());     // noProgressK === denyWallK === 3
        expect(r.finalStatus).toBe("needs-human");
        expect(r.escalatedDenyWall).toBe(true);
        expect(r.terminalReason).toBe(`deny wall: "${WALL}" denied on 3 consecutive iterations`);
        expect(r.iterationsRun).toBe(3);
        expect(failed(r)).toEqual([]);
    });
});

describe("verify/guards Part 2: the CI matrix over every fixture", () => {
    it.each(GUARD_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runGuardFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(GUARD_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("declares a must-FAIL probe for EACH declared invariant", () => {
        const probed = new Set(GUARD_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...probed].sort()).toEqual(GUARDS_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(GUARD_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runScenario(pureWall());
        expect(runGuardInvariants(rec).map((r) => r.name).sort()).toEqual(GUARDS_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/guards Part 2: the re-derivation (firstDenyWallIteration) is independent of the loop", () => {
    it("returns the 1-based iteration a key first hits k consecutive; a gap resets the run", () => {
        expect(firstDenyWallIteration([[WALL], [WALL], [WALL]], 3)).toBe(3);
        expect(firstDenyWallIteration([[WALL], [WALL]], 3)).toBe(-1);          // never reaches 3
        expect(firstDenyWallIteration([[WALL], [], [WALL], [WALL]], 2)).toBe(4); // the gap reset the streak
        expect(firstDenyWallIteration([["a"], ["b"], ["c"]], 2)).toBe(-1);      // distinct keys never accumulate
    });
});

describe("verify/guards Part 2: negative controls — each broken recording FAILS its named invariant", () => {
    it("a thrash-to-cap recording (wall seen every iteration, never escalated) FAILS deny-wall-escalates-early", () => {
        const fx = GUARD_FIXTURES.find((f) => f.id === "thrash-to-cap");
        expect(fx?.probe && failed(fx.recording)).toContain("deny-wall-escalates-early");
    });
    it("an adapted-deny-escalated recording (no real wall, yet escalated) FAILS recoverable-deny-not-escalated", () => {
        const fx = GUARD_FIXTURES.find((f) => f.id === "adapted-deny-escalated");
        expect(fx?.probe && failed(fx.recording)).toContain("recoverable-deny-not-escalated");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as GuardsRecording; // property access throws inside predicates
        const results = runGuardInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
