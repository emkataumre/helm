// tests/verify/promote/promote.test.ts
// The M6-③ verify slice's CI matrix. Positive fixtures drive the REAL runPromoteStage + finalizePromotion
// over hand-built scenarios and distil a recording; probes are hand-crafted broken recordings (negative
// controls). Asserts the three M6-③ invariants — never-push-target, promote-recheck-before-ready,
// nothing-to-promote-detected — each with a MUST-FAIL probe (the roadmap's pushes-target &
// ready-without-recheck, plus worktree-built-with-nothing-to-promote), and the per-mode command shapes.
// Vocabulary from ~/.claude/verification.md. Complementary to, and separate from, the untouched
// M2/M3/M4/M5/M6-①/M6-② slices. Runs headless under `npm run check`, zero production footprint.
import { describe, it, expect } from "vitest";
import { runPromoteFixture, runAll, type Verdict } from "./runner";
import { PROMOTE_INVARIANTS, runPromoteInvariants } from "./invariants";
import { PROMOTE_FIXTURES } from "./fixtures";
import {
    runScenario, prReady, directReady, strictReady, nothingToPromote, conflictScenario, checkRed, acceptanceRed,
    VALIDATED_SHA, type PromoteRecording,
} from "./surface";

const failed = (r: PromoteRecording) => runPromoteInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/promote: the CI matrix over every fixture", () => {
    it.each(PROMOTE_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runPromoteFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(PROMOTE_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("declares the safety probes (advances-unvalidated-ref · pr-pushes-target · ready-without-recheck)", () => {
        const probeIds = PROMOTE_FIXTURES.filter((f) => f.probe).map((f) => f.id);
        expect(probeIds).toEqual(expect.arrayContaining(["advances-unvalidated-ref", "pr-pushes-target", "ready-without-recheck"]));
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(PROMOTE_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/promote: the recording is the real stage's behaviour", () => {
    it("pr mode: pushes integration (not the target) and hands a `gh pr create` command", async () => {
        const rec = await runScenario(prReady());
        expect(rec.outcome).toBe("ready");
        expect(rec.pushes).toEqual([{ localRef: "integration/ralph", remoteRef: undefined }]);
        expect(rec.pushedRefs).toEqual(["integration/ralph"]);
        expect(rec.commands.some((c) => /^gh pr create /.test(c))).toBe(true);
        expect(failed(rec)).toEqual([]);
    });

    it("direct mode: ADVANCES the target on the click, to exactly the validated sha (refs/heads/<target>)", async () => {
        const rec = await runScenario(directReady());
        expect(rec.pushes).toEqual([{ localRef: VALIDATED_SHA, remoteRef: "refs/heads/main" }]);
        expect(rec.pushedRefs).toEqual([]); // no separate helper push — the target advance IS the push
        expect(rec.commands).toContain(`git push origin ${VALIDATED_SHA}:refs/heads/main`);
        expect(failed(rec)).toEqual([]);
    });

    it("strict mode: NO engine push (pushedRefs empty) + the full local sequence", async () => {
        const rec = await runScenario(strictReady());
        expect(rec.pushes).toEqual([]);
        expect(rec.pushedRefs).toEqual([]);
        expect(rec.commands).toEqual([
            "git fetch origin main",
            "git switch -c promote origin/main",
            "git merge --no-ff --no-edit integration/ralph",
            "npm run check",
            "git push origin promote:main",
        ]);
        expect(failed(rec)).toEqual([]);
    });

    it("nothing-to-promote: detected before any worktree is built, nothing pushed", async () => {
        const rec = await runScenario(nothingToPromote());
        expect(rec.outcome).toBe("nothing-to-promote");
        expect(rec.worktreeCreated).toBe(false);
        expect(rec.pushes).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("a conflict / a red gate ⇒ no validated sha, no push", async () => {
        for (const scenario of [conflictScenario(), checkRed(), acceptanceRed()]) {
            const rec = await runScenario(scenario);
            expect(rec.outcome).not.toBe("ready");
            expect(rec.validatedSha).toBeNull();
            expect(rec.pushes).toEqual([]);
            expect(failed(rec)).toEqual([]);
        }
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runScenario(directReady());
        expect(runPromoteInvariants(rec).map((r) => r.name).sort()).toEqual(PROMOTE_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/promote: negative controls — each broken recording FAILS its named invariant", () => {
    it("advancing the target to a non-validated branch FAILS target-advance-is-validated", () => {
        const fx = PROMOTE_FIXTURES.find((f) => f.id === "advances-unvalidated-ref");
        expect(fx?.probe && failed(fx.recording)).toContain("target-advance-is-validated");
    });
    it("pushing the target in pr mode FAILS target-advance-is-validated", () => {
        const fx = PROMOTE_FIXTURES.find((f) => f.id === "pr-pushes-target");
        expect(fx?.probe && failed(fx.recording)).toContain("target-advance-is-validated");
    });
    it("a `ready` with a red gate FAILS promote-recheck-before-ready", () => {
        const fx = PROMOTE_FIXTURES.find((f) => f.id === "ready-without-recheck");
        expect(fx?.probe && failed(fx.recording)).toContain("promote-recheck-before-ready");
    });
    it("building a worktree with nothing to promote FAILS nothing-to-promote-detected", () => {
        const fx = PROMOTE_FIXTURES.find((f) => f.id === "worktree-built-with-nothing-to-promote");
        expect(fx?.probe && failed(fx.recording)).toContain("nothing-to-promote-detected");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as PromoteRecording; // property access throws inside predicates
        const results = runPromoteInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
