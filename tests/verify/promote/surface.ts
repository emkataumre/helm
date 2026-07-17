// tests/verify/promote/surface.ts
// The M6-③ verify SURFACE. Drives the REAL runPromoteStage + finalizePromotion over hand-built scenarios
// (gate outcomes injected via fake deps) and distils a flat recording the invariants read. The "real unit"
// is the promote stage itself — the fake deps only stand in for git/check/setup so the scenario controls
// the gates deterministically. Complementary to, and separate from, the untouched M2 (tests/verify/),
// M3 (snapshot/, components), M4 (scheduler/), M5 (dropin/) and M6-① (reconcile/) / M6-② (hardening/) slices.
//
// Non-circularity: each scenario DECLARES its ground truth (the target branch that must never be pushed;
// the gate greens; whether there's anything to promote) independently of the stage. The invariants then
// compare the stage's ACTUAL behaviour — the real result + the real finalize pushes for positive fixtures,
// a hand-crafted broken recording for probes — against that declared ground truth. So a lie is caught.
import { runPromoteStage, finalizePromotion, type PromoteStageDeps, type FinalizeDeps } from "../../../src/main/engine/promote";
import type { Project, PromoteResult } from "../../../src/shared/types";

const INTEGRATION_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // short = abcdef012345
export const PROMOTE_BRANCH = "helm/promote-p1-abcdef012345";
export const VALIDATED_SHA = "feedface0123456789feedface0123456789feed";

export const mkProject = (promotionMode: Project["promotionMode"], over: Partial<Project> = {}): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode, jailImage: null, conductorSessionId: null, ...over,
});

// The gates the scenario controls — the deterministic stand-ins for the real git/check outcomes.
export interface Gates {
    beyond: number;            // countCommitsBeyond(origin/<target>, integration) — 0 ⇒ nothing to promote
    conflict?: boolean;        // mergeNoFf reports a conflict
    setupOk?: boolean;         // runSetup succeeds (only reached when setupCommand is set)
    checkGreen?: boolean;      // runCheck green on the fresh tip
    acceptanceGreen?: boolean; // runAcceptance ok on the fresh tip
}
export interface Scenario { project: Project; gates: Gates }

// The flat recording the invariants read: the declared ground truth + what the real stage + finalize did.
export interface PromoteRecording {
    unit: "promote";
    mode: Project["promotionMode"];
    targetBranch: string;
    outcome: PromoteResult["outcome"];
    validatedSha: string | null;
    worktreeCreated: boolean;
    beyond: number;
    checkGreen: boolean;       // the gate the scenario declared (ground truth for recheck-before-ready)
    acceptanceGreen: boolean;
    pushes: Array<{ localRef: string; remoteRef?: string }>; // every call the REAL finalize made to pushBranch
    pushedRefs: string[];      // finalize's returned helper refs
    commands: string[];        // finalize's returned printed commands
}

// Drive the REAL stage over a scenario, run the REAL finalize on a `ready`, and distil the recording.
export async function runScenario(scenario: Scenario): Promise<PromoteRecording> {
    const { project } = scenario;
    const g = { conflict: false, setupOk: true, checkGreen: true, acceptanceGreen: true, ...scenario.gates };

    let worktreeCreated = false;
    const deps: PromoteStageDeps = {
        fetchRemote: async () => {},
        countCommitsBeyond: async () => g.beyond,
        revParse: async () => INTEGRATION_SHA,
        createWorktree: async () => { worktreeCreated = true; return "/repo/.helm/worktrees/promote"; },
        mergeNoFf: async () => ({ merged: !g.conflict, conflict: g.conflict }),
        runSetup: async () => ({ ok: g.setupOk, output: g.setupOk ? "" : "setup boom" }),
        runCheck: async () => ({ green: g.checkGreen, timedOut: false, output: g.checkGreen ? "" : "check boom" }),
        runAcceptance: async () => ({ ok: g.acceptanceGreen, output: g.acceptanceGreen ? "" : "acceptance boom" }),
        removeWorktree: async () => {},
        headSha: async () => VALIDATED_SHA,
        diffStat: async () => "+9 -3",
        checkTimeoutMs: 1000,
    };
    const result = await runPromoteStage(project, deps);

    const pushes: Array<{ localRef: string; remoteRef?: string }> = [];
    let pushedRefs: string[] = [];
    let commands: string[] = [];
    if (result.outcome === "ready") {
        const finalizeDeps: FinalizeDeps = { pushBranch: async (_r, _remote, localRef, remoteRef) => { pushes.push({ localRef, remoteRef }); } };
        const f = await finalizePromotion(project, result, finalizeDeps);
        pushedRefs = f.pushedRefs;
        commands = f.commands;
    }

    return {
        unit: "promote",
        mode: project.promotionMode,
        targetBranch: project.targetBranch,
        outcome: result.outcome,
        validatedSha: result.outcome === "ready" ? result.validatedSha : null,
        worktreeCreated,
        beyond: g.beyond,
        checkGreen: g.checkGreen,
        acceptanceGreen: g.acceptanceGreen,
        pushes,
        pushedRefs,
        commands,
    };
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────
// A clean graduation in each of the three modes (all gates green, 3 commits beyond the target).
export const prReady = (): Scenario => ({ project: mkProject("pr"), gates: { beyond: 3 } });
export const directReady = (): Scenario => ({ project: mkProject("direct"), gates: { beyond: 3 } });
export const strictReady = (): Scenario => ({ project: mkProject("strict"), gates: { beyond: 3 } });
// Nothing beyond the target ⇒ nothing to promote (and NO worktree built).
export const nothingToPromote = (): Scenario => ({ project: mkProject("direct"), gates: { beyond: 0 } });
// Integration conflicts with the fresh target tip.
export const conflictScenario = (): Scenario => ({ project: mkProject("direct"), gates: { beyond: 3, conflict: true } });
// A red re-check (check or acceptance) ⇒ recheck-failed, no validated sha, no push.
export const checkRed = (): Scenario => ({ project: mkProject("direct"), gates: { beyond: 3, checkGreen: false } });
export const acceptanceRed = (): Scenario => ({ project: mkProject("direct"), gates: { beyond: 3, acceptanceGreen: false } });
