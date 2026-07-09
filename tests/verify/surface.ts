// tests/verify/surface.ts
// The machine-readable SURFACE for the runTaskLoop verifiable unit. runTaskLoop has no DOM and
// no HTTP response — its observable surface is what it did to its dependencies. We drive the
// REAL function with recording fake deps (it is fully DI'd), capture every consequential call,
// then distill the run into one flat Snapshot. Verifiers read the Snapshot, never internals.
import type { RunTaskDeps, IterationVerdict } from "../../src/main/engine/runTask";
import type { LoopConfig } from "../../src/main/engine/loopConfig";
import type { Project, Task, TaskStatus } from "../../src/shared/types";

export const PROJECT: Project = { id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null };
export const TASK: Task = { id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null, dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0 };

// Tiny bounds so probes (cap, no-progress) run fast and deterministically.
export const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 2, denyWallK: 3, costCapUsd: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

// One iteration's scripted world. Everything defaults to the green path; a step bends only what it must.
export interface IterStep { agentOk?: boolean; stalled?: boolean; checkGreen?: boolean; checkTimedOut?: boolean; acceptanceOk?: boolean; newCommit?: boolean; }
export interface DepConfig { script?: IterStep[]; mergeConflict?: boolean; acceptance?: string[]; config?: Partial<LoopConfig>; }

interface Recording {
    statusCalls: { status: TaskStatus; extra?: { diffstat?: string; failureReason?: string | null } }[];
    removeCalls: { keepBranch: boolean }[];
    mergeResults: { merged: boolean; conflict: boolean }[];
    finishCalls: { gateVerdict: IterationVerdict }[];
    iterationsAdded: number;
    greenGateAtMerge: boolean | null;
    acceptanceGreenAtMerge: boolean;
    anyStall: boolean;
    sessionIds: (string | null)[];
}

export interface Snapshot {
    unit: "runTaskLoop";
    finalStatus: TaskStatus;
    iterationsRun: number;
    iterationsFinished: number;
    squashMergeApplied: boolean;
    mergeApplications: number;
    mergedWithoutGreenGate: boolean;
    acceptanceRanGreenBeforeMerge: boolean;
    capRespected: boolean;
    stallDetectedAndRecycled: boolean;
    noProgressBailed: boolean;
    worktreeRemoved: boolean;
    branchKept: boolean;
    diffstatRecorded: boolean;
    failureReasonSet: boolean;
    terminalReason: string | null;
    sessionIdsCaptured: boolean;
    config: LoopConfig;
}

export function buildRecordingDeps(config: DepConfig = {}): { deps: RunTaskDeps; recording: Recording; loopConfig: LoopConfig } {
    const script = config.script ?? [{}];
    const loopConfig: LoopConfig = { ...TEST_CONFIG, ...config.config };
    const rec: Recording = { statusCalls: [], removeCalls: [], mergeResults: [], finishCalls: [], iterationsAdded: 0, greenGateAtMerge: null, acceptanceGreenAtMerge: false, anyStall: false, sessionIds: [] };

    let iterIdx = -1, headCalls = 0;
    let lastSha = "sha-base";
    let lastGateAllGreen = false;
    const step = (): IterStep => script[Math.min(iterIdx, script.length - 1)] ?? {};

    const deps: RunTaskDeps = {
        ensureBranch: async () => {},
        checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-abc",
        removeWorktree: async (_r, _p, _b, keepBranch) => { rec.removeCalls.push({ keepBranch }); },
        ensureRalphExcluded: () => {},
        writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }), // M2 PROJECT has no setupCommand → never called; stub keeps the slice compiling
        spawnAgent: async () => {
            iterIdx += 1;
            const s = step();
            const stalled = s.stalled ?? false;
            const ok = (s.agentOk ?? true) && !stalled;
            if (stalled) rec.anyStall = true;
            lastGateAllGreen = ok && (s.checkGreen ?? true) && (s.acceptanceOk ?? true);
            const sessionId = `sess-${iterIdx}`;
            rec.sessionIds.push(sessionId);
            // M3 widened SpawnResult with usage/durationMs; the M2 slice doesn't observe tokens, so a zeroed stub keeps its behaviour identical.
            return { ok, output: ok ? "did work" : "agent failed", sessionId, stalled, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 }, durationMs: null };
        },
        commitAll: async () => {},
        headSha: async () => {
            if (headCalls++ === 0) return "sha-base";
            const s = step();
            if (s.newCommit ?? true) lastSha = `sha-${iterIdx}`;
            return lastSha;
        },
        runCheck: async () => { const s = step(); const green = s.checkGreen ?? true; return { green, timedOut: s.checkTimedOut ?? false, output: green ? "" : "check failed" }; },
        runAcceptance: async () => { const s = step(); const ok = s.acceptanceOk ?? true; return { ok, failedCommand: ok ? undefined : "acc-cmd", output: ok ? "" : "acceptance failed" }; },
        squashMergeInto: async () => ({ merged: !config.mergeConflict, conflict: Boolean(config.mergeConflict) }),
        diffStat: async () => "+1 -0",
        // M4: the loop delegates landing to mergeStage (the real wiring wraps it in the merge mutex).
        // The M2 loop-safety slice keeps its green-merge recording here — it records the merge and
        // returns merged (or needs-human on the merge-conflict fixture), so the slice's behaviour is
        // unchanged. greenGateAtMerge captures whether the gate was green when landing was attempted.
        mergeStage: async () => {
            rec.greenGateAtMerge = lastGateAllGreen;
            rec.acceptanceGreenAtMerge = lastGateAllGreen;
            if (config.mergeConflict) return { outcome: "needs-human", reason: "merge conflict" };
            rec.mergeResults.push({ merged: true, conflict: false });
            return { outcome: "merged", diffstat: "+1 -0" };
        },
        setStatus: (_id, status, extra) => { rec.statusCalls.push({ status, extra }); },
        addIteration: () => { rec.iterationsAdded += 1; return { id: `it-${rec.iterationsAdded}` }; },
        finishIteration: (_id, patch) => { rec.finishCalls.push({ gateVerdict: patch.gateVerdict }); },
        log: () => {},
    };
    return { deps, recording: rec, loopConfig };
}

export function buildSnapshot(rec: Recording, finalStatus: TaskStatus, loopConfig: LoopConfig): Snapshot {
    const mergeApplications = rec.mergeResults.filter((m) => m.merged && !m.conflict).length;
    const squashMergeApplied = mergeApplications > 0;
    const lastStatus = rec.statusCalls[rec.statusCalls.length - 1];
    const terminalReason = lastStatus?.extra?.failureReason ?? null;
    return {
        unit: "runTaskLoop",
        finalStatus,
        iterationsRun: rec.iterationsAdded,
        iterationsFinished: rec.finishCalls.filter((c) => Boolean(c.gateVerdict)).length,
        squashMergeApplied,
        mergeApplications,
        mergedWithoutGreenGate: squashMergeApplied && rec.greenGateAtMerge === false,
        acceptanceRanGreenBeforeMerge: squashMergeApplied ? rec.acceptanceGreenAtMerge : true,
        capRespected: rec.iterationsAdded <= loopConfig.iterationCap,
        stallDetectedAndRecycled: rec.anyStall,
        noProgressBailed: terminalReason?.includes("no progress") ?? false,
        worktreeRemoved: rec.removeCalls.length > 0,
        branchKept: rec.removeCalls.some((c) => c.keepBranch === true),
        diffstatRecorded: rec.statusCalls.some((c) => c.extra?.diffstat != null),
        failureReasonSet: rec.statusCalls.some((c) => c.extra?.failureReason != null),
        terminalReason,
        sessionIdsCaptured: rec.sessionIds.length === rec.finishCalls.length && rec.sessionIds.every((s) => typeof s === "string" && s.length > 0),
        config: loopConfig,
    };
}
