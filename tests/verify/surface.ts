// tests/verify/surface.ts
// The machine-readable SURFACE for the runTaskSinglePass verifiable unit.
//
// Per ~/.claude/verification.md, a Desktop/engine unit exposes "a structured status
// object". runTaskSinglePass has no DOM and no HTTP response — its observable surface is
// *what it did to its dependencies*. So we drive the REAL function with a recording set of
// RunTaskDeps (it is already fully DI'd), capture every consequential call, then distill
// the run into one flat, machine-readable Snapshot. Verifiers read the Snapshot, never the
// engine's internals — rewrite runTask.ts freely and these checks still hold as long as the
// contract does. Lives under tests/ → zero production footprint.
import type { RunTaskDeps } from "../../src/main/engine/runTask";
import type { Project, Task, TaskStatus } from "../../src/shared/types";

// A fixed, known project + task to mount the unit against (mirrors tests/engine/runTask.test.ts).
export const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
};
export const TASK: Task = {
    id: "abc", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued",
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

// How a fixture configures the world the unit runs in. Everything has a green-path default,
// so a probe only states the one or two things it bends.
export interface DepConfig {
    agent?: { ok?: boolean; output?: string };
    check?: { green?: boolean; timedOut?: boolean; output?: string };
    merge?: { merged?: boolean; conflict?: boolean };
}

interface StatusCall { status: TaskStatus; extra?: { diffstat?: string; failureReason?: string } }
interface RemoveCall { keepBranch: boolean }
interface MergeResult { merged: boolean; conflict: boolean }
interface FinishCall { gateVerdict: "green" | "failed" | "hang" }

// The raw recording — what actually happened during a run, before distillation.
export interface Recording {
    statusCalls: StatusCall[];
    removeCalls: RemoveCall[];
    mergeResults: MergeResult[];
    finishCalls: FinishCall[];
    iterationsAdded: number;
    agentOk: boolean;
    checkRan: boolean;
    checkGreen: boolean;
}

// The distilled, machine-readable surface a verifier reads. Flat and boolean-heavy on purpose.
export interface Snapshot {
    unit: "runTaskSinglePass";
    finalStatus: TaskStatus;
    gateVerdict: "green" | "failed" | "hang" | null; // verdict the gate recorded on the iteration
    squashMergeApplied: boolean;      // a squash-merge actually landed (merged && !conflict)
    mergedWithoutGreenGate: boolean;  // a merge landed WITHOUT agent-ok && check-green — must never be true
    worktreeRemoved: boolean;         // the worktree was torn down, win or lose
    branchKept: boolean;              // removeWorktree(keepBranch=true) — branch retained for a human
    diffstatRecorded: boolean;        // a diffstat was persisted via setStatus
    failureReasonSet: boolean;        // a failureReason was persisted via setStatus
    iterationsAdded: number;          // how many iteration rows were opened
    iterationsFinished: number;       // how many were closed with a gate verdict
}

export function buildRecordingDeps(config: DepConfig = {}): { deps: RunTaskDeps; recording: Recording } {
    const recording: Recording = {
        statusCalls: [], removeCalls: [], mergeResults: [], finishCalls: [],
        iterationsAdded: 0, agentOk: false, checkRan: false, checkGreen: false,
    };

    const agentOk = config.agent?.ok ?? true;
    const agentOutput = config.agent?.output ?? "ok";
    const checkGreen = config.check?.green ?? true;
    const checkTimedOut = config.check?.timedOut ?? false;
    const checkOutput = config.check?.output ?? "";
    const mergeMerged = config.merge?.merged ?? true;
    const mergeConflict = config.merge?.conflict ?? false;

    const deps: RunTaskDeps = {
        ensureBranch: async () => {},
        checkoutBranch: async () => {},
        createWorktree: async () => "/repo/.helm/worktrees/ralph-task-abc",
        removeWorktree: async (_r, _p, _b, keepBranch) => { recording.removeCalls.push({ keepBranch }); },
        ensureRalphExcluded: () => {},
        writeRalphFiles: () => {},
        spawnAgent: async () => { recording.agentOk = agentOk; return { ok: agentOk, output: agentOutput, sessionId: null, stalled: false }; },
        commitAll: async () => {},
        headSha: async () => "sha",
        runCheck: async () => {
            recording.checkRan = true;
            recording.checkGreen = checkGreen;
            return { green: checkGreen, timedOut: checkTimedOut, output: checkOutput };
        },
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => { const r = { merged: mergeMerged, conflict: mergeConflict }; recording.mergeResults.push(r); return r; },
        diffStat: async () => "+1 -0",
        setStatus: (_id, status, extra) => { recording.statusCalls.push({ status, extra }); },
        addIteration: () => { recording.iterationsAdded += 1; return { id: "it1" }; },
        finishIteration: (_id, patch) => { recording.finishCalls.push({ gateVerdict: patch.gateVerdict }); },
        log: () => {},
    };
    return { deps, recording };
}

export function buildSnapshot(rec: Recording, finalStatus: TaskStatus): Snapshot {
    const squashMergeApplied = rec.mergeResults.some((m) => m.merged && !m.conflict);
    const greenGatePassed = rec.agentOk === true && rec.checkRan && rec.checkGreen === true;
    const lastFinish = rec.finishCalls[rec.finishCalls.length - 1];
    return {
        unit: "runTaskSinglePass",
        finalStatus,
        gateVerdict: lastFinish ? lastFinish.gateVerdict : null,
        squashMergeApplied,
        mergedWithoutGreenGate: squashMergeApplied && !greenGatePassed,
        worktreeRemoved: rec.removeCalls.length > 0,
        branchKept: rec.removeCalls.some((c) => c.keepBranch === true),
        diffstatRecorded: rec.statusCalls.some((c) => c.extra?.diffstat != null),
        failureReasonSet: rec.statusCalls.some((c) => c.extra?.failureReason != null),
        iterationsAdded: rec.iterationsAdded,
        iterationsFinished: rec.finishCalls.filter((c) => Boolean(c.gateVerdict)).length,
    };
}
