// tests/verify/failures/surface.ts
// The M17 verify SURFACE. Drives the REAL pieces headlessly — the real migrate/openDb + updateTask
// chokepoint against a temp sqlite DB (append, 'unknown' default, stamping, recovery survival), the
// REAL runTaskLoop + runMergeStage with fake deps (one drive per terminal wall, recording the kind that
// arrives at setStatus), and the REAL ctl dispatcher with a DB-backed failures action (read-only proof)
// — and distils a flat FailuresRecording the invariants read. The one site not headless-reachable is
// the boot-reconcile apply (ipc.ts, Electron): its kind is a constant at the apply site, covered by
// manual acceptance like the rest of the reconcile wiring.
import { openDb } from "../../../src/main/db/db";
import { insertTask, updateTask, getTask } from "../../../src/main/db/tasks";
import { listFailures, summarizeFailures } from "../../../src/main/db/failures";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import { runMergeStage, type MergeStageDeps } from "../../../src/main/engine/mergeStage";
import { DEFAULT_LOOP_CONFIG, type LoopConfig } from "../../../src/main/engine/loopConfig";
import { CTL_READ_VERBS, CTL_STEER_VERBS, buildCtlVerbs, dispatchCtl, type CtlActions } from "../../../src/main/ctl/verbs";
import type { Project, Task, TokenTotals } from "../../../src/shared/types";

// The flat recording the invariants read.
export interface FailuresRecording {
    unit: "failures";
    // ledger-append-on-every-needs-human
    needsHumanWrites: number;        // needs-human status writes driven through the real updateTask
    openRowsAfterWrites: number;     // open ledger rows right after those writes (before any stamping)
    noteLessKind: string | null;     // the kind recorded for the write that carried NO failure note
    // resolution-stamped-on-terminal-success
    merged: { open: number; resolved: number };       // the recovered task's rows after its merged write
    abandoned: { open: number; abandoned: number };   // the twice-failed task's rows after abandoned
    requeueStampedRows: number;      // rows a mere requeue (status: queued) stamped — must stay 0
    // kind-faithful
    kinds: Array<{ site: string; expected: string; recorded: string | null }>;
    // ledger-survives-recovery
    recovery: { taskFailureReason: string | null; ledgerReason: string | null; ledgerResolution: string | null };
    // failures-verb-is-readonly
    verbInReadSet: boolean;          // `failures` declared in CTL_READ_VERBS and NOT in the steer set
    verbResponded: boolean;          // dispatching it returned { ok: true }
    dbChangedByVerb: boolean;        // DB byte-state before vs after the dispatch — must stay false
    onlyReadActionFired: boolean;    // the dispatch fired the failures action and nothing else
}

const ZERO_USAGE: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

const PROJECT: Project = {
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
};
const TASK: Task = {
    id: "t-loop", projectId: "p1", title: "T", intent: "do", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
};

// Green-path-default RunTaskDeps (the tests/engine shape); each wall drive overrides its one trigger.
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

// Run the REAL loop into one wall and return the kind its needs-human write carried into setStatus.
async function wallKind(
    over: Partial<RunTaskDeps>, cfg: Partial<LoopConfig> = {}, taskOver: Partial<Task> = {}, projectOver: Partial<Project> = {},
): Promise<string | null> {
    let kind: string | null = null;
    const d = loopDeps({
        ...over,
        setStatus: (_id, status, extra) => { if (status === "needs-human") kind = extra?.failure?.kind ?? null; },
    });
    await runTaskLoop({ ...PROJECT, ...projectOver }, { ...TASK, ...taskOver }, { ...DEFAULT_LOOP_CONFIG, ...cfg }, d);
    return kind;
}

// Run the REAL merge stage into one failure and return the kind its needs-human result carries.
async function mergeKind(over: Partial<MergeStageDeps>, projectOver: Partial<Project> = {}): Promise<string | null> {
    const deps: MergeStageDeps = {
        createWorktree: async () => "/merge-wt", squashMergeInto: async () => ({ merged: true, conflict: false }),
        runSetup: async () => ({ ok: true, output: "" }), runCheck: async () => ({ green: true, timedOut: false, output: "" }),
        runAcceptance: async () => ({ ok: true, output: "" }), removeWorktree: async () => {},
        diffStat: async () => "+1 -0", advanceBranch: async () => {}, headSha: async () => "sha",
        checkTimeoutMs: 1000,
        ...over,
    };
    const r = await runMergeStage({ ...PROJECT, ...projectOver }, TASK, "ralph/task-x", deps);
    return r.outcome === "needs-human" ? r.kind : null;
}

// The comprehensive positive run: real DB, real loop, real merge stage, real dispatcher.
export async function runFailuresScenario(): Promise<FailuresRecording> {
    // ── the DB chokepoint: append + 'unknown' default + stamping + recovery, via the REAL updateTask ─
    const db = openDb(":memory:");
    const tRecover = insertTask(db, { projectId: "p1", title: "recovers", intent: "x", acceptance: ["a"] });
    const tNoteLess = insertTask(db, { projectId: "p1", title: "unnoted", intent: "x", acceptance: ["a"] });
    const tAbandon = insertTask(db, { projectId: "p1", title: "twice-failed", intent: "x", acceptance: ["a"] });

    updateTask(db, tRecover.id, { status: "needs-human", failureReason: "merge conflict", failure: { kind: "merge-conflict", iterationIndex: 3 } });
    updateTask(db, tNoteLess.id, { status: "needs-human", failureReason: "mystery wall" }); // NO note → the 'unknown' default
    updateTask(db, tAbandon.id, { status: "needs-human", failureReason: "cost cap reached", failure: { kind: "cost-cap", iterationIndex: 1 } });
    updateTask(db, tAbandon.id, { status: "queued" }); // a resume/requeue is NOT terminal — must stamp nothing
    const requeueStampedRows = listFailures(db).filter((f) => f.resolution != null).length;
    updateTask(db, tAbandon.id, { status: "needs-human", failureReason: "no progress", failure: { kind: "no-progress", iterationIndex: 4 } });

    const needsHumanWrites = 4;
    const openRowsAfterWrites = listFailures(db, { open: true }).length;
    const noteLessKind = listFailures(db).find((f) => f.taskId === tNoteLess.id)?.kind ?? null;

    // Terminal outcomes: the recovered task merges (the hand-fixed conflict), the twice-failed one is abandoned.
    updateTask(db, tRecover.id, { status: "merged", failureReason: null });
    updateTask(db, tAbandon.id, { status: "abandoned", failureReason: null });
    const rowsFor = (taskId: string) => listFailures(db).filter((f) => f.taskId === taskId);
    const merged = {
        open: rowsFor(tRecover.id).filter((f) => f.resolution == null).length,
        resolved: rowsFor(tRecover.id).filter((f) => f.resolution === "resolved").length,
    };
    const abandoned = {
        open: rowsFor(tAbandon.id).filter((f) => f.resolution == null).length,
        abandoned: rowsFor(tAbandon.id).filter((f) => f.resolution === "abandoned").length,
    };

    // The direct anti-regression of today's bug: after recovery the card banner is gone but the ledger
    // keeps the (now-resolved) evidence.
    const recoveredLedger = rowsFor(tRecover.id)[0];
    const recovery = {
        taskFailureReason: getTask(db, tRecover.id)?.failureReason ?? null,
        ledgerReason: recoveredLedger?.reason ?? null,
        ledgerResolution: recoveredLedger?.resolution ?? null,
    };

    // ── kind-faithful: the REAL loop + REAL merge stage driven into every headless-reachable wall ────
    let sha = 0;
    const kinds: FailuresRecording["kinds"] = [
        { site: "worktree-setup", expected: "worktree-setup", recorded: await wallKind({ createWorktree: async () => { throw new Error("clone failed"); } }) },
        { site: "no-acceptance", expected: "no-acceptance", recorded: await wallKind({}, {}, { acceptance: [] }) },
        { site: "setup-command (fresh worktree)", expected: "setup-command", recorded: await wallKind({ runSetup: async () => ({ ok: false, output: "npm ci exploded" }) }, {}, {}, { setupCommand: "npm ci" }) },
        { site: "cost-cap", expected: "cost-cap", recorded: await wallKind({}, { tokenCap: 0 }) },
        {
            site: "deny-wall", expected: "deny-wall",
            recorded: await wallKind({
                spawnAgent: async () => ({ ok: true, output: "o", sessionId: "s", stalled: false, usage: ZERO_USAGE, durationMs: null, deniedCommands: ["Bash(git push)"] }),
                runCheck: async () => ({ green: false, timedOut: false, output: "red" }),
            }, { denyWallK: 1 }),
        },
        { site: "no-progress", expected: "no-progress", recorded: await wallKind({ runCheck: async () => ({ green: false, timedOut: false, output: "red" }) }, { noProgressK: 1 }) },
        {
            site: "iteration-cap", expected: "iteration-cap",
            recorded: await wallKind({
                runCheck: async () => ({ green: false, timedOut: false, output: "red" }),
                headSha: async () => `sha-${sha++}`, // fresh commit each pass so no-progress never fires first
            }, { iterationCap: 1, noProgressK: 99 }),
        },
        { site: "merge-error (thrown stage)", expected: "merge-error", recorded: await wallKind({ mergeStage: async () => { throw new Error("fatal: Filename too long"); } }) },
        { site: "merge kind forwarded by the loop", expected: "recheck-failed", recorded: await wallKind({ mergeStage: async () => ({ outcome: "needs-human", reason: "re-check failed after rebase on integration tip", kind: "recheck-failed" }) }) },
        { site: "merge-conflict (real merge stage)", expected: "merge-conflict", recorded: await mergeKind({ squashMergeInto: async () => ({ merged: false, conflict: true }) }) },
        { site: "setup-command (real merge stage)", expected: "setup-command", recorded: await mergeKind({ runSetup: async () => ({ ok: false, output: "boom" }) }, { setupCommand: "npm ci" }) },
        { site: "recheck-failed (real merge stage)", expected: "recheck-failed", recorded: await mergeKind({ runCheck: async () => ({ green: false, timedOut: false, output: "red" }) }) },
    ];

    // ── failures-verb-is-readonly: the REAL dispatcher over a DB-backed failures action ─────────────
    const fired = new Set<string>();
    const rec = (name: string) => () => { fired.add(name); return { done: name }; };
    const recVoid = (name: string) => (): void => { fired.add(name); };
    const actions: CtlActions = {
        status: rec("status"), taskDetail: rec("taskDetail"), progressTail: rec("progressTail"), planStatus: rec("planStatus"),
        failures: (q) => { fired.add("failures"); return { summary: summarizeFailures(db, { open: q.open, kind: q.kind }), recent: listFailures(db) }; },
        pause: recVoid("pause"), resume: recVoid("resume"), abandonTask: rec("abandonTask"), clearDeps: rec("clearDeps"),
    };
    const snapshot = () => JSON.stringify({
        failures: db.prepare("SELECT * FROM failures ORDER BY id").all(),
        tasks: db.prepare("SELECT * FROM tasks ORDER BY id").all(),
    });
    const before = snapshot();
    const resp = await dispatchCtl(buildCtlVerbs(actions), { verb: "failures", args: { all: "true" } });
    const dbChangedByVerb = snapshot() !== before;

    db.close();
    return {
        unit: "failures",
        needsHumanWrites, openRowsAfterWrites, noteLessKind,
        merged, abandoned, requeueStampedRows,
        kinds,
        recovery,
        verbInReadSet: (CTL_READ_VERBS as readonly string[]).includes("failures") && !(CTL_STEER_VERBS as readonly string[]).includes("failures"),
        verbResponded: resp.ok,
        dbChangedByVerb,
        onlyReadActionFired: fired.size === 1 && fired.has("failures"),
    };
}

// A clean baseline (all invariants hold) — probes clone it and break ONE field.
export const BASELINE: FailuresRecording = {
    unit: "failures",
    needsHumanWrites: 4,
    openRowsAfterWrites: 4,
    noteLessKind: "unknown",
    merged: { open: 0, resolved: 1 },
    abandoned: { open: 0, abandoned: 2 },
    requeueStampedRows: 0,
    kinds: [
        { site: "worktree-setup", expected: "worktree-setup", recorded: "worktree-setup" },
        { site: "no-acceptance", expected: "no-acceptance", recorded: "no-acceptance" },
        { site: "cost-cap", expected: "cost-cap", recorded: "cost-cap" },
        { site: "merge-conflict (real merge stage)", expected: "merge-conflict", recorded: "merge-conflict" },
    ],
    recovery: { taskFailureReason: null, ledgerReason: "merge conflict", ledgerResolution: "resolved" },
    verbInReadSet: true,
    verbResponded: true,
    dbChangedByVerb: false,
    onlyReadActionFired: true,
};
