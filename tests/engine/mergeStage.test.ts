// tests/engine/mergeStage.test.ts
// The isolated merge stage: squash the task branch onto a FRESH integration tip in a throwaway
// worktree, re-run check ∧ acceptance there, advance integration only on a green re-check, and ALWAYS
// clean up. Driven with fake deps (it is fully DI'd) so it stays Electron-free and unit-testable.
import { describe, it, expect } from "vitest";
import { runMergeStage, type MergeStageDeps } from "../../src/main/engine/mergeStage";
import type { Project, Task, SnapshotEvent } from "../../src/shared/types";

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
};
const TASK: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "running", scopeHint: null, dependsOn: [], planId: null,
    branchName: "ralph/task-abc", worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

function fakeDeps(over: Partial<MergeStageDeps> = {}): { deps: MergeStageDeps; calls: string[]; emits: string[] } {
    const calls: string[] = [];
    const emits: string[] = [];
    const deps: MergeStageDeps = {
        createWorktree: async () => { calls.push("createWorktree"); return "/repo/.helm/worktrees/helm-merge-abc"; },
        squashMergeInto: async () => { calls.push("squashMergeInto"); return { merged: true, conflict: false }; },
        runSetup: async () => { calls.push("runSetup"); return { ok: true, output: "" }; },
        runCheck: async () => { calls.push("runCheck"); return { green: true, timedOut: false, output: "" }; },
        runAcceptance: async () => { calls.push("runAcceptance"); return { ok: true, output: "" }; },
        removeWorktree: async () => { calls.push("removeWorktree"); },
        diffStat: async () => { calls.push("diffStat"); return "+3 -1"; },
        advanceBranch: async () => { calls.push("advanceBranch"); },
        headSha: async () => "merge-tip-sha",
        checkTimeoutMs: 1000,
        emit: (e: SnapshotEvent) => { if (e.type === "gate") emits.push(e.label); },
        ...over,
    };
    return { deps, calls, emits };
}

describe("runMergeStage", () => {
    it("clean run: advances integration once and returns merged + diffstat", async () => {
        const { deps, calls } = fakeDeps();
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r).toEqual({ outcome: "merged", diffstat: "+3 -1" });
        expect(calls.filter((c) => c === "advanceBranch")).toHaveLength(1);
        expect(calls).toContain("removeWorktree");
    });

    it("PROBE: a merge conflict → needs-human, integration NOT advanced", async () => {
        const { deps, calls } = fakeDeps({ squashMergeInto: async () => ({ merged: false, conflict: true }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r).toEqual({ outcome: "needs-human", reason: "merge conflict", kind: "merge-conflict" });
        expect(calls).not.toContain("advanceBranch");
        expect(calls).toContain("removeWorktree"); // still cleaned up
    });

    it("PROBE: a failing re-check (check red) → needs-human, integration NOT advanced", async () => {
        const { deps, calls } = fakeDeps({ runCheck: async () => ({ green: false, timedOut: false, output: "boom" }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        if (r.outcome === "needs-human") expect(r.reason).toContain("re-check failed after rebase on integration tip");
        expect(calls).not.toContain("advanceBranch");
        expect(calls).not.toContain("runAcceptance"); // acceptance is skipped once the check is red
    });

    it("PROBE: a failing re-check (acceptance red) → needs-human, integration NOT advanced", async () => {
        const { deps, calls } = fakeDeps({ runAcceptance: async () => ({ ok: false, failedCommand: "x", output: "nope" }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        expect(calls).not.toContain("advanceBranch");
    });

    // OBSERVABILITY: the needs-human reason must carry the evidence, not a bare fixed string — a
    // cold-cache test flake took two incidents to diagnose because the re-check discarded its output
    // (and a timeout was indistinguishable from a red check). Prefix stays stable for existing matchers.
    it("a red re-check carries the check output tail in the needs-human reason", async () => {
        const { deps } = fakeDeps({ runCheck: async () => ({ green: false, timedOut: false, output: "Exceeded timeout of 5000 ms\nFAIL __tests__/result.test.tsx" }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        if (r.outcome === "needs-human") {
            expect(r.reason).toContain("re-check failed after rebase on integration tip");
            expect(r.reason).toContain("FAIL __tests__/result.test.tsx"); // the evidence rides along
        }
    });

    it("a timed-out re-check names the timeout — not indistinguishable from a red check", async () => {
        const { deps } = fakeDeps({ runCheck: async () => ({ green: false, timedOut: true, output: "" }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        if (r.outcome === "needs-human") expect(r.reason).toMatch(/timed out \(1000ms\)/);
    });

    it("a red acceptance names the failed command and carries its output tail", async () => {
        const { deps } = fakeDeps({ runAcceptance: async () => ({ ok: false, failedCommand: "npm run e2e", output: "expected 3 bins, got 0" }) });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        if (r.outcome === "needs-human") {
            expect(r.reason).toContain("npm run e2e");
            expect(r.reason).toContain("expected 3 bins, got 0");
        }
    });

    it("removes the throwaway worktree even when an injected dep throws (finally cleanup)", async () => {
        const { deps, calls } = fakeDeps({ runCheck: async () => { throw new Error("check exploded"); } });
        await expect(runMergeStage(PROJECT, TASK, "ralph/task-abc", deps)).rejects.toThrow("check exploded");
        expect(calls).toContain("removeWorktree"); // cleanup ran despite the throw
        expect(calls).not.toContain("advanceBranch");
    });

    it("HARDENING: a cleanup FAILURE does NOT wedge the stage — still returns merged (integration already advanced)", async () => {
        // The wedge that stranded a task in "running": the merge advanced integration, then the throwaway
        // removal threw ("Filename too long") in the finally, overriding the return and rejecting the stage.
        const { deps, calls } = fakeDeps({ removeWorktree: async () => { throw new Error("fatal: Filename too long"); } });
        const r = await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(r).toEqual({ outcome: "merged", diffstat: "+3 -1" }); // the cleanup throw is swallowed
        expect(calls).toContain("advanceBranch");
    });

    it("runs setupCommand before the re-check when set, and skips it when NULL", async () => {
        const withSetup = { ...PROJECT, setupCommand: "npm ci" };
        const { deps, calls } = fakeDeps();
        await runMergeStage(withSetup, TASK, "ralph/task-abc", deps);
        expect(calls.indexOf("runSetup")).toBeLessThan(calls.indexOf("runCheck"));

        const { deps: deps2, calls: calls2 } = fakeDeps();
        await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps2); // NULL setupCommand
        expect(calls2).not.toContain("runSetup");
    });

    it("a setupCommand failure in the fresh worktree → needs-human, NOT advanced", async () => {
        const withSetup = { ...PROJECT, setupCommand: "npm ci" };
        const { deps, calls } = fakeDeps({ runSetup: async () => ({ ok: false, output: "ci exploded" }) });
        const r = await runMergeStage(withSetup, TASK, "ralph/task-abc", deps);
        expect(r.outcome).toBe("needs-human");
        if (r.outcome === "needs-human") expect(r.reason).toContain("merge setup failed");
        expect(calls).not.toContain("advanceBranch");
    });

    it("emits the gate sequence for a green merge", async () => {
        const { deps, emits } = fakeDeps();
        await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(emits).toEqual(["merge: merging", "merge re-check: running", "merge re-check: passed", "merge: merged"]);
    });

    it("emits the gate sequence ending in re-check failed for a red re-check", async () => {
        const { deps, emits } = fakeDeps({ runCheck: async () => ({ green: false, timedOut: false, output: "x" }) });
        await runMergeStage(PROJECT, TASK, "ralph/task-abc", deps);
        expect(emits).toEqual(["merge: merging", "merge re-check: running", "merge re-check: failed"]);
    });
});
