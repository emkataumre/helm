// tests/verify/failures/failures.test.ts
// The M17 verify slice's CI matrix. The positive fixture drives the REAL kernel — the real
// migrate/updateTask chokepoint over a temp sqlite DB, the real runTaskLoop + runMergeStage into every
// headless-reachable terminal wall (recording the kind that arrives at setStatus), and the real ctl
// dispatcher with a DB-backed failures action — and distils a recording; probes are hand-crafted broken
// recordings (negative controls). Asserts the five invariants — ledger-append-on-every-needs-human,
// resolution-stamped-on-terminal-success, kind-faithful, ledger-survives-recovery,
// failures-verb-is-readonly — each with a probe that MUST FAIL. Vocabulary from ~/.claude/verification.md.
// The boot-reconcile apply site (ipc.ts, Electron-bound) stays manual acceptance, like the rest of the
// reconcile wiring.
import { describe, it, expect } from "vitest";
import { runFailuresFixture, runAll, type Verdict } from "./runner";
import { FAILURES_INVARIANTS, runFailuresInvariants } from "./invariants";
import { FAILURES_FIXTURES } from "./fixtures";
import { runFailuresScenario, BASELINE, type FailuresRecording } from "./surface";
import { parseCliArgs } from "../../../src/main/ctl/protocol";
import { openDb } from "../../../src/main/db/db";
import { insertTask, updateTask } from "../../../src/main/db/tasks";
import { listFailures, summarizeFailures } from "../../../src/main/db/failures";

const failed = (r: FailuresRecording) => runFailuresInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/failures: the CI matrix over every fixture", () => {
    it.each(FAILURES_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runFailuresFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FAILURES_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("has a probe for EVERY declared invariant (each must be catchable)", () => {
        const covered = new Set(FAILURES_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(FAILURES_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(FAILURES_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/failures: the recording is the real kernel's behaviour", () => {
    it("the real kernel run satisfies all five invariants", async () => {
        expect(failed(await runFailuresScenario())).toEqual([]);
    });

    it("every headless engine wall records its faithful kind (the full site list ran)", async () => {
        const rec = await runFailuresScenario();
        expect(rec.kinds.length).toBeGreaterThanOrEqual(12);
        for (const k of rec.kinds) expect(k.recorded, `site ${k.site}`).toBe(k.expected);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        expect(runFailuresInvariants(await runFailuresScenario()).map((r) => r.name).sort())
            .toEqual(FAILURES_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/failures: negative controls — each broken recording FAILS its named invariant", () => {
    it("a needs-human write with no ledger row FAILS ledger-append-on-every-needs-human", () => {
        expect(failed({ ...BASELINE, openRowsAfterWrites: 3 })).toContain("ledger-append-on-every-needs-human");
    });
    it("a note-less write recorded under a made-up kind FAILS ledger-append-on-every-needs-human", () => {
        expect(failed({ ...BASELINE, noteLessKind: "merge-conflict" })).toContain("ledger-append-on-every-needs-human");
    });
    it("a merged task leaving an open row FAILS resolution-stamped-on-terminal-success", () => {
        expect(failed({ ...BASELINE, merged: { open: 1, resolved: 0 } })).toContain("resolution-stamped-on-terminal-success");
    });
    it("a requeue that stamped rows FAILS resolution-stamped-on-terminal-success", () => {
        expect(failed({ ...BASELINE, requeueStampedRows: 1 })).toContain("resolution-stamped-on-terminal-success");
    });
    it("a merge conflict logged as cost-cap FAILS kind-faithful", () => {
        expect(failed({ ...BASELINE, kinds: [{ site: "merge", expected: "merge-conflict", recorded: "cost-cap" }] })).toContain("kind-faithful");
    });
    it("a row cleared after recovery FAILS ledger-survives-recovery", () => {
        expect(failed({ ...BASELINE, recovery: { taskFailureReason: null, ledgerReason: null, ledgerResolution: null } })).toContain("ledger-survives-recovery");
    });
    it("a mutating failures verb FAILS failures-verb-is-readonly", () => {
        expect(failed({ ...BASELINE, dbChangedByVerb: true })).toContain("failures-verb-is-readonly");
    });
    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as FailuresRecording; // property access throws inside predicates
        const results = runFailuresInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});

describe("verify/failures: the ledger's DB reads + the CLI grammar", () => {
    it("listFailures filters by open/kind and summarizeFailures rolls up by kind with open counts", () => {
        const db = openDb(":memory:");
        const t = insertTask(db, { projectId: "p9", title: "T", intent: "x", acceptance: ["a"] });
        updateTask(db, t.id, { status: "needs-human", failureReason: "merge conflict", failure: { kind: "merge-conflict", iterationIndex: 0 } });
        updateTask(db, t.id, { status: "queued" });
        updateTask(db, t.id, { status: "needs-human", failureReason: "merge conflict again", failure: { kind: "merge-conflict", iterationIndex: 2 } });
        const t2 = insertTask(db, { projectId: "p9", title: "T2", intent: "x", acceptance: ["a"] });
        updateTask(db, t2.id, { status: "needs-human", failureReason: "cost cap reached", failure: { kind: "cost-cap", iterationIndex: 1 } });
        updateTask(db, t2.id, { status: "merged", failureReason: null });

        expect(listFailures(db)).toHaveLength(3);
        expect(listFailures(db, { open: true })).toHaveLength(2);                       // t2's row was resolved
        expect(listFailures(db, { kind: "merge-conflict" })).toHaveLength(2);
        expect(listFailures(db, { projectId: "p9" })).toHaveLength(3);
        expect(listFailures(db, { projectId: "elsewhere" })).toHaveLength(0);
        expect(summarizeFailures(db)).toEqual([
            { kind: "merge-conflict", total: 2, open: 2 },
            { kind: "cost-cap", total: 1, open: 0 },
        ]);
        db.close();
    });

    it("the CLI grammar parses `helm failures` with its flags (and the flags are optional)", () => {
        expect(parseCliArgs(["failures"])).toEqual({ ok: true, request: { verb: "failures", args: {} } });
        expect(parseCliArgs(["failures", "--open", "--kind", "merge-conflict", "--project", "helm"]))
            .toEqual({ ok: true, request: { verb: "failures", args: { project: "helm", open: "true", kind: "merge-conflict" } } });
        expect(parseCliArgs(["failures", "--all"])).toEqual({ ok: true, request: { verb: "failures", args: { all: "true" } } });
    });
});
