// tests/engine/promote.test.ts
// The pure project-level batch Promote stage (M6-③ Task 3), a SIBLING of runMergeStage. Prepare +
// validate a graduation of the whole integration branch on a FRESH origin/<target> tip inside a
// throwaway worktree, then hand mode-specific push + printed commands. Fully DI'd → unit-tests with
// fakes. THE non-negotiable: the tool pushes only non-protected helper branches, never the PR/target —
// finalizePromotion NEVER calls pushBranch with the target branch as its remoteRef.
import { describe, it, expect } from "vitest";
import { runPromoteStage, finalizePromotion, type PromoteStageDeps, type FinalizeDeps, type PromoteReady } from "../../src/main/engine/promote";
import type { Project } from "../../src/shared/types";

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr",
};

const INTEGRATION_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // 40-char; short = first 12
const PROMOTE_BRANCH = "helm/promote-p1-abcdef012345";

interface Recorder { calls: string[]; createFrom: string[]; countArgs: Array<[string, string]>; acceptanceCommands?: string[]; }

function fakeDeps(over: Partial<PromoteStageDeps> = {}): { deps: PromoteStageDeps; rec: Recorder } {
    const rec: Recorder = { calls: [], createFrom: [], countArgs: [] };
    const deps: PromoteStageDeps = {
        fetchRemote: async () => { rec.calls.push("fetchRemote"); },
        countCommitsBeyond: async (_r, base, tip) => { rec.calls.push("countCommitsBeyond"); rec.countArgs.push([base, tip]); return 3; },
        revParse: async () => { rec.calls.push("revParse"); return INTEGRATION_SHA; },
        createWorktree: async (_r, from) => { rec.calls.push("createWorktree"); rec.createFrom.push(from); return "/repo/.helm/worktrees/promote"; },
        mergeNoFf: async () => { rec.calls.push("mergeNoFf"); return { merged: true, conflict: false }; },
        runSetup: async () => { rec.calls.push("runSetup"); return { ok: true, output: "" }; },
        runCheck: async () => { rec.calls.push("runCheck"); return { green: true, timedOut: false, output: "" }; },
        runAcceptance: async (_wt, cmds) => { rec.calls.push("runAcceptance"); rec.acceptanceCommands = cmds; return { ok: true, output: "" }; },
        removeWorktree: async (_r, _p, _b, keepBranch) => { rec.calls.push(`removeWorktree(keep=${keepBranch})`); },
        headSha: async () => "validated-tip-sha",
        diffStat: async () => "+5 -2",
        checkTimeoutMs: 1000,
        ...over,
    };
    return { deps, rec };
}

describe("runPromoteStage", () => {
    it("nothing to promote: 0 commits beyond origin/<target> ⇒ no worktree created, no cleanup", async () => {
        const { deps, rec } = fakeDeps({ countCommitsBeyond: async () => 0 });
        const r = await runPromoteStage(PROJECT, deps);
        expect(r).toEqual({ outcome: "nothing-to-promote" });
        expect(rec.calls).toContain("fetchRemote");        // it DID refresh the target first
        expect(rec.calls).not.toContain("createWorktree"); // …but never built a worktree
        expect(rec.calls.some((c) => c.startsWith("removeWorktree"))).toBe(false);
    });

    it("counts against the FRESH origin/<target> tip and builds the worktree off it", async () => {
        const { deps, rec } = fakeDeps();
        await runPromoteStage(PROJECT, deps);
        expect(rec.countArgs[0]).toEqual(["origin/main", "integration/ralph"]);
        expect(rec.createFrom[0]).toBe("origin/main"); // off the fetched remote tip, not local
        expect(rec.calls.indexOf("fetchRemote")).toBeLessThan(rec.calls.indexOf("countCommitsBeyond"));
    });

    it("clean run ⇒ ready with the validated sha, diffstat, and the unique promote branch", async () => {
        const { deps } = fakeDeps();
        const r = await runPromoteStage(PROJECT, deps);
        expect(r).toEqual({
            outcome: "ready",
            validatedSha: "validated-tip-sha",
            diffstat: "+5 -2",
            promoteBranch: PROMOTE_BRANCH, // helm/promote-<projectId>-<integration short sha>
        });
    });

    it("re-checks in the worktree — runCheck then runAcceptance (with no per-task commands)", async () => {
        const { deps, rec } = fakeDeps();
        await runPromoteStage(PROJECT, deps);
        expect(rec.calls.indexOf("mergeNoFf")).toBeLessThan(rec.calls.indexOf("runCheck"));
        expect(rec.calls.indexOf("runCheck")).toBeLessThan(rec.calls.indexOf("runAcceptance"));
        expect(rec.acceptanceCommands).toEqual([]); // project-level promote has no per-task acceptance list
    });

    it("PROBE: a merge conflict ⇒ conflict, cleaned up (branch kept for later reaping)", async () => {
        const { deps, rec } = fakeDeps({ mergeNoFf: async () => ({ merged: false, conflict: true }) });
        const r = await runPromoteStage(PROJECT, deps);
        expect(r).toEqual({ outcome: "conflict" });
        expect(rec.calls).not.toContain("runCheck"); // bailed before re-checking
        expect(rec.calls).toContain("removeWorktree(keep=true)");
    });

    it("PROBE: a red check ⇒ recheck-failed with output, NO validated sha, worktree cleaned", async () => {
        const { deps, rec } = fakeDeps({ runCheck: async () => ({ green: false, timedOut: false, output: "tests failed" }) });
        const r = await runPromoteStage(PROJECT, deps);
        expect(r.outcome).toBe("recheck-failed");
        if (r.outcome === "recheck-failed") expect(r.output).toContain("tests failed");
        expect(rec.calls).not.toContain("runAcceptance"); // acceptance skipped once check is red
        expect(rec.calls).toContain("removeWorktree(keep=true)");
    });

    it("PROBE: a red acceptance ⇒ recheck-failed, NO validated sha", async () => {
        const { deps } = fakeDeps({ runAcceptance: async () => ({ ok: false, failedCommand: "e2e", output: "acceptance nope" }) });
        const r = await runPromoteStage(PROJECT, deps);
        expect(r.outcome).toBe("recheck-failed");
        if (r.outcome === "recheck-failed") expect(r.output).toContain("acceptance nope");
    });

    it("runs setupCommand before the re-check when set (skips it when NULL); a setup failure ⇒ recheck-failed", async () => {
        const withSetup = { ...PROJECT, setupCommand: "npm ci" };
        const { deps, rec } = fakeDeps();
        await runPromoteStage(withSetup, deps);
        expect(rec.calls.indexOf("runSetup")).toBeLessThan(rec.calls.indexOf("runCheck"));

        const { deps: d2, rec: r2 } = fakeDeps();
        await runPromoteStage(PROJECT, d2); // NULL setupCommand
        expect(r2.calls).not.toContain("runSetup");

        const { deps: d3 } = fakeDeps({ runSetup: async () => ({ ok: false, output: "ci exploded" }) });
        const r3 = await runPromoteStage(withSetup, d3);
        expect(r3.outcome).toBe("recheck-failed");
        if (r3.outcome === "recheck-failed") expect(r3.output).toContain("ci exploded");
    });

    it("always removes the throwaway worktree (keepBranch=true) even when a dep throws", async () => {
        const { deps, rec } = fakeDeps({ runCheck: async () => { throw new Error("check exploded"); } });
        await expect(runPromoteStage(PROJECT, deps)).rejects.toThrow("check exploded");
        expect(rec.calls).toContain("removeWorktree(keep=true)");
    });

    it("diffstat is measured origin/<target>..promoteBranch", async () => {
        const seen: Array<[string, string]> = [];
        const { deps } = fakeDeps({ diffStat: async (_r, base, branch) => { seen.push([base, branch]); return "+1 -0"; } });
        await runPromoteStage(PROJECT, deps);
        expect(seen[0]).toEqual(["origin/main", PROMOTE_BRANCH]);
    });
});

// ── finalizePromotion — the never-push heart ────────────────────────────────────────────────────
const READY: PromoteReady = { outcome: "ready", validatedSha: "validated-tip-sha", diffstat: "+5 -2", promoteBranch: PROMOTE_BRANCH };

function fakePush(): { deps: FinalizeDeps; pushes: Array<{ localRef: string; remoteRef?: string }> } {
    const pushes: Array<{ localRef: string; remoteRef?: string }> = [];
    const deps: FinalizeDeps = { pushBranch: async (_r, _remote, localRef, remoteRef) => { pushes.push({ localRef, remoteRef }); } };
    return { deps, pushes };
}

describe("finalizePromotion", () => {
    it("direct mode: ADVANCES the target on the click, to EXACTLY the validated sha (raw-sha, non-force)", async () => {
        const { deps, pushes } = fakePush();
        const r = await finalizePromotion({ ...PROJECT, promotionMode: "direct" }, READY, deps);
        expect(pushes).toEqual([{ localRef: "validated-tip-sha", remoteRef: "refs/heads/main" }]);
        expect(r.advancedTarget).toBe(true);
        expect(r.advancedTo).toBe("validated-tip-sha");
        expect(r.pushedRefs).toEqual([]); // no separate helper push — the target advance IS the push
        expect(r.note).toMatch(/advanced main/);
        expect(r.commands).toContain("git push origin validated-tip-sha:refs/heads/main"); // audit trail
    });

    it("direct mode: a rejected advance (e.g. the target moved) → advancedTarget=false + error, nothing lands", async () => {
        const deps: FinalizeDeps = { pushBranch: async () => { throw new Error("! [rejected] (non-fast-forward)"); } };
        const r = await finalizePromotion({ ...PROJECT, promotionMode: "direct" }, READY, deps);
        expect(r.advancedTarget).toBe(false);
        expect(r.error).toMatch(/non-fast-forward/);
        expect(r.commands).toContain("git push origin validated-tip-sha:refs/heads/main"); // handed for a retry
    });

    it("pr mode: pushes INTEGRATION (never the target) and hands a `gh pr create` command", async () => {
        const { deps, pushes } = fakePush();
        const r = await finalizePromotion({ ...PROJECT, promotionMode: "pr" }, READY, deps);
        expect(pushes).toEqual([{ localRef: "integration/ralph", remoteRef: undefined }]);
        expect(r.pushedRefs).toEqual(["integration/ralph"]);
        expect(r.advancedTarget).toBe(false);
        expect(r.commands.some((c) => /^gh pr create .*--base main .*--head integration\/ralph/.test(c))).toBe(true);
    });

    it("strict mode: pushes NOTHING and hands the full local sequence", async () => {
        const { deps, pushes } = fakePush();
        const r = await finalizePromotion({ ...PROJECT, promotionMode: "strict" }, READY, deps);
        expect(pushes).toEqual([]);
        expect(r.pushedRefs).toEqual([]);
        expect(r.advancedTarget).toBe(false);
        expect(r.commands).toEqual([
            "git fetch origin main",
            "git switch -c promote origin/main",
            "git merge --no-ff --no-edit integration/ralph",
            "npm run check",
            "git push origin promote:main",
        ]);
    });

    it("INVARIANT: the target ref is ONLY ever pushed in direct mode, and ONLY with the validated sha", async () => {
        const touchesTarget = (ref?: string) => ref === "main" || ref === "refs/heads/main";
        for (const mode of ["pr", "direct", "strict"] as const) {
            const { deps, pushes } = fakePush();
            await finalizePromotion({ ...PROJECT, promotionMode: mode }, READY, deps);
            for (const p of pushes) {
                if (touchesTarget(p.localRef) || touchesTarget(p.remoteRef)) {
                    // the only legal target push: direct mode, advancing to the validated sha
                    expect(mode).toBe("direct");
                    expect(p.localRef).toBe(READY.validatedSha);
                    expect(p.remoteRef).toBe("refs/heads/main");
                }
            }
        }
    });
});
