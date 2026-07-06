// tests/verify/plan/plan.test.ts
// The M10 verify slice's CI matrix. Positive fixtures drive the REAL approve core (approveFromTasksJson →
// parsePlanDraft + planApproval) and distill a PlanApprovalRecording; probes are hand-crafted broken recordings
// (negative controls). Asserts the three M10 invariants — approve-only-valid, dep-slugs-resolve-acyclic,
// acceptance-mandatory-preserved — each with a probe that MUST FAIL. Vocabulary from ~/.claude/verification.md.
import { describe, it, expect } from "vitest";
import { runPlanFixture, runAll, type Verdict } from "./runner";
import { PLAN_INVARIANTS, runPlanInvariants } from "./invariants";
import { PLAN_FIXTURES } from "./fixtures";
import { runApproval, type PlanApprovalRecording } from "./surface";

const failed = (r: PlanApprovalRecording) => runPlanInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/plan: the CI matrix over every fixture", () => {
    it.each(PLAN_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", (_id, fixture) => {
        expect<Verdict>(runPlanFixture(fixture).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(PLAN_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    // Every declared invariant has a probe that exercises it — a checklist that's all ✅ and no 🔍 is a replay.
    it("declares a must-FAIL probe for every invariant", () => {
        const covered = new Set(PLAN_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(PLAN_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", () => {
        const results = runAll();
        expect(results).toHaveLength(PLAN_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/plan: the recording is the real approve core's behaviour", () => {
    it("a valid DAG produces topo-ordered inserts with the child's edge resolved to the parent's id", () => {
        const rec = runApproval({ tasksJson: JSON.stringify({ planTitle: "p", tasks: [
            { slug: "t1", title: "A", intent: "i", acceptance: ["x"] },
            { slug: "t2", title: "B", intent: "i", acceptance: ["y"], dependsOn: ["t1"] },
        ] }) });
        expect(rec.parseOk).toBe(true);
        expect(rec.inserts.map((i) => i.slug)).toEqual(["t1", "t2"]);
        expect(rec.inserts[1].dependsOn).toEqual([rec.inserts[0].id]);
        expect(failed(rec)).toEqual([]);
    });

    it("a parse-invalid draft (missing acceptance) yields NO inserts and no plan row", () => {
        const rec = runApproval({ tasksJson: JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: [] }] }) });
        expect(rec.parseOk).toBe(false);
        expect(rec.planInserted).toBe(false);
        expect(rec.inserts).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("a cyclic draft is rejected at parse — no inserts survive to be topologically wrong", () => {
        const rec = runApproval({ tasksJson: JSON.stringify({ planTitle: "p", tasks: [
            { slug: "a", title: "A", intent: "i", acceptance: ["x"], dependsOn: ["b"] },
            { slug: "b", title: "B", intent: "i", acceptance: ["x"], dependsOn: ["a"] },
        ] }) });
        expect(rec.parseOk).toBe(false);
        expect(rec.inserts).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", () => {
        const rec = runApproval({ tasksJson: JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["x"] }] }) });
        expect(runPlanInvariants(rec).map((r) => r.name).sort()).toEqual(PLAN_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/plan: negative controls — each broken recording FAILS its named invariant", () => {
    it("rows from a parse-invalid draft FAIL approve-only-valid", () => {
        const rec: PlanApprovalRecording = { unit: "plan", parseOk: false, planInserted: true, inserts: [{ id: "id-1", slug: "t1", acceptance: ["x"], dependsOn: [] }] };
        expect(failed(rec)).toContain("approve-only-valid");
    });

    it("a cyclic 'parsed ok' insert set FAILS dep-slugs-resolve-acyclic", () => {
        const rec: PlanApprovalRecording = { unit: "plan", parseOk: true, planInserted: true, inserts: [
            { id: "A", slug: "a", acceptance: ["x"], dependsOn: ["B"] },
            { id: "B", slug: "b", acceptance: ["x"], dependsOn: ["A"] },
        ] };
        expect(failed(rec)).toContain("dep-slugs-resolve-acyclic");
    });

    it("an empty-acceptance insert FAILS acceptance-mandatory-preserved", () => {
        const rec: PlanApprovalRecording = { unit: "plan", parseOk: true, planInserted: true, inserts: [{ id: "id-1", slug: "t1", acceptance: [], dependsOn: [] }] };
        expect(failed(rec)).toContain("acceptance-mandatory-preserved");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = {} as unknown as PlanApprovalRecording; // accessing .inserts throws inside predicates
        const results = runPlanInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
