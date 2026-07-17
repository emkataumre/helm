// tests/verify/promotesync/sync.test.ts
// The direct-promote LOCAL ref auto-sync verify slice (the gate proof for "Direct-promote auto-syncs
// local integration + master to fresh trunk"). Drives the REAL finalizePromotion with recording fakes
// and proves the four load-bearing behaviours:
//   1. direct advance with the integration tip UNCHANGED ⇒ integration is fast-forwarded to the
//      validated commit AND local <target> is fast-forwarded — with NO pushBranch call anywhere in the
//      sync path (the single push stays the target advance).
//   2. PROBE — the integration tip ADVANCED during the promote window (live tip != promoted tip) ⇒
//      integration is NOT moved and the skip is reported. A naive reset that orphaned the new work
//      MUST fail this probe (the fixture proves the checker catches exactly that lie).
//   3. PROBE — never-push: the sync path never calls pushBranch with ANY ref (extends the module's
//      existing target-push invariant), with a broken recording proving the checker can catch a push.
//   4. pr and strict modes perform NO sync — they advance no target, so nothing may move locally.
// Vocabulary from ~/.claude/verification.md: every unit gets a probe; a skipped check is never a pass.
// Complementary to, and separate from, the untouched tests/engine/promote.test.ts and
// tests/verify/promote/ slices. Runs headless under `npm run check`, zero production footprint.
import { describe, it, expect } from "vitest";
import { finalizePromotion, type FinalizeDeps, type PromoteReady } from "../../../src/main/engine/promote";
import type { Project } from "../../../src/shared/types";

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "direct", jailImage: null, conductorSessionId: null,
};

const INTEGRATION_TIP = "1111111111111111111111111111111111111111"; // the tip that was merged + validated
const MOVED_TIP = "9999999999999999999999999999999999999999";       // a merge landed during the promote window
const VALIDATED_SHA = "2222222222222222222222222222222222222222";   // the re-checked --no-ff merge commit
const READY: PromoteReady = {
    outcome: "ready", validatedSha: VALIDATED_SHA, diffstat: "+5 -2",
    promoteBranch: "helm/promote-p1-111111111111", integrationTip: INTEGRATION_TIP,
};

interface Push { localRef: string; remoteRef?: string }
interface Rec {
    pushes: Push[];                                   // EVERY pushBranch call, sync path included
    reads: string[];                                  // live-tip reads (the reset guard)
    moves: Array<{ branch: string; toSha: string }>;  // ffLocalRef calls that actually moved a ref
}

// Recording fakes over the full FinalizeDeps surface. liveIntegrationTip simulates what the repo's
// integration ref points at WHEN finalize looks (the promote window may have moved it); ffRefuses
// makes a branch's fast-forward fail with a reason (dirty/diverged working copy).
function fakeDeps(over: { liveIntegrationTip?: string | null; ffRefuses?: Record<string, string>; pushThrows?: boolean } = {}) {
    const rec: Rec = { pushes: [], reads: [], moves: [] };
    const deps: FinalizeDeps = {
        pushBranch: async (_repo, _remote, localRef, remoteRef) => {
            rec.pushes.push({ localRef, remoteRef });
            if (over.pushThrows) throw new Error("! [rejected] (non-fast-forward)");
        },
        readLocalRef: async (_repo, ref) => {
            rec.reads.push(ref);
            return over.liveIntegrationTip !== undefined ? over.liveIntegrationTip : INTEGRATION_TIP;
        },
        ffLocalRef: async (_repo, branch, toSha) => {
            const reason = over.ffRefuses?.[branch];
            if (reason) return { ok: false, reason };
            rec.moves.push({ branch, toSha });
            return { ok: true };
        },
    };
    return { deps, rec };
}

// The never-push invariant over a recording: the ONLY legal push in a direct finalize is the single
// target advance (validatedSha → refs/heads/<target>). Anything else — any second push, any sync-path
// push of integration/target/any ref — violates it.
const onlyTargetAdvancePushed = (pushes: Push[]): boolean =>
    pushes.length === 1 && pushes[0].localRef === VALIDATED_SHA && pushes[0].remoteRef === "refs/heads/main";

describe("verify/promotesync: direct advance with the integration tip unchanged", () => {
    it("fast-forwards integration AND local target to the validated commit — sync reported on the result", async () => {
        const { deps, rec } = fakeDeps();
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(r.advancedTarget).toBe(true);
        expect(rec.moves).toEqual([
            { branch: "integration/ralph", toSha: VALIDATED_SHA },
            { branch: "main", toSha: VALIDATED_SHA },
        ]);
        expect(r.sync?.integration.reset).toBe(true);
        expect(r.sync?.localTarget.fastForwarded).toBe(true);
    });

    it("the sync path performs NO push — the single push stays the target advance", async () => {
        const { deps, rec } = fakeDeps();
        await finalizePromotion(PROJECT, READY, deps);
        expect(onlyTargetAdvancePushed(rec.pushes)).toBe(true);
    });

    it("the reset guard READ the live integration tip before moving anything", async () => {
        const { deps, rec } = fakeDeps();
        await finalizePromotion(PROJECT, READY, deps);
        expect(rec.reads).toContain("integration/ralph");
    });

    it("best-effort local target: a refused fast-forward (dirty working copy) is skipped with the reason — integration still resets", async () => {
        const { deps, rec } = fakeDeps({ ffRefuses: { main: "main is checked out with uncommitted changes" } });
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(r.sync?.integration.reset).toBe(true);
        expect(r.sync?.localTarget.fastForwarded).toBe(false);
        expect(r.sync?.localTarget.note).toContain("uncommitted changes");
        expect(rec.moves).toEqual([{ branch: "integration/ralph", toSha: VALIDATED_SHA }]); // main never moved
    });
});

describe("verify/promotesync: PROBE — the integration tip ADVANCED during the promote window", () => {
    it("integration is NOT moved (a naive reset would orphan the new merge) and the skip is reported", async () => {
        const { deps, rec } = fakeDeps({ liveIntegrationTip: MOVED_TIP });
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(r.advancedTarget).toBe(true); // the target advance itself is unaffected
        // THE probe: any ffLocalRef call against integration here IS the orphaning bug.
        expect(rec.moves.some((m) => m.branch === "integration/ralph")).toBe(false);
        expect(r.sync?.integration.reset).toBe(false);
        expect(r.sync?.integration.note).toMatch(/left ahead|moved during/);
        // local target sync is independent of the guard — it still fast-forwards.
        expect(r.sync?.localTarget.fastForwarded).toBe(true);
    });

    it("an unreadable live tip (readLocalRef → null) also refuses the reset — couldn't check ≠ safe to move", async () => {
        const { deps, rec } = fakeDeps({ liveIntegrationTip: null });
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(rec.moves.some((m) => m.branch === "integration/ralph")).toBe(false);
        expect(r.sync?.integration.reset).toBe(false);
    });

    it("a ready WITHOUT the promoted tip threaded through refuses the reset (cannot prove a fast-forward)", async () => {
        const { deps, rec } = fakeDeps();
        const { integrationTip: _omitted, ...bare } = READY;
        const r = await finalizePromotion(PROJECT, bare as PromoteReady, deps);
        expect(rec.moves.some((m) => m.branch === "integration/ralph")).toBe(false);
        expect(r.sync?.integration.reset).toBe(false);
    });

    it("NEGATIVE CONTROL: a naive always-reset recording FAILS the probe's own assertion", () => {
        // What the orphaning bug would record: integration moved even though the live tip differed.
        const naive = [{ branch: "integration/ralph", toSha: VALIDATED_SHA }];
        expect(naive.some((m) => m.branch === "integration/ralph")).toBe(true); // the probe would catch it
    });
});

describe("verify/promotesync: PROBE — never-push across the sync path", () => {
    it("the whole direct finalize (advance + sync) pushes EXACTLY once: the target advance", async () => {
        const { deps, rec } = fakeDeps();
        await finalizePromotion(PROJECT, READY, deps);
        expect(rec.pushes).toEqual([{ localRef: VALIDATED_SHA, remoteRef: "refs/heads/main" }]);
    });

    it("NEGATIVE CONTROL: a recording where the sync pushed a ref FAILS the invariant", () => {
        const legal: Push[] = [{ localRef: VALIDATED_SHA, remoteRef: "refs/heads/main" }];
        expect(onlyTargetAdvancePushed(legal)).toBe(true);
        // a sync that pushed integration — the exact violation the invariant exists to catch
        expect(onlyTargetAdvancePushed([...legal, { localRef: "integration/ralph" }])).toBe(false);
        // a sync that pushed the local target — same violation, different ref
        expect(onlyTargetAdvancePushed([...legal, { localRef: "main", remoteRef: "refs/heads/main" }])).toBe(false);
    });

    it("a FAILED advance performs NO sync at all — nothing read, nothing moved", async () => {
        const { deps, rec } = fakeDeps({ pushThrows: true });
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(r.advancedTarget).toBe(false);
        expect(r.sync).toBeUndefined();
        expect(rec.reads).toEqual([]);
        expect(rec.moves).toEqual([]);
    });

    it("absent sync seams (legacy deps: pushBranch only) skip the sync, never the advance", async () => {
        const pushes: Push[] = [];
        const deps: FinalizeDeps = { pushBranch: async (_r, _rem, localRef, remoteRef) => { pushes.push({ localRef, remoteRef }); } };
        const r = await finalizePromotion(PROJECT, READY, deps);
        expect(r.advancedTarget).toBe(true);
        expect(r.sync).toBeUndefined();
        expect(onlyTargetAdvancePushed(pushes)).toBe(true);
    });
});

describe("verify/promotesync: pr and strict modes perform NO sync (they advance no target)", () => {
    it.each(["pr", "strict"] as const)("%s mode: no live-tip read, no local ref move, no sync on the result", async (mode) => {
        const { deps, rec } = fakeDeps();
        const r = await finalizePromotion({ ...PROJECT, promotionMode: mode }, READY, deps);
        expect(r.advancedTarget).toBe(false);
        expect(r.sync).toBeUndefined();
        expect(rec.reads).toEqual([]);
        expect(rec.moves).toEqual([]);
        // and the mode's push shape is unchanged: pr pushes integration (a helper), strict pushes nothing
        if (mode === "pr") expect(rec.pushes).toEqual([{ localRef: "integration/ralph", remoteRef: undefined }]);
        else expect(rec.pushes).toEqual([]);
    });
});
