// tests/verify/guards/surface.ts
// The M12 deny-fail-fast verify SURFACE. runTaskLoop has no DOM and no HTTP response — its observable
// surface is what it did (final status, terminal reason, how many iterations it burned). We drive the REAL
// runTaskLoop (it is fully DI'd) with recording fake deps that script, per iteration, exactly which
// permissions.deny keys the spawn reports and whether the gate is red / a commit landed. We then distil a
// flat GuardsRecording the invariants read. Complementary to, and separate from, the untouched M2–M11 slices.
//
// Non-circularity: each scenario DECLARES its ground truth — the per-iteration denied keys — independently of
// the loop, recorded at the spawn seam. The invariants RE-DERIVE the expected deny-wall streak from those raw
// denials (firstDenyWallIteration, an independent restatement of the rule) and compare it against the loop's
// ACTUAL escalation (status + reason + iterations run). A miss (thrash-to-cap) or a false alarm (escalating a
// deny that stopped repeating) is caught.
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TaskStatus, TokenTotals } from "../../../src/shared/types";

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

// Tiny bounds so the wall (denyWallK=3) fires well before the cap (8) and the slice runs fast.
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 2, denyWallK: 3, mergeRecycleK: 0, costCapUsd: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

export const mkProject = (): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees", setupCommand: null,
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null,
    terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
export const mkTask = (): Task => ({
    id: "t1", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null,
    createdAt: 0, updatedAt: 0,
});

// One iteration's scripted world. Defaults to the deny-fail-fast shape: RED gate, a junk commit (so the
// no-progress breaker can't pre-empt the deny breaker), no denials.
export interface GuardStep { denied?: string[]; checkGreen?: boolean; newCommit?: boolean; }
export interface GuardScenario { script: GuardStep[]; config?: Partial<LoopConfig>; }

// The flat recording the invariants read.
export interface GuardsRecording {
    unit: "guards";
    finalStatus: TaskStatus;
    terminalReason: string | null;
    iterationsRun: number;          // iterations the REAL loop actually ran (spawn calls)
    iterationCap: number;
    noProgressK: number;
    denyWallK: number;
    escalatedDenyWall: boolean;     // the terminal reason is a deny-wall escalation
    perIterationDenied: string[][]; // ground truth: what each spawned iteration reported denied (spawn seam)
}

// Drive the REAL loop over a scenario and distil the recording.
export async function runScenario(scenario: GuardScenario): Promise<GuardsRecording> {
    const config: LoopConfig = { ...TEST_CONFIG, ...scenario.config };
    const script = scenario.script;
    const perIterationDenied: string[][] = [];
    const statusCalls: { status: TaskStatus; reason: string | null }[] = [];
    let iterIdx = -1, headCalls = 0;
    let lastSha = "sha-base";
    const step = (): GuardStep => script[Math.min(iterIdx, script.length - 1)] ?? {};

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-t1",
        removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => {
            iterIdx += 1;
            const denied = step().denied ?? [];
            perIterationDenied.push(denied);
            return { ok: true, output: "did work", sessionId: `sess-${iterIdx}`, stalled: false, usage: ZERO, durationMs: null, deniedCommands: denied };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base";      // baseSha, read once before the loop
            if (step().newCommit ?? true) lastSha = `sha-${iterIdx}`; // a fresh commit → new tip (no-progress resets)
            return lastSha;
        },
        runCheck: async () => { const green = step().checkGreen ?? false; return { green, timedOut: false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, status, extra) => { statusCalls.push({ status, reason: extra?.failureReason ?? null }); },
        addIteration: () => ({ id: `it-${perIterationDenied.length}` }),
        finishIteration: () => {},
        log: () => {},
    };

    const finalStatus = await runTaskLoop(mkProject(), mkTask(), config, deps);
    const terminalReason = statusCalls[statusCalls.length - 1]?.reason ?? null;
    return {
        unit: "guards",
        finalStatus,
        terminalReason,
        iterationsRun: perIterationDenied.length,
        iterationCap: config.iterationCap,
        noProgressK: config.noProgressK,
        denyWallK: config.denyWallK,
        escalatedDenyWall: (terminalReason ?? "").startsWith("deny wall:"),
        perIterationDenied,
    };
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────────
export const WALL = "Bash:git push origin main";

const step = (denied: string[], over: Partial<GuardStep> = {}): GuardStep => ({ denied, checkGreen: false, newCommit: true, ...over });

// The pure wall: the SAME key denied every iteration with red gates + junk commits (so no-progress can't
// pre-empt). The deny breaker must fire at exactly denyWallK, well before the cap.
export const pureWall = (): GuardScenario => ({ script: Array.from({ length: 8 }, () => step([WALL])) });

// The agent ADAPTS: the same key denied twice (< denyWallK), then the deny stops and the gate goes green →
// the task merges. The streak reset means no deny-wall escalation ever fires.
export const adaptedRecovers = (): GuardScenario => ({
    script: [step([WALL]), step([WALL]), step([], { checkGreen: true })],
});

// A DIFFERENT wall each iteration — no single key repeats, so no streak accumulates. Runs to a small cap
// with no escalation (exercises the per-key reset).
export const distinctKeys = (): GuardScenario => ({
    script: [step(["Bash:a"]), step(["Bash:b"]), step(["Bash:c"]), step(["Bash:d"])],
    config: { iterationCap: 4 },
});

// No commits + a repeated deny: the no-progress breaker (K=2) fires FIRST, before the deny wall (K=3). Its
// reason must FOLD IN the denied command (the courtesy note), but it is NOT a deny-wall escalation.
export const noProgressCourtesy = (): GuardScenario => ({
    script: Array.from({ length: 8 }, () => step([WALL], { newCommit: false })),
    config: { noProgressK: 2, denyWallK: 3 },
});

// Both breakers reach threshold on the SAME iteration (noProgressK === denyWallK === 3, no commits). The deny
// wall is checked first, so its specific reason wins.
export const denyWallWinsTie = (): GuardScenario => ({
    script: Array.from({ length: 8 }, () => step([WALL], { newCommit: false })),
    config: { noProgressK: 3, denyWallK: 3 },
});
