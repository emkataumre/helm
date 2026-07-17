// tests/verify/feedback/surface.ts
// The M18 verify SURFACE. Drives the REAL runTaskLoop with recording fakes through the four feedback
// behaviours — a recyclable merge loss (continues + informed retry prompt), the recycle bound (parks
// with the real kind), a non-recyclable merge-setup loss (parks immediately), and the informed resume
// (parked framing in the first prompt) — plus the REAL DB (updateTask + recordRecycledFailure, wired
// exactly like ipc.ts) for the ledger half. Distils one flat FeedbackRecording the invariants read.
import { openDb } from "../../../src/main/db/db";
import { insertTask, updateTask } from "../../../src/main/db/tasks";
import { listFailures, recordRecycledFailure } from "../../../src/main/db/failures";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TokenTotals } from "../../../src/shared/types";

// The flat recording the invariants read.
export interface FeedbackRecording {
    unit: "feedback";
    // merge-loss-recycles-not-parks
    conflict: {
        finalStatus: string;              // must be "merged" — the loss never parked
        needsHumanWrites: number;         // must stay 0
        spawnPrompts: number;             // 2 — the loop retried in-place
        retryPromptHasCause: boolean;     // the merge-loss framing reached the retry prompt
        retryPromptDemandsMerge: boolean; // the /goal CONDITION itself demands the integration merge
    };
    // recycle-bounded
    bounded: {
        finalStatus: string;              // "needs-human" — the bound parked it
        mergeAttempts: number;            // recycleK recycles + the parking loss
        recycleK: number;                 // the bound the run used
        parkedKind: string | null;        // the terminal kind stays the real merge cause
        parkedReason: string | null;
    };
    // non-recyclable-kinds-still-park
    nonRecyclable: {
        finalStatus: string;              // "needs-human", first loss
        mergeAttempts: number;            // must be 1
        recycles: number;                 // must be 0 — config faults are not the agent's to fix
    };
    // recycled-losses-still-ledgered (REAL DB through the real ipc wiring shape)
    ledger: {
        recycledRows: number;             // one per recycle
        recycledKinds: string[];          // kind-faithful
        resolutions: Array<string | null>; // every recycle row pre-stamped 'recycled'
        openRowsAfterMerge: number;       // recycles never read as open/waiting-on-a-human
        finalStatus: string;              // the run itself still merged
    };
    // resume-carries-parked-cause
    resume: {
        parkedPromptHasCause: boolean;    // parked framing + the reason in the FIRST resumed prompt
        cleanPromptSeeded: boolean;       // a clean resume must seed nothing (must stay false)
    };
}

const ZERO_USAGE: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
};
const TASK: Task = {
    id: "t-feedback", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

// mergeRecycleK: 2 — the M18 default, and the bound the `bounded` drive pins (K recycles, then park).
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 2, denyWallK: 3, mergeRecycleK: 2, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

// Green-path-default RunTaskDeps (the tests/engine shape); each drive overrides its one trigger.
function loopDeps(over: Partial<RunTaskDeps>): RunTaskDeps {
    return {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => "/wt", removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        spawnAgent: async () => ({ ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }),
        commitAll: async () => {}, headSha: async () => "sha1",
        runCheck: async () => ({ green: true, timedOut: false, output: "" }),
        runAcceptance: async () => ({ ok: true, output: "" }),
        squashMergeInto: async () => ({ merged: true, conflict: false }), diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: () => {}, addIteration: () => ({ id: "it" }), finishIteration: () => {}, log: () => {},
        ...over,
    };
}

// The comprehensive positive run: every drive uses the REAL loop; the ledger drive adds the REAL DB.
export async function runFeedbackScenario(): Promise<FeedbackRecording> {
    // ── merge-loss-recycles-not-parks: one conflict loss, then a clean merge ─────────────────────────
    const prompts: string[] = [];
    let conflictNeedsHuman = 0;
    let conflictLosses = 0;
    const conflictStatus = await runTaskLoop(PROJECT, TASK, TEST_CONFIG, loopDeps({
        spawnAgent: async (_wt, prompt) => { prompts.push(prompt); return { ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        mergeStage: async () => (conflictLosses++ === 0
            ? { outcome: "needs-human", reason: "merge conflict", kind: "merge-conflict" }
            : { outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (_id, s) => { if (s === "needs-human") conflictNeedsHuman += 1; },
    }));
    const retry = prompts[1] ?? "";
    const conflict = {
        finalStatus: conflictStatus,
        needsHumanWrites: conflictNeedsHuman,
        spawnPrompts: prompts.length,
        retryPromptHasCause: retry.includes("lost the merge race") && retry.includes("merge conflict"),
        retryPromptDemandsMerge: (retry.split("\n")[0] ?? "").includes(`git merge ${PROJECT.integrationBranch}`),
    };

    // ── recycle-bounded: every merge loses; K recycles then the parking loss ─────────────────────────
    let mergeAttempts = 0;
    let parkedKind: string | null = null;
    let parkedReason: string | null = null;
    const boundedStatus = await runTaskLoop(PROJECT, TASK, TEST_CONFIG, loopDeps({
        mergeStage: async () => { mergeAttempts += 1; return { outcome: "needs-human", reason: "merge conflict", kind: "merge-conflict" }; },
        setStatus: (_id, s, extra) => {
            if (s === "needs-human") { parkedKind = extra?.failure?.kind ?? null; parkedReason = extra?.failureReason ?? null; }
        },
    }));
    const bounded = { finalStatus: boundedStatus, mergeAttempts, recycleK: TEST_CONFIG.mergeRecycleK, parkedKind, parkedReason };

    // ── non-recyclable-kinds-still-park: a merge-SETUP loss (config fault) parks on loss #1 ──────────
    let setupAttempts = 0;
    let setupRecycles = 0;
    const setupStatus = await runTaskLoop(PROJECT, TASK, TEST_CONFIG, loopDeps({
        mergeStage: async () => { setupAttempts += 1; return { outcome: "needs-human", reason: "merge setup failed:\nnpm ci exploded", kind: "setup-command" }; },
        recordRecycled: () => { setupRecycles += 1; },
    }));
    const nonRecyclable = { finalStatus: setupStatus, mergeAttempts: setupAttempts, recycles: setupRecycles };

    // ── recycled-losses-still-ledgered: the REAL DB behind setStatus + recordRecycled (the ipc shape) ─
    const db = openDb(":memory:");
    const dbTaskRow = insertTask(db, { projectId: "p1", title: "T", intent: "do", acceptance: ["x"] });
    const dbTask: Task = { ...TASK, id: dbTaskRow.id };
    let ledgerLosses = 0;
    const ledgerStatus = await runTaskLoop(PROJECT, dbTask, TEST_CONFIG, loopDeps({
        mergeStage: async () => (ledgerLosses++ === 0
            ? { outcome: "needs-human", reason: "merge conflict", kind: "merge-conflict" }
            : { outcome: "merged", diffstat: "+1 -0" }),
        setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); },
        recordRecycled: (id, reason, note) => recordRecycledFailure(db, id, reason, note),
    }));
    const rows = listFailures(db).filter((f) => f.taskId === dbTask.id);
    const recycledRows = rows.filter((f) => f.resolution === "recycled");
    const ledger = {
        recycledRows: recycledRows.length,
        recycledKinds: recycledRows.map((f) => f.kind),
        resolutions: rows.map((f) => f.resolution),
        openRowsAfterMerge: listFailures(db, { open: true }).filter((f) => f.taskId === dbTask.id).length,
        finalStatus: ledgerStatus,
    };
    db.close();

    // ── resume-carries-parked-cause: a parked reason seeds the first resumed prompt; a clean one doesn't ─
    const resumeCtx = { worktreePath: "/existing/wt", branch: "ralph/task-t-feedback", startIndex: 3 };
    const promptOf = async (failureReason: string | null): Promise<string> => {
        const seen: string[] = [];
        await runTaskLoop(PROJECT, { ...TASK, failureReason }, TEST_CONFIG, loopDeps({
            spawnAgent: async (_wt, prompt) => { seen.push(prompt); return { ok: true, output: "ok", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null }; },
        }), resumeCtx);
        return seen[0] ?? "";
    };
    const parkedPrompt = await promptOf("merge conflict");
    const cleanPrompt = await promptOf(null);
    const resume = {
        parkedPromptHasCause: parkedPrompt.includes("previously parked") && parkedPrompt.includes("merge conflict"),
        cleanPromptSeeded: cleanPrompt.includes("previously parked"),
    };

    return { unit: "feedback", conflict, bounded, nonRecyclable, ledger, resume };
}

// A clean baseline (all invariants hold) — probes clone it and break ONE field.
export const BASELINE: FeedbackRecording = {
    unit: "feedback",
    conflict: { finalStatus: "merged", needsHumanWrites: 0, spawnPrompts: 2, retryPromptHasCause: true, retryPromptDemandsMerge: true },
    bounded: { finalStatus: "needs-human", mergeAttempts: 3, recycleK: 2, parkedKind: "merge-conflict", parkedReason: "merge conflict" },
    nonRecyclable: { finalStatus: "needs-human", mergeAttempts: 1, recycles: 0 },
    ledger: { recycledRows: 1, recycledKinds: ["merge-conflict"], resolutions: ["recycled"], openRowsAfterMerge: 0, finalStatus: "merged" },
    resume: { parkedPromptHasCause: true, cleanPromptSeeded: false },
};
