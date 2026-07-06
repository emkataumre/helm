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
    autoModeEnvironment: string | null; // M6-② auto-mode trusted-env (spec §10); raw TEXT; NULL = ["$defaults"]
    promotionMode: "pr" | "direct" | "strict"; // M6-③ batch-Promote graduation strategy (spec §13/§3); NOT NULL, default "pr"
}

export interface Task {
    id: string;
    projectId: string;
    title: string;
    intent: string;            // prose directive (what to build)
    acceptance: string[];      // executable proof commands (stored now; run from M2)
    status: TaskStatus;
    scopeHint: string | null;  // per-task (spec §3/§10) — re-enables the /goal no-out-of-scope clause
    dependsOn: string[];       // M9 — task ids this task waits on; absent/NULL = []. A child branches off
                               // integration at START, so the scheduler holds it until every parent MERGES.
    planId: string | null;     // M10 — the plan this task was born from (approve stamps it); NULL = hand-made.
    branchName: string | null;
    worktreePath: string | null;
    diffstat: string | null;
    failureReason: string | null;
    createdAt: number;
    updatedAt: number;
}

// M9: the derived "why isn't this queued task starting yet" view — one unmerged existing parent it waits on.
// Computed per tasks:list (like resumable), never stored. status lets the cockpit distinguish WAITING (parent
// in flight) from STUCK (parent needs-human/abandoned).
export interface WaitingOn { id: string; title: string; status: TaskStatus }

// tasks:list augments each task with `resumable`: whether a drop-in's latestSessionId would find a
// PERSISTED claude session to `--resume`. Recomputed per list from the task's iterations (NOT a stored
// column). Drives the Drop-in button's enabled state — false → Drop-in disabled, Start fresh instead.
// Plus the M9 derived merged-gate view: `blocked` (some existing parent hasn't merged) and the `waitingOn`
// list that explains it — both derived per list from the current board, never a stored TaskStatus.
export interface TaskListItem extends Task {
    resumable: boolean;
    blocked: boolean;
    waitingOn: WaitingOn[];
}

// M10 — the Plan entity: the grouping layer above tasks and the durable home for the PRD text (copied in
// at approve, so it survives the transient .helm/plan/ dir being cleared). One active plan per project;
// tasks born from an approve carry its id in Task.planId (a hand-made task's planId is NULL).
export interface Plan {
    id: string;
    projectId: string;
    title: string;
    prdText: string;
    createdAt: number;
}

// ── M10 plan drafts (the .helm/plan/tasks.json seam — spec §3/§6) ─────────────────────────────────
// A PlanDraft is the PARSED, validated in-memory shape of tasks.json — it lives file-side only (the DB never
// holds drafts; rows are born at approve). Shared so the renderer's side rail renders it and the verify slice
// asserts on it. `dependsOn` here is SIBLING SLUGS (unique within the file); approve resolves them to real ids.
export interface PlanDraftTask {
    slug: string;              // unique within the file; the edge-graph node id
    title: string;
    intent: string;            // prose directive — what to build (the §6 intent)
    acceptance: string[];      // mandatory, non-empty, separately-runnable commands (the §6 mantra)
    scopeHint: string | null;  // optional per-task scope clause
    dependsOn: string[];       // sibling slugs this task waits on (resolved to ids at approve)
}
export interface PlanDraft {
    planTitle: string;
    tasks: PlanDraftTask[];
}

// One static pre-flight judgement of ONE acceptance command of ONE task. `warn` never blocks approve by
// itself (a task may legitimately create its own verify script — the grill's nuance); only PARSE failures
// block. `suggestion` is a cheap did-you-mean (closest npm script) when a `npm run X` names an unknown script.
export interface PreflightVerdict {
    taskSlug: string;
    command: string;
    level: "ok" | "warn";
    reason?: string;      // why it warns, human-readable
    suggestion?: string;  // did-you-mean: the closest existing npm script (npm-run warns only)
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
    // phase: "spawning" = launching claude (no output yet); "working" = the agent is actively producing
    // assistant/tool-use output; "checking"/"accepting" = the engine's post-agent gates. The whole
    // agent-active majority of an iteration is "working" (not "spawning") so the cockpit label stays honest.
    currentIteration: { index: number; phase: "spawning" | "working" | "checking" | "accepting"; latestActivity: string } | null;
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

// ── M6-③ project-level batch Promote (spec §13) ──────────────────────────────────────────────────
// The union the pure promote stage returns. Lives here (shared) so the renderer's result panel and the
// engine agree on ONE shape; promote.ts imports + re-exports it so the engine stays self-describing.
export interface PromoteReady {
    outcome: "ready";
    validatedSha: string;   // the exact re-checked commit the human's push advances the target to
    diffstat: string;       // origin/<target>..promoteBranch, sized before anything is pushed
    promoteBranch: string;  // helm/promote-<projectId>-<integration short sha>
}
export type PromoteResult =
    | { outcome: "nothing-to-promote" }
    | { outcome: "conflict" }
    | { outcome: "recheck-failed"; output: string }
    | PromoteReady;
// What finalizePromotion does on a `ready` graduation — mode-specific. In `direct` mode the tool ADVANCES
// the target itself, on the human's Promote click, to the exact re-validated commit (never any other ref);
// in `pr` it pushes integration + hands a gh command; in `strict` it pushes nothing + hands the sequence.
// The agent loop can never reach this — only the human-triggered projects:promote does.
export interface PromoteFinalizeInfo {
    pushedRefs: string[];      // NON-target helper refs the tool pushed (pr: [integration]; direct/strict: [])
    commands: string[];        // the equivalent commands — audit trail (direct/pr) or the sequence to run (strict)
    advancedTarget: boolean;   // direct: the tool advanced the target to the validated commit on your click
    advancedTo?: string;       // direct: the sha the target now points at (== the re-validated PromoteReady.validatedSha)
    note: string;              // human-readable one-line outcome
    error?: string;            // direct: the advance push failed (e.g. the target moved) — retry with `commands`
}
// The IPC response: the stage result plus (only on `ready`) the finalize info.
export type PromoteResponse = PromoteResult & Partial<PromoteFinalizeInfo>;

// ── M7 embedded terminal foundation (spec §8/§4) ──────────────────────────────────────────────────
// A PTY session hosted in the Electron MAIN process (node-pty behind the injected factory — no test
// ever loads the native module). Main-process residency is the point: a session survives a window-hide
// (M6-④ tray) and re-attaches with scrollback intact; only a real Quit (disposeAll) kills it. The PTY
// is a SIBLING seam to spawn.ts — humans-only; agents keep going through the spawn chokepoint. The
// renderer renders one TerminalPane per session.
export type PtyKind = "dropin" | "planner" | "free";
export interface PtySession {
    id: string;              // randomUUID(), assigned by the manager
    kind: PtyKind;
    title: string;
    cwd: string;
    taskId?: string;         // set for a drop-in session (the task it steers)
    projectId?: string;
}
// list() augments each session with liveness (the renderer greys out a dead tab).
export interface PtySessionInfo extends PtySession {
    alive: boolean;
}
// What the renderer/main hand the manager to spawn a session. argv[0] = command, rest = args
// (the buildDropinArgv shape). Lives here so both the main manager and the renderer HelmApi share it.
export interface CreatePtyOptions {
    cwd: string;
    argv: string[];
    kind: PtyKind;
    title: string;
    taskId?: string;
    projectId?: string;
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
    autoModeEnvironment?: string | null;
    promotionMode?: "pr" | "direct" | "strict"; // absent → stored 'pr' (the DB default)
}
export interface NewTaskInput {
    projectId: string;
    title: string;
    intent: string;
    acceptance: string[];
    scopeHint?: string | null;
    dependsOn?: string[]; // M9 dependency edges (absent → stored NULL / read back as [])
}
// The editable per-project config columns (the project-config form patches these).
export type ProjectConfigPatch = Partial<Pick<Project, "setupCommand" | "iterationCap" | "noProgressK" | "stallTimeoutMin" | "model" | "concurrencyCap" | "terminalCommand" | "autoModeEnvironment" | "promotionMode">>;
// Best-effort registration pre-fill (current git branch → target, package.json → check, lockfile → setup).
export interface DetectedConfig { targetBranch: string | null; checkCommand: string | null; setupCommand: string | null }
export interface HelmApi {
    registerProject: (input: NewProjectInput) => Promise<Project>;
    listProjects: () => Promise<Project[]>;
    updateProject: (id: string, patch: ProjectConfigPatch) => Promise<Project | null>;
    // Remove a project and all its tasks/iterations (cascaded, atomic). Human-only, from the config form.
    deleteProject: (id: string) => Promise<void>;
    detectProject: (repoPath: string) => Promise<DetectedConfig>;
    createTask: (input: NewTaskInput) => Promise<Task>;
    listTasks: () => Promise<TaskListItem[]>;
    // M9: replace a task's dependency edges (the cockpit's Clear-dependencies affordance passes []).
    setDependsOn: (taskId: string, ids: string[]) => Promise<void>;
    // M4: the scheduler auto-starts queued tasks; startNow is the paused-mode manual single-start
    // (replaces M3's run-to-completion runTask). Plus the live scheduler state + the pause toggle.
    startNow: (taskId: string) => Promise<void>;
    getSchedulerState: () => Promise<SchedulerState>;
    setSchedulerPaused: (paused: boolean) => Promise<void>;
    // M5 drop-in handoff, M7-retrofitted. dropIn (fresh = Start fresh, no --resume) hard-interrupts a
    // running/needs-human task → handed-off + opens a terminal; the handback trio acts out of handed-off
    // (resumeTask = continue the loop; verifyAndMerge = gate + land; abandon = reap the worktree). Returns
    // the in-app PtySession (NULL terminalCommand → the renderer opens the drawer on it) or null (external
    // launch via a non-NULL template, or a no-op).
    dropIn: (taskId: string, fresh?: boolean) => Promise<PtySession | null>;
    resumeTask: (taskId: string) => Promise<void>;
    verifyAndMerge: (taskId: string) => Promise<void>;
    abandon: (taskId: string) => Promise<void>;
    // M3 observability reads: the live EngineSnapshot (or one rebuilt from DB rows), and the
    // worktree's progress.md (null once the worktree is gone).
    getVerifyState: (taskId: string) => Promise<EngineSnapshot | null>;
    getProgress: (taskId: string) => Promise<string | null>;
    // M6-③ project-level batch Promote: validate integration on a fresh origin/<target> tip, then hand the
    // mode-specific push + the copyable commands that advance the target (the tool never pushes the target).
    promote: (projectId: string) => Promise<PromoteResponse>;
    // M7 embedded terminal. create/write/resize/kill/list drive PTY sessions; attach wires the main-side
    // scrollback-replay-then-live stream to onPtyData (detach stops it); onPtyExit fires when a session dies.
    // The renderer TerminalPane attaches on mount, detaches (never kills) on unmount — closing a view ≠
    // closing the session; kill is an explicit user action.
    ptyCreate: (opts: CreatePtyOptions) => Promise<PtySession>;
    ptyWrite: (id: string, data: string) => Promise<void>;
    ptyResize: (id: string, cols: number, rows: number) => Promise<void>;
    ptyKill: (id: string) => Promise<void>;
    ptyList: () => Promise<PtySessionInfo[]>;
    ptyAttach: (id: string) => Promise<void>;
    ptyDetach: (id: string) => Promise<void>;
    // These return an UNSUBSCRIBE fn (unlike the app-singleton onTasksChanged): a TerminalPane subscribes
    // on mount and must tear the listener down on unmount, or listeners leak as the drawer switches sessions.
    onPtyData: (cb: (id: string, chunk: string) => void) => () => void;
    onPtyExit: (cb: (id: string, code: number) => void) => () => void;
    onTasksChanged: (cb: () => void) => void;
    onSnapshotChanged: (cb: (taskId: string) => void) => void;
}
