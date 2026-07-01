// src/shared/types.ts
// "handed-off" (M5) is the explicit drop-in pause state: the loop stops, the slot frees, the worktree
// is retained, and the human steers in a terminal until they hand back (resume / verify-&-merge / abandon).
export type TaskStatus = "queued" | "running" | "merged" | "needs-human" | "abandoned" | "handed-off";

// The verdict the engine assigns each iteration. Lives here (a leaf) so the reducer, the loop,
// and the M2 verify slice share one definition; runTask.ts re-exports it for back-compat.
export type IterationVerdict = "green" | "failed" | "hang";

export interface Project {
    id: string;
    name: string;
    repoPath: string;
    integrationBranch: string; // default "integration/ralph"
    targetBranch: string;      // branch integration is created from AND promoted into
    branchPrefix: string;      // default "ralph" -> task branches "ralph/task-<id>"
    checkCommand: string;      // mandatory; the Layer-A gate
    worktreeDir: string;       // relative to repoPath; default ".helm/worktrees"
    // M3 per-project config (all nullable; NULL = use the engine default / feature off).
    setupCommand: string | null;     // deps install run once in a fresh worktree
    iterationCap: number | null;     // overrides DEFAULT_LOOP_CONFIG.iterationCap
    noProgressK: number | null;      // overrides DEFAULT_LOOP_CONFIG.noProgressK
    stallTimeoutMin: number | null;  // MINUTES — converted to ms in resolveLoopConfig (the units seam)
    model: string | null;            // claude --model for each spawn
    concurrencyCap: number | null;   // M4 scheduler cap (NOT a LoopConfig field); NULL = engine default 3
    terminalCommand: string | null;  // M5 drop-in launch template ({worktree}/{resume}); NULL = engine default
}

export interface Task {
    id: string;
    projectId: string;
    title: string;
    intent: string;            // prose directive (what to build)
    acceptance: string[];      // executable proof commands (stored now; run from M2)
    status: TaskStatus;
    scopeHint: string | null;  // per-task (spec §3/§10) — re-enables the /goal no-out-of-scope clause
    branchName: string | null;
    worktreePath: string | null;
    diffstat: string | null;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
}

// tasks:list augments each task with `resumable`: whether a drop-in's latestSessionId would find a
// PERSISTED claude session to `--resume`. Recomputed per list from the task's iterations (NOT a stored
// column). Drives the Drop-in button's enabled state — false → Drop-in disabled, Start fresh instead.
export interface TaskListItem extends Task {
    resumable: boolean;
}

export interface Iteration {
    id: string;
    taskId: string;
    index: number;
    sessionId: string | null;  // captured from M3 (stream-json)
    startedAt: number;
    endedAt: number | null;
    gateVerdict: "green" | "failed" | "hang" | null;
    commitSha: string | null;
    outputTail: string | null;
    // M3 per-iteration accounting (all nullable; absent = not recorded). Read once per iteration
    // from the terminal stream-json `result.usage` (cumulative session totals — see Task 1 spike).
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costUsd: number | null;
    durationMs: number | null;
}

// ── Observability snapshot (M3) ───────────────────────────────────────────────────────────────
// The live EngineSnapshot IS the M3 verify surface: one type, one reducer (verifyState.applyEvent)
// fed both by the running engine (real stream events) and the verify slice (scripted events incl.
// probes). It lives in shared/ so the renderer can import it; SnapshotEvent lives here too so the
// reducer is a leaf with no engine↔verifyState import cycle. progress.md is NOT in the snapshot —
// it's a worktree file fetched separately, keeping the snapshot DB-reconstructable.

export interface TokenTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    costUsd: number;
}

export interface IterationView {
    index: number;
    verdict: IterationVerdict | null;
    tokens: TokenTotals;
    durationMs: number | null;
    sessionId: string | null;
    commitSha: string | null;
}

export interface ActivityEntry {
    iterationIndex: number;
    kind: "assistant" | "tool-use" | "gate";
    text: string;
}

export interface EngineSnapshot {
    taskId: string;
    status: TaskStatus;
    currentIteration: { index: number; phase: "spawning" | "checking" | "accepting"; latestActivity: string } | null;
    iterations: IterationView[];
    totals: TokenTotals;            // sum of every iteration's tokens
    feed: ActivityEntry[];          // bounded in-memory ring (cap 200)
    feedEventsConsumed: number;     // total feed-producing events ever seen (never decremented on trim)
    terminalReason: string | null;
}

// What the engine emits into the reducer. `spawn` translates stream events to assistant/tool-use/
// usage; the loop emits iteration-start/gate/iteration-end/status.
export type SnapshotEvent =
    | { type: "iteration-start"; index: number }
    | { type: "assistant"; index: number; text: string }
    | { type: "tool-use"; index: number; name: string }
    | { type: "usage"; index: number; tokens: TokenTotals; durationMs?: number; sessionId?: string }
    | { type: "gate"; index: number; label: string }
    | { type: "iteration-end"; index: number; verdict: IterationVerdict; commitSha: string }
    | { type: "status"; status: TaskStatus; terminalReason?: string };

// M4 scheduler state for the cockpit indicator (one read per poll). Lives here (shared) so the
// renderer's SchedulerBar and the engine scheduler agree on one shape.
export interface SchedulerState {
    paused: boolean;
    perProject: Array<{ projectId: string; running: number; cap: number }>;
}

// IPC contract: the renderer calls these; main implements them.
export interface NewProjectInput {
    name: string;
    repoPath: string;
    targetBranch: string;
    checkCommand: string;
    // M3 optional config (absent → stored NULL).
    setupCommand?: string | null;
    iterationCap?: number | null;
    noProgressK?: number | null;
    stallTimeoutMin?: number | null;
    model?: string | null;
    concurrencyCap?: number | null;
    terminalCommand?: string | null;
}
export interface NewTaskInput {
    projectId: string;
    title: string;
    intent: string;
    acceptance: string[];
    scopeHint?: string | null;
}
// The editable per-project config columns (the project-config form patches these).
export type ProjectConfigPatch = Partial<Pick<Project, "setupCommand" | "iterationCap" | "noProgressK" | "stallTimeoutMin" | "model" | "concurrencyCap" | "terminalCommand">>;
// Best-effort registration pre-fill (current git branch → target, package.json → check, lockfile → setup).
export interface DetectedConfig { targetBranch: string | null; checkCommand: string | null; setupCommand: string | null }
export interface HelmApi {
    registerProject: (input: NewProjectInput) => Promise<Project>;
    listProjects: () => Promise<Project[]>;
    updateProject: (id: string, patch: ProjectConfigPatch) => Promise<Project | null>;
    detectProject: (repoPath: string) => Promise<DetectedConfig>;
    createTask: (input: NewTaskInput) => Promise<Task>;
    listTasks: () => Promise<TaskListItem[]>;
    // M4: the scheduler auto-starts queued tasks; startNow is the paused-mode manual single-start
    // (replaces M3's run-to-completion runTask). Plus the live scheduler state + the pause toggle.
    startNow: (taskId: string) => Promise<void>;
    getSchedulerState: () => Promise<SchedulerState>;
    setSchedulerPaused: (paused: boolean) => Promise<void>;
    // M5 drop-in handoff. dropIn (fresh = Start fresh, no --resume) hard-interrupts a running/needs-human
    // task → handed-off + launches a terminal; the handback trio acts out of handed-off (resumeTask =
    // continue the loop; verifyAndMerge = gate + land; abandon = reap the worktree).
    dropIn: (taskId: string, fresh?: boolean) => Promise<void>;
    resumeTask: (taskId: string) => Promise<void>;
    verifyAndMerge: (taskId: string) => Promise<void>;
    abandon: (taskId: string) => Promise<void>;
    // M3 observability reads: the live EngineSnapshot (or one rebuilt from DB rows), and the
    // worktree's progress.md (null once the worktree is gone).
    getVerifyState: (taskId: string) => Promise<EngineSnapshot | null>;
    getProgress: (taskId: string) => Promise<string | null>;
    onTasksChanged: (cb: () => void) => void;
    onSnapshotChanged: (cb: (taskId: string) => void) => void;
}
