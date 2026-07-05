// tests/verify/dropin/surface.ts
// The M5 verify SURFACE. A single per-task EngineSnapshot can't express the drop-in choreography
// (free-a-slot, the explicit pause, commit-at-both-boundaries, retention), so this slice records a
// CROSS-TASK snapshot by driving the REAL createScheduler + the REAL runTaskLoop drop-in transition +
// the REAL verifyAndMerge handback, with fake git/check/spawn deps gated by a controllable
// AbortController so a drop-in fires deterministically mid-iteration. The invariants read the distilled
// booleans. Complementary to, and separate from, the untouched M2/M3/M4 slices.
import { createScheduler, type Scheduler } from "../../../src/main/engine/scheduler";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import { verifyAndMerge, type HandbackDeps } from "../../../src/main/engine/handback";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TaskStatus, TokenTotals } from "../../../src/shared/types";

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 2, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

export const mkProject = (id: string, concurrencyCap: number | null): Project => ({
    id, name: id, repoPath: "/r", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph",
    checkCommand: "c", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null,
    stallTimeoutMin: null, model: null, concurrencyCap, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr",
});
export const mkTask = (id: string, projectId: string, createdAt: number): Task => ({
    id, projectId, title: id, intent: "", acceptance: ["x"], status: "queued", scopeHint: null, dependsOn: [],
    branchName: `ralph/task-${id}`, worktreePath: null, diffstat: null, failureReason: null, createdAt, updatedAt: createdAt,
});

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

// The flat cross-task recording the invariants read. Every boolean defaults to "no violation observed"
// (vacuous true) so a scenario that doesn't exercise a path doesn't spuriously fail its invariant.
export interface DropinRecording {
    unit: "dropin";
    cap: number;
    maxRunningPerProject: Record<string, number>;
    slotFreedOnDropIn: boolean;                       // a running-task drop-in freed the slot → the waiter started
    handedOffEverStarted: boolean;                    // did kick() ever pass a handed-off task to startTask?
    commitAtEntryBoundary: boolean;                   // commitAll ran when the loop bailed to handed-off
    everyHandbackPrecededByCommit: boolean;           // commitAll preceded mergeStage on every handback
    handedOffOrNeedsHumanWorktreeRetained: boolean;   // no removeWorktree for any task ending handed-off/needs-human
    mergedOrAbandonedWorktreeRemoved: boolean;        // removeWorktree DID happen for every merged/abandoned task
    killedIterationRecordsNoResumableSession: boolean; // a killed/stalled iteration recorded sessionId=null (resume-guard)
}

// Scenario 1 (the comprehensive real run): cap 1, A (the drop-in target, whose session hangs until
// killed) + B (green). kick → A runs; drop into A → A handed-off (entry checkpoint, worktree retained),
// the slot frees, B starts and merges; then verify-&-merge A → A merged (handback commit before the
// merge, worktree removed on landing). Exercises all four invariants through the real units.
export async function runFreesSlotScenario(): Promise<DropinRecording> {
    const cap = 1;
    const project = mkProject("P", cap);
    const tasks = new Map<string, Task>([["A", mkTask("A", "P", 0)], ["B", mkTask("B", "P", 1)]]);

    const transitions: Array<{ id: string; status: TaskStatus }> = [];
    const removeCalled = new Set<string>();
    const commitMsgs: Array<{ id: string; msg: string }> = [];
    const finishSessions: Array<{ id: string; sessionId: string | null }> = []; // what runIteration recorded per finish (resume-guard)
    const startedOrder: string[] = [];
    const startedWhileHandedOff: string[] = [];
    let maxRunning = 0;
    let handbackCommitted = false;
    let handbackCommitBeforeMerge = false;

    const setStatus = (id: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string | null }) => {
        const t = tasks.get(id)!;
        tasks.set(id, { ...t, status, ...(extra?.worktreePath !== undefined ? { worktreePath: extra.worktreePath } : {}) });
        transitions.push({ id, status });
    };

    const registry = new Map<string, { controller: AbortController; settled: Promise<TaskStatus> }>();
    const aRunning = deferred();
    const bSettled = deferred();

    // A's session hangs (running) until the drop-in aborts it, then resolves not-ok (the killed session).
    const aSpawn: RunTaskDeps["spawnAgent"] = (_wt, _p, opts) => new Promise((resolve) => {
        aRunning.resolve();
        const kill = () => resolve({ ok: false, output: "killed", sessionId: "sA", stalled: false, usage: ZERO, durationMs: null });
        if (opts.signal?.aborted) kill(); else opts.signal?.addEventListener("abort", kill);
    });
    const bSpawn: RunTaskDeps["spawnAgent"] = async () => ({ ok: true, output: "ok", sessionId: "sB", stalled: false, usage: ZERO, durationMs: null });

    const buildDeps = (taskId: string, controller: AbortController, spawnAgent: RunTaskDeps["spawnAgent"]): RunTaskDeps => ({
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => `/wt/${taskId}`,
        removeWorktree: async () => { removeCalled.add(taskId); },
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent,
        commitAll: async (_repo, msg) => { commitMsgs.push({ id: taskId, msg }); },
        headSha: async () => `sha-${taskId}`,
        runCheck: async () => ({ green: true, timedOut: false, output: "" }),
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus, addIteration: () => ({ id: `it-${taskId}` }),
        finishIteration: (_id, patch) => { finishSessions.push({ id: taskId, sessionId: patch.sessionId ?? null }); },
        emit: () => {}, signal: controller.signal, log: () => {},
    });

    let scheduler!: Scheduler;
    const sample = () => { for (const p of scheduler.state().perProject) maxRunning = Math.max(maxRunning, p.running); };

    const startTask = async (task: Task): Promise<TaskStatus> => {
        startedOrder.push(task.id);
        if (tasks.get(task.id)!.status === "handed-off") startedWhileHandedOff.push(task.id);
        sample();
        const controller = new AbortController();
        let resolveSettled!: (s: TaskStatus) => void;
        const settled = new Promise<TaskStatus>((r) => { resolveSettled = r; });
        registry.set(task.id, { controller, settled });
        let result: TaskStatus = "needs-human";
        try {
            result = await runTaskLoop(project, task, TEST_CONFIG, buildDeps(task.id, controller, task.id === "A" ? aSpawn : bSpawn));
            return result;
        } finally {
            registry.delete(task.id);
            resolveSettled(result);
            if (task.id === "B") bSettled.resolve();
        }
    };

    scheduler = createScheduler({
        listQueued: () => [...tasks.values()].filter((t) => t.status === "queued"),
        getProject: () => project,
        startTask,
        getTaskStatus: (id) => tasks.get(id)?.status, // M9: dropin fixtures carry no edges, but honour the shape
    });

    scheduler.kick();                       // A starts (cap 1) — B waits
    await aRunning.promise;                  // A is in its (hanging) session → running
    sample();
    const reg = registry.get("A")!;
    reg.controller.abort();                  // DROP IN: hard-interrupt A
    await reg.settled;                       // A bails to handed-off (entry checkpoint, worktree retained)
    await bSettled.promise;                  // the freed slot let B start → green → merged
    sample();

    // Verify-&-merge A's handback through the REAL verifyAndMerge (commit before the merge).
    const handbackDeps: HandbackDeps = {
        commitAll: async (_repo, msg) => { commitMsgs.push({ id: "A", msg }); handbackCommitted = true; },
        runMergeStage: async () => { handbackCommitBeforeMerge = handbackCommitted; return { outcome: "merged", diffstat: "+1 -0" }; },
        setStatus, removeWorktree: async () => { removeCalled.add("A"); },
    };
    await verifyAndMerge(project, { ...tasks.get("A")!, worktreePath: "/wt/A" }, "ralph/task-A", handbackDeps);

    const finalStatus = (id: string) => tasks.get(id)!.status;
    const ids = [...tasks.keys()];
    const aHandedOff = transitions.some((t) => t.id === "A" && t.status === "handed-off");
    // A was dropped-in mid-session (its spawn resolved not-ok = killed), so its recorded session must be null.
    const aFinishes = finishSessions.filter((f) => f.id === "A");
    return {
        unit: "dropin",
        cap,
        maxRunningPerProject: { P: maxRunning },
        slotFreedOnDropIn: aHandedOff && startedOrder.includes("B"),
        handedOffEverStarted: startedWhileHandedOff.length > 0,
        commitAtEntryBoundary: commitMsgs.some((c) => c.id === "A" && c.msg === "ralph: drop-in checkpoint"),
        everyHandbackPrecededByCommit: handbackCommitBeforeMerge,
        handedOffOrNeedsHumanWorktreeRetained: ids.filter((id) => finalStatus(id) === "handed-off" || finalStatus(id) === "needs-human").every((id) => !removeCalled.has(id)),
        mergedOrAbandonedWorktreeRemoved: ids.filter((id) => finalStatus(id) === "merged" || finalStatus(id) === "abandoned").every((id) => removeCalled.has(id)),
        killedIterationRecordsNoResumableSession: aFinishes.length > 0 && aFinishes.every((f) => f.sessionId == null),
    };
}

// Scenario 2: a task that exhausts its budget → needs-human, with its worktree RETAINED (the spec §12
// change the M5 lifecycle is built on). Driven through the REAL runTaskLoop directly (retention is a
// loop property). All drop-in/handback booleans are vacuously true (no drop-in/handback in this run).
export async function runNeedsHumanRetainedScenario(): Promise<DropinRecording> {
    const cap = 1;
    const project = mkProject("P", cap);
    const task = mkTask("A", "P", 0);
    const removeCalled = new Set<string>();

    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/wt/A",
        removeWorktree: async () => { removeCalled.add("A"); },
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => ({ ok: true, output: "x", sessionId: "s", stalled: false, usage: ZERO, durationMs: null }),
        commitAll: async () => {},
        headSha: async () => "sha-A",
        runCheck: async () => ({ green: false, timedOut: false, output: "red" }), // always red → cap-reached
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }),
        diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: () => {},
        addIteration: () => ({ id: "it" }), finishIteration: () => {},
        emit: () => {}, log: () => {},
    };
    // Read the terminal status from the loop's RETURN value (the closure-assigned variant defeats TS
    // narrowing, and the return is the authoritative outcome anyway).
    const endedNeedsHuman = (await runTaskLoop(project, task, { ...TEST_CONFIG, iterationCap: 2, noProgressK: 99 }, deps)) === "needs-human";
    return {
        unit: "dropin",
        cap,
        maxRunningPerProject: { P: 0 },
        slotFreedOnDropIn: true,                  // vacuous — no running-task drop-in in this scenario
        handedOffEverStarted: false,
        commitAtEntryBoundary: true,              // vacuous — no drop-in bail
        everyHandbackPrecededByCommit: true,      // vacuous — no handback
        handedOffOrNeedsHumanWorktreeRetained: endedNeedsHuman && !removeCalled.has("A"),
        mergedOrAbandonedWorktreeRemoved: true,   // vacuous — nothing merged/abandoned
        killedIterationRecordsNoResumableSession: true, // vacuous — no drop-in kill in this scenario
    };
}
