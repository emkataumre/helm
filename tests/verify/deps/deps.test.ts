// tests/verify/deps/deps.test.ts
// The M9 verify slice's CI matrix. Positive fixtures drive the REAL scheduler (with the REAL depsSatisfied
// gate) + the REAL waitingOnFor derivation and distill a cross-task DepsRecording; probes are hand-crafted
// broken recordings (negative controls). Asserts the three M9 invariants — no-start-before-deps-merged,
// blocked-derivation-correct, empty-deps-byte-identical — each with a probe that MUST FAIL. Vocabulary from
// ~/.claude/verification.md. Complementary to, and separate from, the M4 tests/verify/scheduler/ slice.
import { describe, it, expect } from "vitest";
import { runDepsFixture, runAll, type Verdict } from "./runner";
import { DEPS_INVARIANTS, runDepsInvariants } from "./invariants";
import { DEPS_FIXTURES } from "./fixtures";
import { runScenario, type DepsRecording } from "./surface";

const failed = (r: DepsRecording) => runDepsInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/deps: the CI matrix over every fixture", () => {
    it.each(DEPS_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runDepsFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(DEPS_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    // Every declared invariant has a probe that exercises it — a checklist that's all ✅ and no 🔍 is a replay.
    it("declares a must-FAIL probe for every invariant", () => {
        const covered = new Set(DEPS_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(DEPS_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(DEPS_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/deps: the recording is the real units' behaviour", () => {
    it("a child is held until its parent merges, then starts (the merged-gate over the real scheduler)", async () => {
        const rec = await runScenario({ cap: 3, tasks: [{ id: "T1" }, { id: "T2", dependsOn: ["T1"] }] });
        expect(rec.startOrder).toEqual(["T1", "T2"]);         // T1 first, T2 only after
        const t2 = rec.starts.find((s) => s.taskId === "T2")!;
        expect(t2.parents).toEqual([{ id: "T1", status: "merged" }]); // T2 started only once T1 had merged
        expect(failed(rec)).toEqual([]);
    });

    it("a needs-human parent leaves the child stuck-blocked: it never starts, and the derivation says so", async () => {
        const rec = await runScenario({ cap: 3, tasks: [{ id: "P", initialStatus: "needs-human" }, { id: "C", dependsOn: ["P"] }] });
        expect(rec.startOrder).toEqual([]);                    // neither starts (P not queued; C blocked)
        const c = rec.derivations.find((d) => d.taskId === "C")!;
        expect(c.blocked).toBe(true);
        expect(c.waitingOnIds).toEqual(["P"]);
        expect(failed(rec)).toEqual([]);
    });

    it("an unknown (deleted) parent does not wedge the child — it starts and derives unblocked", async () => {
        const rec = await runScenario({ cap: 3, tasks: [{ id: "C", dependsOn: ["ghost"] }] });
        expect(rec.startOrder).toEqual(["C"]);
        expect(rec.derivations.find((d) => d.taskId === "C")!.blocked).toBe(false);
        expect(failed(rec)).toEqual([]);
    });

    it("a no-edges board schedules exactly as M4 (start order == FIFO)", async () => {
        const rec = await runScenario({ cap: 3, tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] });
        expect(rec.hasEdges).toBe(false);
        expect(rec.startOrder).toEqual(rec.fifoOrder);
        expect(rec.startOrder).toEqual(["a", "b", "c"]);
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runScenario({ cap: 1, tasks: [{ id: "a" }] });
        expect(runDepsInvariants(rec).map((r) => r.name).sort()).toEqual(DEPS_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/deps: negative controls — each broken recording FAILS its named invariant", () => {
    it("a start while a parent was running FAILS no-start-before-deps-merged", () => {
        const rec: DepsRecording = {
            unit: "deps", hasEdges: true, startOrder: ["T1", "T2"], fifoOrder: ["T1"],
            starts: [{ taskId: "T1", parents: [] }, { taskId: "T2", parents: [{ id: "T1", status: "running" }] }],
            derivations: [],
        };
        expect(failed(rec)).toContain("no-start-before-deps-merged");
    });

    it("blocked=false with an unmerged parent FAILS blocked-derivation-correct", () => {
        const rec: DepsRecording = {
            unit: "deps", hasEdges: true, startOrder: [], fifoOrder: [], starts: [],
            derivations: [{ taskId: "C", blocked: false, waitingOnIds: [], parents: [{ id: "P", status: "running" }] }],
        };
        expect(failed(rec)).toContain("blocked-derivation-correct");
    });

    it("a reordered no-edges board FAILS empty-deps-byte-identical", () => {
        const rec: DepsRecording = { unit: "deps", hasEdges: false, startOrder: ["b", "a"], fifoOrder: ["a", "b"], starts: [], derivations: [] };
        expect(failed(rec)).toContain("empty-deps-byte-identical");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = {} as unknown as DepsRecording; // accessing .starts/.derivations throws inside predicates
        const results = runDepsInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
