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
    costCapUsd: number | null;       // M12 per-task USD spend ceiling (NULL = engine default 25; an explicit 0 = spawn nothing)
    model: string | null;            // claude --model for each spawn
    concurrencyCap: number | null;   // M4 scheduler cap (NOT a LoopConfig field); NULL = engine default 3
    terminalCommand: string | null;  // M5 drop-in launch template ({worktree}/{resume}); NULL = engine default
    autoModeEnvironment: string | null; // M6-② auto-mode trusted-env (spec §10); raw TEXT; NULL = ["$defaults"]
    promotionMode: "pr" | "direct" | "strict"; // M6-③ batch-Promote graduation strategy (spec §13/§3); NOT NULL, default "pr"
    jailImage: string | null;        // M13 Docker-jail opt-in; NULL = host mode, non-null = jailed spawns with that image
    conductorSessionId: string | null; // M16 conductor pane's persistent claude session — recorded at fresh
                                       // launch; Resume offered only once claude's session file exists on disk
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
// A command's declared ROLE in the gate (overhaul, 2026-07-14). `proof` = this task creates it or makes it
// pass (missing pre-work is EXPECTED; green pre-work is the real fake-green warn). `regression` = a standing
// suite (green pre-work is expected; red means the integration tip itself is broken). Untagged commands keep
// the original one-size semantics — a legacy draft never gets silently weaker gating.
export type PreflightRole = "proof" | "regression";
export interface PlanDraftTask {
    slug: string;              // unique within the file; the edge-graph node id
    title: string;
    intent: string;            // prose directive — what to build (the §6 intent)
    acceptance: string[];      // mandatory, non-empty, separately-runnable commands (the §6 mantra)
    acceptanceRoles?: (PreflightRole | null)[]; // parallel to acceptance; absent/null entries = untagged (legacy)
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

// The live side-rail state main pushes to the renderer on every .helm/plan/ change (plan:changed). `stage`
// is derived PURELY from which files exist (conversing = neither; prd = prd.md only; tasks = tasks.json
// present, even if malformed). `parse` is null until tasks.json lands; `verdicts` are the static pre-flight
// (only when parse.ok). One active plan per project, so one rail state per project.
export type PlanStage = "conversing" | "prd" | "tasks";
export interface PlanRailState {
    stage: PlanStage;
    prdText: string | null;
    parse: { ok: true; draft: PlanDraft } | { ok: false; errors: string[] } | null;
    verdicts: PreflightVerdict[];
}

// What approvePlan returns. On ok: how many tasks were queued + any non-blocking warnings (e.g. no prd.md, so
// an empty PRD was stored). On failure: the parse errors (re-validated from disk — the renderer's copy is never
// trusted), which the pane lists verbatim. A parse-invalid draft never produces rows.
export type ApprovePlanResult =
    | { ok: true; count: number; warnings: string[] }
    | { ok: false; errors: string[]; stale?: boolean }; // stale: the stored pre-flight run no longer matches disk — re-run

// ── M16 conductor (the planner pane absorbed) ─────────────────────────────────────────────────────
// What conductor:open returns — a READ-ONLY hydration: any live conductor PTY (null = show the launch
// panel), the current plan-rail state, and the resume-guard verdict. `resumable` is true iff the
// project's recorded conductorSessionId has an actually-persisted claude session on disk (the M5
// "recorded ⇔ resumable" kernel, conductor edition) — it drives the [Resume conductor] enabled state,
// and conductor:launch re-checks it main-side (a stale renderer can never force a --resume).
export interface ConductorOpenResult {
    session: PtySession | null;
    state: PlanRailState;
    resumable: boolean;
}

// ── M11 dynamic pre-flight (spec §3/§6; vocabulary overhauled 2026-07-14) ─────────────────────────
// The DYNAMIC verdict for ONE deduped acceptance command, run once in a throwaway worktree off the
// integration tip (static pre-flight only reads names; this executes). Role-aware levels — `ok-*` never
// needs an ack, every `warn-*` does:
//  · "ok-red"             — a proof/untagged command fails pre-work: the EXPECTED good case (TDD-red).
//  · "ok-pass"            — a REGRESSION suite is green pre-work: exactly what a standing suite should be.
//  · "ok-planned"         — a PROOF command doesn't exist yet: the task declares it will create it.
//  · "warn-already-green" — a proof/untagged command passes BEFORE any work: it cannot prove the task (the
//                           fake-green lesson, at the plan layer).
//  · "warn-missing"       — an untagged command couldn't run, or a declared REGRESSION suite is missing
//                           (a misdeclared suite); carries the static reason/did-you-mean when it has one.
//  · "warn-tip-red"       — a declared REGRESSION suite FAILS on the integration tip: the tip itself is red.
//  · "warn-no-proof"      — synthetic, per TASK (ack key `no-proof:<slug>`): a role-tagged draft has a task
//                           with no proof command — done and not-started look identical to the gate.
export type PreflightLevel =
    | "ok-red" | "ok-pass" | "ok-planned"
    | "warn-already-green" | "warn-missing" | "warn-tip-red" | "warn-no-proof";
// The ONE warn rule, shared so the engine's ack gate and the renderer's Confirm counter cannot diverge.
export const isWarnLevel = (l: PreflightLevel): boolean => l.startsWith("warn-");
export interface PreflightCommandVerdict {
    command: string;
    taskSlugs: string[];       // every task whose acceptance references this (deduped) command
    level: PreflightLevel;
    exitCode: number | null;   // the command's exit code; null = never spawned (a setup/spawn failure)
    timedOut?: boolean;        // the command hit checkTimeoutMs and was killed (evidence, not a level)
    tail: string;              // a short evidence tail of the command's output
    reason?: string;           // warn-missing: the static reason (e.g. no npm script "X")
    suggestion?: string;       // warn-missing: the did-you-mean carried over from the static verdict
}
export interface PreflightReport {
    ran: boolean;              // false only if the run short-circuited (parse-invalid — never reaches here)
    integrationSha?: string;   // the integration tip the run validated against (shown on the panel)
    // setupCommand failed in the throwaway → NOTHING was observed. No verdicts, no ack path — Confirm
    // hard-blocks (BLOCKED is never a pass); Skip pre-flight remains the only escape.
    blocked?: { setupTail: string };
    verdicts: PreflightCommandVerdict[];
    warnCount: number;         // verdicts needing an ack (warn-*); Confirm unlocks only when all are acked
}
// One per-command progress tick streamed to the renderer while the throwaway run grinds (preflight:progress).
export interface PreflightProgress { index: number; total: number; command: string }
// plans:preflight re-reads + re-validates from disk before running; a still-invalid draft yields errors
// (parse-FAILs hard-block, exactly like approve), never a half-built report. On ok it also returns the
// runId of the SERVER-STORED run — approve validates acks against that stored run, never re-executing.
export type PreflightRunResult =
    | { ok: true; runId: string; report: PreflightReport }
    | { ok: false; errors: string[] };
// Approve's second phase carries the human's acks (by command string), the runId of the stored pre-flight
// run those acks reference, and the explicit Skip escape. The ipc validates against the STORED run (draft
// hash must still match disk) — it never re-executes commands and never trusts the renderer's report.
export interface ApproveOptions { runId?: string; acks?: string[]; skipPreflight?: boolean }

// ── M17 failure ledger ────────────────────────────────────────────────────────────────────────────
// tasks.failureReason is a single MUTABLE field — overwritten by the next failure, nulled on recovery.
// The ledger is the durable, append-only history behind it: one row per terminal needs-human write,
// stamped resolved/abandoned when the task later reaches a terminal outcome. `kind` is derived at each
// terminal site (never parsed from the reason string); 'unknown' is the structural default the DB
// writer applies when a caller supplies no note, so completeness never depends on discipline.
export type FailureKind =
    | "worktree-setup"      // pre-loop clone/branch failure (runTask, before the loop)
    | "no-acceptance"       // empty acceptance list (Layer B is mandatory)
    | "setup-command"       // setup command failed (fresh-worktree install OR merge-stage install)
    | "cost-cap"            // the run's USD spend reached the ceiling
    | "merge-conflict"      // squash onto the fresh integration tip conflicted
    | "recheck-failed"      // the merge stage's rebase-on-tip re-check went red
    | "merge-error"         // the merge stage THREW (git failure around the throwaway worktree)
    | "deny-wall"           // the same permissions.deny key blocked K consecutive iterations
    | "no-progress"         // K consecutive iterations with no new commit
    | "iteration-cap"       // the per-run attempt budget ran out
    | "boot-unrecoverable"  // boot reconcile: worktree AND branch both gone — nothing to resume
    | "unknown";            // the DB writer's completeness default (caller supplied no note)

// The structured note a needs-human status write carries into the DB chokepoint. iterationIndex is the
// most recent COMPLETED iteration's DB index when the wall hit (null = pre-loop / boot — no iteration).
export interface FailureNote {
    kind: FailureKind;
    iterationIndex: number | null;
}

// One ledger row. resolution/resolvedAt are null while the failure is still open; the task's later
// terminal write stamps them ('resolved' on merged, 'abandoned' on abandoned). 'recycled' rows (M18)
// land pre-stamped: the loop fed the merge loss back to the agent and retried in-place — nothing was
// ever open for a human, and the 'recycled' vs 'resolved' split answers "fixed itself vs needed me".
export interface FailureRecord {
    id: string;
    taskId: string;
    projectId: string;   // denormalized from the task row at insert → per-project reads with no join
    kind: FailureKind;
    reason: string;      // the full human failureReason string as written at the time
    iterationIndex: number | null;
    createdAt: number;
    resolvedAt: number | null;
    resolution: "resolved" | "abandoned" | "recycled" | null;
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
    // The failing gate's evidence tail (empty-string/null on green). Carried on iteration-end and
    // rebuilt from the DB row, so the cockpit's expandable iteration rows read the same evidence
    // in-session and after a restart.
    outputTail: string | null;
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
    | { type: "iteration-end"; index: number; verdict: IterationVerdict; commitSha: string; tail?: string }
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
    costCapUsd?: number | null; // M12 USD spend ceiling (absent → stored NULL → engine default)
    model?: string | null;
    concurrencyCap?: number | null;
    terminalCommand?: string | null;
    autoModeEnvironment?: string | null;
    promotionMode?: "pr" | "direct" | "strict"; // absent → stored 'pr' (the DB default)
    jailImage?: string | null; // M13 Docker-jail image; absent/blank → stored NULL → host mode
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
export type ProjectConfigPatch = Partial<Pick<Project, "setupCommand" | "iterationCap" | "noProgressK" | "stallTimeoutMin" | "costCapUsd" | "model" | "concurrencyCap" | "terminalCommand" | "autoModeEnvironment" | "promotionMode" | "jailImage">>;
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
    // M16 conductor (absorbs M10's openPlanner). openConductor is READ-ONLY hydration: ensures
    // .helm/plan/ + the git-exclude + the live watcher, and reports {live session, rail state,
    // resumable} WITHOUT spawning anything. launchConductor is the explicit human click: fresh=false
    // resumes the recorded session (only if the guard holds — main re-checks), fresh=true starts a new
    // conversation with a forced --session-id recorded up front. Returns the (possibly reused) PTY.
    // onPlanChanged pushes the live rail state (per project) as the session writes prd.md/tasks.json.
    openConductor: (projectId: string) => Promise<ConductorOpenResult | null>;
    launchConductor: (projectId: string, fresh: boolean) => Promise<PtySession | null>;
    onPlanChanged: (cb: (projectId: string, state: PlanRailState) => void) => void;
    // M11 dynamic pre-flight (overhauled 2026-07-14): re-read + re-validate from disk, then EXECUTE each
    // acceptance command once in a throwaway worktree off the integration tip and classify it. The result is
    // STORED server-side (latest run per project) and its runId returned — approve validates acks against that
    // stored run. Errors on a still-invalid draft (never a half-built report); advances/pushes no ref.
    preflightPlan: (projectId: string) => Promise<PreflightRunResult>;
    // Abort an in-flight pre-flight run (kills the current command; the throwaway worktree is still reaped).
    cancelPreflight: (projectId: string) => Promise<void>;
    // Per-command progress ticks while a pre-flight run grinds (preflight:progress). Returns an unsubscribe.
    onPreflightProgress: (cb: (projectId: string, p: PreflightProgress) => void) => () => void;
    // M11 plan views: the plans of a project (newest first) + one plan by id (the board plan badge/filter +
    // the plan-detail view; member tasks are joined renderer-side off the existing tasks list by planId).
    listPlans: (projectId: string) => Promise<Plan[]>;
    getPlan: (planId: string) => Promise<Plan | null>;
    // Approve the active plan: re-read + re-validate from disk (never the renderer's copy), then in ONE
    // transaction insert the plan (PRD copied) + its tasks in topological order, resolving slug edges to real
    // ids, and clear .helm/plan/. Returns queued count + warnings, or the parse errors on a still-invalid draft.
    // M11 (overhauled): opts carry the runId of the stored pre-flight run, the human's per-command acks, and
    // the explicit Skip escape — unless skipped, approve validates the acks against the STORED run (draft hash
    // must still match disk; never re-executes) and CONSUMES it on success (a double-Confirm fails stale).
    approvePlan: (projectId: string, opts?: ApproveOptions) => Promise<ApprovePlanResult>;
}
