// src/main/ipc.ts
import { ipcMain, Notification, type BrowserWindow } from "electron";
import { app } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { openDb } from "./db/db";
import { insertProject, listProjects, getProject, updateProject, deleteProject, recordConductorSession } from "./db/projects";
import { insertPlan, listPlans, getPlan, planQueueMetaFromDraft } from "./db/plans";
import { insertTask, insertPlanTask, listTasks, getTask, updateTask, setDependsOn, stampPromoted, isPromoted } from "./db/tasks";
import { listFailures, recordRecycledFailure, summarizeFailures } from "./db/failures";
import { addIteration, finishIteration, listIterations, latestSessionId } from "./db/iterations";
import { ensureBranch, checkoutBranch, createWorktree, removeWorktree, listWorktrees, listBranches, addWorktreeForBranch, worktreePathFor } from "./engine/worktree";
import { reconcile, isUnderWorktreeDir } from "./engine/reconcile";
import { buildInstructions, buildTaskDirective, seedProgress } from "./engine/prompt";
import { commitAll, squashMergeInto, diffStat, headSha, advanceBranch, fetchRemote, countCommitsBeyond, mergeNoFf, pushBranch, revParse } from "./engine/merge";
import { runMergeStage, type MergeStageDeps } from "./engine/mergeStage";
import { runPromoteStage, finalizePromotion, type PromoteStageDeps, type FinalizeDeps } from "./engine/promote";
import { runAcceptance } from "./engine/acceptance";
import { ensureRalphExcluded, ensureHelmExcluded, writeRalphFiles } from "./engine/ralph";
import { watchPlanDir, readPlanFiles, buildPlanRailState, composePlanQueueState, resolveDraftFiles, type NamedPlanRailState } from "./engine/planWatcher";
import { approveFromTasksJson, parsePlanDraft, staticPreflight, type PreflightCtx } from "./engine/planDraft";
import { runPreflight, type PreflightDeps } from "./engine/preflight";
import { createPreflightRunStore, hashDraft, validateApproval } from "./engine/preflightStore";
import { runCheck } from "./engine/check";
import { run } from "./engine/exec";
import { spawnAgent } from "./engine/spawn";
import { buildSpawnSettings } from "./engine/spawnSettings";
import { ensureExchange, pushToExchange, fetchFromExchange } from "./engine/exchange";
import { containerNameFor, JAIL_NAME_PREFIX, type JailSpec } from "./engine/jail";
import { createLogSink } from "./engine/logSink";
import { createSnapshotStore } from "./engine/snapshotStore";
import { snapshotFromRows } from "./engine/verifyState";
import { resolveLoopConfig, type LoopConfig } from "./engine/loopConfig";
import { detectProjectConfig } from "./engine/detect";
import { checkInsDue } from "./engine/checkIn";
import { createScheduler, type Scheduler } from "./engine/scheduler";
import { waitingOnFor } from "./engine/deps";
import { runTaskLoop, type RunTaskDeps, type ResumeContext } from "./engine/runTask";
import { launchTerminal, buildDropinArgv } from "./engine/terminalLaunch";
import { verifyAndMerge, abandon, type HandbackDeps } from "./engine/handback";
import { createPtyManager } from "./engine/ptyManager";
import { nodePtyFactory } from "./engine/nodePtyFactory";
import { deriveTrayCounts, formatTrayTooltip } from "./engine/trayCounts";
import { buildConductorArgv, isConductorResumable } from "./engine/conductor";
import { pipeNameFor, buildShims, buildCtlEnv } from "./ctl/protocol";
import { buildCtlVerbs, type CtlActions, type ProjectSelector } from "./ctl/verbs";
import { startCtlServer } from "./ctl/server";
import type { NewProjectInput, NewTaskInput, ProjectConfigPatch, Project, Task, TaskStatus, PromoteResponse, CreatePtyOptions, PtySession, PlanRailState, ApprovePlanResult, PreflightRunResult, ApproveOptions, ConductorOpenResult } from "../shared/types";

const CHECKIN_POLL_MS = 60_000; // re-evaluate the check-in cadence each minute

// M12 tray fleet counts: index.ts passes setTrayTooltip so the SAME tasks:changed seam that nudges the
// renderer also refreshes the tray's aggregate-count tooltip. Kept a plain string callback (Electron's Tray
// stays in index.ts); default no-op so a caller without a tray (e.g. a test) is unaffected.
export function registerIpc(
    getWindow: () => BrowserWindow | null,
    setTrayTooltip: (tooltip: string) => void = () => {},
): { disposePtys: () => void } {
    const db = openDb(join(app.getPath("userData"), "helm.db"));
    const logsDir = join(app.getPath("userData"), "logs");
    // M13 jail: the per-task BARE EXCHANGE + env-file live OUTSIDE the target repo (so they never pollute its
    // git status), under Helm's userData. Bind-mounted into the container as /exchange; reaped with the task.
    const jailExchangeDir = join(app.getPath("userData"), "jail-exchange");
    const jailExchangePath = (taskId: string) => join(jailExchangeDir, `${taskId}.git`);
    const jailEnvFilePath = (taskId: string) => join(jailExchangeDir, `${taskId}.env`);
    // Reap ONE task's jail resources — the deterministic-named container + per-task volume + bare exchange +
    // env-file. Best-effort (a host-mode task has none; docker may be absent → `run` resolves non-zero, never
    // throws). Addressed ONLY by the helm-jail-<taskId> name — process hygiene extends to containers, never a
    // wider docker sweep. The volume is reaped ONLY here (a terminal teardown) — it's retained across
    // iterations AND across needs-human/handed-off so a resume reuses the clone + node_modules.
    const reapJailResources = async (taskId: string): Promise<void> => {
        const name = containerNameFor(taskId);
        await run("docker", ["rm", "-f", name]);       // stop+remove if it lingered (a normal run --rm auto-reaps)
        await run("docker", ["volume", "rm", name]);   // remove the per-task clone volume
        try { rmSync(jailExchangePath(taskId), { recursive: true, force: true }); } catch { /* gone */ }
        try { rmSync(jailEnvFilePath(taskId), { force: true }); } catch { /* gone */ }
    };
    // Reap any LINGERING helm-jail- container at boot/quit (a crash may leave one; a normal run auto-removes
    // via --rm). Census STRICTLY by the helm-jail- name prefix — never a wider docker sweep. Skipped entirely
    // when no project is jailed, so a host-only Helm never invokes docker.
    const reapOrphanJailContainers = async (): Promise<void> => {
        if (!listProjects(db).some((p) => p.jailImage)) return;
        const ps = await run("docker", ["ps", "-aq", "--filter", `name=${JAIL_NAME_PREFIX}`]);
        const ids = ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (ids.length) { await run("docker", ["rm", "-f", ...ids]); console.log(`[helm] reaped ${ids.length} orphan jail container(s)`); }
    };
    // Derive the tray tooltip from the live board via the PURE trayCounts module, then hand the string to
    // index.ts. listTasks is the same read tasks:list uses; refreshed on every notify (board mutation).
    const refreshTray = () => setTrayTooltip(formatTrayTooltip(deriveTrayCounts(listTasks(db))));
    const notify = () => { getWindow()?.webContents.send("tasks:changed"); refreshTray(); };
    // One live EngineSnapshot per active task; each dispatch nudges the renderer's detail view.
    const snapshots = createSnapshotStore((taskId) => getWindow()?.webContents.send("snapshot:changed", taskId));

    // M16 blessed CLI, boot half: the per-instance pipe name (derived from userData — an accept-harness
    // app on a throwaway HELM_USER_DATA gets its own pipe), the PATH shims written fresh each boot
    // (helm.cmd / helm.ps1 → node out/main/cli.js, resolved relative to this bundle so dev and packaged
    // agree), and the human-PTY env overlay. process.env is NEVER mutated — the pipe is visible ONLY
    // inside PtyManager sessions (the humans-only seam below); the spawn.ts chokepoint keeps plain
    // process.env, so agents can never steer their own scheduler (spec §6).
    const ctlPipeName = pipeNameFor(app.getPath("userData"));
    const ctlShimDir = join(app.getPath("userData"), "ctl");
    try {
        mkdirSync(ctlShimDir, { recursive: true });
        for (const shim of buildShims(join(import.meta.dirname, "cli.js"))) writeFileSync(join(ctlShimDir, shim.name), shim.content);
    } catch (e) { console.log(`[helm] ctl shim generation failed (helm CLI unavailable in terminals): ${e instanceof Error ? e.message : String(e)}`); }
    const ctlEnv = buildCtlEnv(process.env, ctlPipeName, ctlShimDir);

    // M7 embedded terminal: ONE PtyManager for the whole app, with the real node-pty factory (the only
    // place node-pty is imported). SIBLING seam to spawn.ts — humans-only; agents keep the chokepoint.
    // A session's exit pushes pty:exit to the renderer; attach (below) pushes pty:data. Killed on Quit
    // (disposePtys, returned to index.ts) — a window-hide must NOT kill them (main-process residency).
    // M16: every session spawns with the ctl env overlay (pipe + shim PATH) — human PTYs only.
    const ptyManager = createPtyManager(nodePtyFactory, ctlEnv);
    ptyManager.onExit((id, code) => getWindow()?.webContents.send("pty:exit", id, code));

    // M10 plan ingestion: one live .helm/plan/ watcher per project (dispose fns), started lazily by
    // plans:openPlanner and torn down on Quit. The rail-state ctx reads package.json scripts + a fileExists
    // probe FRESH from the repo each fire (staticPreflight is a pure fn of that ctx).
    const planWatchers = new Map<string, () => void>();
    // Overhaul (2026-07-14): the server-stored pre-flight run approve validates against (never re-executes),
    // plus one AbortController per in-flight run (plans:cancelPreflight). Latest run per project, in-memory
    // by design — a restart honestly reports "stale — re-run" (see preflightStore.ts).
    const preflightRuns = createPreflightRunStore();
    const preflightAborts = new Map<string, AbortController>();
    const planDirFor = (repoPath: string) => join(repoPath, ".helm", "plan");
    const planCtx = (repoPath: string): PreflightCtx => {
        let npmScripts: string[] = [];
        try { npmScripts = Object.keys((JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}); }
        catch { /* no package.json / unreadable → no scripts to match against */ }
        return { npmScripts, fileExists: (p) => existsSync(join(repoPath, p)) };
    };
    const readPlanRailState = (repoPath: string): PlanRailState => buildPlanRailState(readPlanFiles(planDirFor(repoPath)), planCtx(repoPath));
    // The renderer plan-channel payload (queue-push). A SUPERSET of PlanRailState: today's single loose-root
    // rail — which the StageRail / PRD / two-phase approval box read and App stores as PlanRailState, all
    // unchanged — PLUS the full multi-draft LIST (the loose-root anonymous draft first, then every <slug>/
    // subdir sorted) that the Conductor's PlanQueueRail renders. Every existing consumer keeps working off the
    // PlanRailState face; only the Conductor reads `.drafts`. One ctx per fire, shared by both halves.
    const buildPlanPush = (repoPath: string): PlanRailState & { drafts: NamedPlanRailState[] } => {
        const ctx = planCtx(repoPath);
        return { ...buildPlanRailState(readPlanFiles(planDirFor(repoPath)), ctx), drafts: composePlanQueueState(repoPath, ctx) };
    };
    // Clear ONLY the approved draft, leaving sibling drafts intact (queue-push): a null name removes the loose-
    // root files (prd.md + tasks.json), a <slug> name removes that whole subdir. The dir itself stays so the
    // watcher's fs.watch handle keeps working. Pre-queue, approve cleared the WHOLE dir; now approving alpha can
    // never wipe beta.
    const clearDraft = (dir: string, name: string | null): void => {
        try {
            if (name == null) for (const f of ["prd.md", "tasks.json"]) rmSync(join(dir, f), { force: true });
            else rmSync(join(dir, name), { recursive: true, force: true });
        } catch { /* already gone / unreadable — nothing to clear */ }
    };

    // Forward-declared so startTask can close over the scheduler it itself is driven by (the merge
    // mutex lives on the scheduler, shared across a project's task loops).
    let scheduler: Scheduler;

    // Hoisted (M5) so both the loop's green branch and the verify-&-merge handback share one wiring.
    const runSetup = async (wt: string, cmd: string, t: number) => {
        const res = await run(cmd, [], { cwd: wt, timeoutMs: t, shell: true });
        return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim() };
    };
    const buildMergeDeps = (taskId: string, config: LoopConfig): MergeStageDeps => ({
        createWorktree, squashMergeInto, runSetup,
        runCheck: (wt, cmd, to) => runCheck(wt, cmd, to),
        runAcceptance: (wt, cmds, to) => runAcceptance(wt, cmds, to),
        removeWorktree, diffStat, advanceBranch, headSha,
        checkTimeoutMs: config.checkTimeoutMs,
        emit: (e) => snapshots.dispatch(taskId, e),
    });
    // The handback deps (verify-&-merge / abandon). runMergeStage is mutex-wrapped per project (no
    // concurrency slot — drop-in freed it; only the merge mutex, so the cap + integration stay safe).
    // M8: the TASK-worktree removal (abandon + the verify-&-merge merged path both go through THIS
    // removeWorktree) first reaps any human shell cwd'd inside it — on Windows an open pwsh holds the
    // dir and would EBUSY the removal. Best-effort unlock only: removeWorktree keeps its tolerant/throwing
    // behavior unchanged. The engine-internal throwaway cleanups (buildMergeDeps/buildPromoteDeps) use the
    // RAW removeWorktree — no PTY can be cwd'd in a merge/promote throwaway, so they are deliberately untouched.
    const buildHandbackDeps = (config: LoopConfig): HandbackDeps => ({
        commitAll,
        runMergeStage: (p, t, b) => scheduler.mutexFor(p.id).withLock(() => runMergeStage(p, t, b, buildMergeDeps(t.id, config))),
        setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
        removeWorktree: async (repo, path, branch, keepBranch) => { ptyManager.killByCwdPrefix(path); await removeWorktree(repo, path, branch, keepBranch); },
    });

    // M6-③ batch-Promote deps: the same throwaway-worktree + setup + re-check engine fns as the merge
    // stage, plus the promotion primitives. The finalize deps inject the ONLY push (pushBranch) — the
    // verify slice inspects exactly this to prove the tool never pushes the target — plus the promoted
    // ledger's write seam: a LANDED direct advance batch-stamps every then-merged task of the project
    // (promotedAt + the validated sha; the cockpit's derived 'promoted' badge reads off the stamp).
    const buildFinalizeDeps = (projectId: string): FinalizeDeps => ({
        pushBranch,
        recordPromotion: (sha) => { stampPromoted(db, projectId, sha); notify(); },
    });
    const buildPromoteDeps = (config: LoopConfig): PromoteStageDeps => ({
        fetchRemote, countCommitsBeyond, revParse, createWorktree, mergeNoFf, runSetup,
        runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
        runAcceptance: (wt, cmds, t) => runAcceptance(wt, cmds, t),
        removeWorktree, headSha, diffStat,
        checkTimeoutMs: config.checkTimeoutMs,
    });

    // M11 pre-flight deps: a throwaway worktree off the integration tip, runSetup, one-shot command runner
    // (shell true, like acceptance), always-cleanup. NOTE the surface has NO advanceBranch/pushBranch — the
    // stage physically cannot advance a ref (the structural never-advance). Uses the RAW removeWorktree (no PTY
    // can be cwd'd in a pre-flight throwaway, exactly like the merge/promote throwaways).
    // The signal makes plans:cancelPreflight kill an IN-FLIGHT command too (exec.ts kills the child on
    // abort); the between-commands abort lives in runPreflight itself. A cancel during runSetup only takes
    // effect once setup finishes — runSetup is the shared merge/handback wiring and stays signal-free.
    const buildPreflightDeps = (config: LoopConfig, signal?: AbortSignal): PreflightDeps => ({
        ensureBranch, revParse, createWorktree, runSetup, removeWorktree,
        runCommand: async (wt, cmd, t) => {
            const r = await run(cmd, [], { cwd: wt, timeoutMs: t, shell: true, signal });
            return { code: r.code, timedOut: r.timedOut, output: `${r.stdout}\n${r.stderr}`.trim() };
        },
        checkTimeoutMs: config.checkTimeoutMs,
    });

    // M5: per-task AbortController registry. tasks:dropIn aborts the controller (hard-killing the live
    // claude via killTree) then awaits `settled` — the loop's handed-off transition — before launching.
    const abortRegistry = new Map<string, { controller: AbortController; settled: Promise<TaskStatus> }>();

    // Run one task's Ralph loop to completion. The scheduler calls this fire-and-forget when a slot
    // is free; landing is delegated to the isolated merge stage, wrapped here in the project's merge
    // mutex (at most one merge in flight per project). The per-task check-in timer (M3) wraps each run.
    const startTask = async (task: Task): Promise<TaskStatus> => {
        const project = getProject(db, task.projectId);
        if (!project) throw new Error(`unknown project ${task.projectId}`);
        const config = resolveLoopConfig(project); // nullable project columns → concrete bounds

        // Register the drop-in interrupt handle. settled resolves with the loop's terminal status when
        // it returns, so a concurrent tasks:dropIn can abort → await the handed-off transition → launch.
        const controller = new AbortController();
        let resolveSettled!: (s: TaskStatus) => void;
        const settled = new Promise<TaskStatus>((res) => { resolveSettled = res; });
        abortRegistry.set(task.id, { controller, settled });

        // Resume discrimination (M5): a re-enqueued handed-off task kept its worktree, so worktreePath
        // is non-null → re-enter in resume mode (reuse the worktree, continue the DB index). A fresh
        // task was inserted with worktreePath = null → clone mode.
        const resume: ResumeContext | undefined = task.worktreePath != null && task.branchName != null
            ? { worktreePath: task.worktreePath, branch: task.branchName, startIndex: listIterations(db, task.id).length }
            : undefined;

        // M13: build the jail spec at THIS edge (like buildSpawnSettings) when the project opts in, so spawn.ts
        // stays decoupled from Project. Absent (host mode) → the loop + spawn behave byte-identically to today.
        // taskBranch MUST equal the loop's branch (the container checks out HELM_TASK_BRANCH; the host pushes it).
        const branch = resume?.branch ?? `${project.branchPrefix}/task-${task.id}`;
        const jailSpec: JailSpec | undefined = project.jailImage ? {
            image: project.jailImage,
            taskId: task.id,
            taskBranch: branch,
            exchangeHostPath: jailExchangePath(task.id),
            setupCommand: project.setupCommand,
            ralph: { instructions: buildInstructions(), task: buildTaskDirective(task), progress: seedProgress(task) },
            envFilePath: jailEnvFilePath(task.id),
        } : undefined;

        const deps: RunTaskDeps = {
            ensureBranch, checkoutBranch, createWorktree, removeWorktree,
            ensureRalphExcluded, writeRalphFiles,
            runSetup,
            // Inject the per-iteration raw-log sink (keyed by taskId + index) AND the per-spawn --settings
            // JSON (M6-② never-push belt + autoMode.environment) at the chokepoint. buildSpawnSettings runs
            // at this ipc edge so spawn.ts stays decoupled from Project (it just forwards the string).
            // M13: inject the jail spec (undefined in host mode → spawn runs `claude` unchanged; present →
            // `docker run … claude …`). The chokepoint stays decoupled from Project — it forwards the spec.
            spawnAgent: (wt, prompt, opts) => spawnAgent(wt, prompt, { ...opts, logSink: createLogSink(logsDir, task.id, opts.iterationIndex ?? 0), settings: buildSpawnSettings(project), jail: jailSpec }),
            commitAll, headSha,
            runCheck: (wt, cmd, t) => runCheck(wt, cmd, t),
            runAcceptance: (wt, cmds, t) => runAcceptance(wt, cmds, t),
            squashMergeInto, diffStat,
            // Mutex-wrapped landing. Emit `merge: waiting` BEFORE acquiring the lock so a task queued
            // for the merge is visible in the feed, then serialize the real merge stage behind the
            // project's mutex (cross-project merges still run concurrently).
            mergeStage: (p, t, taskBranch) => {
                snapshots.dispatch(t.id, { type: "gate", index: 0, label: "merge: waiting" });
                return scheduler.mutexFor(p.id).withLock(() => runMergeStage(p, t, taskBranch, buildMergeDeps(t.id, config)));
            },
            setStatus: (id, status, extra) => { updateTask(db, id, { status, ...extra }); notify(); },
            // M18: an in-place merge-loss recycle never writes a status, so the updateTask chokepoint
            // can't ledger it — this hook keeps recycled losses visible in `helm failures` (pre-stamped
            // 'recycled', so they never read as open/waiting-on-a-human).
            recordRecycled: (id, reason, note) => recordRecycledFailure(db, id, reason, note),
            addIteration: (tid, idx) => addIteration(db, tid, idx),
            // notify() after each finish: a completed iteration records a sessionId, flipping the task's
            // `resumable` true mid-run → the board re-fetches and enables Drop-in without a status change.
            finishIteration: (id, patch) => { finishIteration(db, id, patch); notify(); },
            emit: (e) => snapshots.dispatch(task.id, e),
            signal: controller.signal, // M5: a drop-in hard-kills the in-flight session
            // M13 jail mode: wired ONLY when the project opts in. jailSync = the "git as the wall" sync bound to
            // this task's bare exchange (ensureExchange once, host→exchange before each spawn, exchange→host
            // after); reapJail tears down the container+volume+exchange on a terminal (merged/abandoned) exit.
            jailSync: jailSpec ? {
                prepare: () => ensureExchange(jailSpec.exchangeHostPath),
                syncIn: (wt, b) => pushToExchange(wt, jailSpec.exchangeHostPath, b),
                syncOut: (wt, b) => fetchFromExchange(wt, jailSpec.exchangeHostPath, b),
            } : undefined,
            reapJail: jailSpec ? reapJailResources : undefined,
            log: (m) => console.log(`[helm] ${m}`),
        };

        const stopCheckIns = startCheckInTimer(task.id);
        let result: TaskStatus = "needs-human";
        try {
            result = await runTaskLoop(project, task, config, deps, resume);
            notify();
            return result;
        } finally {
            stopCheckIns();
            abortRegistry.delete(task.id);
            resolveSettled(result); // unblock any awaiting tasks:dropIn (the loop has settled)
        }
    };

    scheduler = createScheduler({
        listQueued: () => listTasks(db).filter((t) => t.status === "queued"),
        getProject: (id) => getProject(db, id),
        startTask,
        // M9 merged-gate: a queued child stays unstarted until every parent id reads "merged" (or is gone).
        getTaskStatus: (id) => getTask(db, id)?.status,
    });

    ipcMain.handle("projects:register", (_e, input: NewProjectInput) => insertProject(db, input));
    ipcMain.handle("projects:list", () => listProjects(db));
    // A raised cap may free conceptual slots → kick the scheduler after a config change.
    ipcMain.handle("projects:update", (_e, id: string, patch: ProjectConfigPatch) => { updateProject(db, id, patch); notify(); scheduler.kick(); return getProject(db, id) ?? null; });
    // Remove a project + all its tasks/iterations (deleteProject cascades atomically), then refresh the
    // board. An in-flight run of a deleted project keeps running in-memory but its DB writes simply no-op
    // (UPDATE ... WHERE id matches nothing) — the reconcile/scheduler already tolerate a vanished row.
    ipcMain.handle("projects:delete", (_e, id: string) => { deleteProject(db, id); notify(); });
    ipcMain.handle("projects:detect", (_e, repoPath: string) => detectProjectConfig(repoPath));
    // M6-③ project-level batch Promote. Mutex-serialized per project (don't promote while a task merge is
    // advancing integration). runPromoteStage validates on a FRESH origin/<target> tip and pushes NOTHING;
    // only on `ready` does finalizePromotion push a non-protected helper branch and return the copyable
    // commands that advance the target — the tool never pushes/merges the target itself.
    ipcMain.handle("projects:promote", (_e, projectId: string): Promise<PromoteResponse> => {
        const project = getProject(db, projectId);
        if (!project) throw new Error(`Helm: promote — unknown project ${projectId}`);
        const config = resolveLoopConfig(project);
        return scheduler.mutexFor(projectId).withLock(async () => {
            const r = await runPromoteStage(project, buildPromoteDeps(config));
            if (r.outcome !== "ready") return r;
            const f = await finalizePromotion(project, r, buildFinalizeDeps(project.id));
            return { ...r, ...f };
        });
    });
    // Create → enqueue → kick: the scheduler auto-starts it when a slot is free (unless paused).
    ipcMain.handle("tasks:create", (_e, input: NewTaskInput) => { const t = insertTask(db, input); notify(); scheduler.kick(); return t; });
    // Augment each task with `resumable` — does drop-in have a PERSISTED session to --resume? latestSessionId
    // is exactly what tasks:dropIn uses, so the button's enabled state matches what the click will actually do.
    // Plus the M9 derived merged-gate view: `blocked` + the `waitingOn` parents (waitingOnFor over the whole
    // board), so the cockpit can render "waiting on X" without the renderer knowing the gate rule.
    // Plus the derived promoted-ledger view: `promoted` (promotedAt != null) — a merged task that graduated
    // to the target via a landed direct Promote. Derived per list like blocked; never a stored TaskStatus.
    // M16: hoisted to a shared fn — the ctl `status` verb reads the SAME board the cockpit reads.
    const listTaskItems = () => {
        const tasks = listTasks(db);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        return tasks.map((t) => {
            const waitingOn = waitingOnFor(t, (id) => byId.get(id));
            return { ...t, resumable: latestSessionId(listIterations(db, t.id)) != null, blocked: waitingOn.length > 0, waitingOn, promoted: isPromoted(t) };
        });
    };
    ipcMain.handle("tasks:list", () => listTaskItems());
    // M9: replace a task's dependency edges — the cockpit's Clear-dependencies affordance on a stuck card
    // passes []. Clearing may unblock the task, so kick the scheduler after (honours pause).
    // M16: hoisted — the ctl `clear-deps` verb calls THIS fn with [] (one implementation, two transports).
    const setDeps = (taskId: string, ids: string[]): void => { setDependsOn(db, taskId, ids); notify(); scheduler.kick(); };
    ipcMain.handle("tasks:setDependsOn", (_e, taskId: string, ids: string[]) => { setDeps(taskId, ids); });

    // M4 scheduler IPC: paused-mode manual single-start, the live cockpit indicator state, pause toggle.
    // M16: the pause body hoisted — the ctl `pause`/`resume` verbs call THIS fn (the button path).
    const setSchedulerPaused = (paused: boolean): void => { scheduler.setPaused(paused); notify(); };
    ipcMain.handle("tasks:startNow", (_e, taskId: string) => { scheduler.startNow(taskId); });
    ipcMain.handle("scheduler:state", () => scheduler.state());
    ipcMain.handle("scheduler:setPaused", (_e, paused: boolean) => { setSchedulerPaused(paused); });

    // ── M5 drop-in handoff (spec §8), M7-retrofitted onto the in-app terminal ──────────────────────
    // Grab a running or needs-human task: hard-interrupt the live claude (freeing the slot), flip it to
    // handed-off (worktree retained), and open a terminal in the worktree resuming the latest session.
    // `fresh` = Start fresh (no --resume). Available from {running, needs-human} only. Returns the in-app
    // PtySession (so the renderer opens the drawer on it), or null for an external launch / any no-op.
    //
    // M7 semantics change: NULL terminalCommand → in-app PTY tab (the new default); non-NULL → external
    // launch via the existing (unchanged) template. The resume-guard + handed-off machine are UNTOUCHED.
    ipcMain.handle("tasks:dropIn", async (_e, taskId: string, fresh?: boolean): Promise<PtySession | null> => {
        const task = getTask(db, taskId);
        if (!task) return null;
        const project = getProject(db, task.projectId);
        if (!project) return null;

        if (task.status === "running") {
            // Abort the in-flight session and AWAIT the handed-off transition (bounded: taskkill + the
            // loop's !ok short-circuit). Capture reg BEFORE awaiting — startTask's finally deletes the
            // entry, but the captured `settled` promise still resolves.
            const reg = abortRegistry.get(taskId);
            if (reg) { reg.controller.abort(); await reg.settled; }
        } else if (task.status === "needs-human") {
            // No live loop — checkpoint (commitAll no-ops on a clean tree) and flip directly.
            if (task.worktreePath) await commitAll(task.worktreePath, "ralph: drop-in checkpoint");
            updateTask(db, taskId, { status: "handed-off" });
            notify();
        } else {
            return null; // queued (no worktree yet) / merged / abandoned — drop-in isn't offered
        }

        // Re-read: a merge that won the race may have landed the task merged (worktree gone) → don't launch.
        const current = getTask(db, taskId);
        if (!current || current.status !== "handed-off" || !current.worktreePath) return null;

        const sessionId = fresh ? null : latestSessionId(listIterations(db, taskId));

        if (project.terminalCommand == null) {
            // In-app tab: a main-resident PTY in the worktree, resuming the latest session (resilient shell).
            return ptyManager.create({
                cwd: current.worktreePath,
                argv: buildDropinArgv(sessionId),
                kind: "dropin",
                title: current.title,
                taskId,
                projectId: project.id,
            });
        }

        // External launch via the (unchanged) template — the project opted out of the in-app tab.
        const resume = sessionId ? `--resume ${sessionId}` : "";
        const launch = launchTerminal(project.terminalCommand, { worktree: current.worktreePath, resume });
        if (!launch.ok) {
            console.log(`[helm] terminal launch failed for task ${taskId}: ${launch.error}`);
            updateTask(db, taskId, { failureReason: `terminal launch failed: ${launch.error}` });
            notify();
        }
        return null;
    });

    // Resume the autonomous loop from the human's committed state: commit the handback, re-enqueue
    // (worktree retained → startTask resumes), kick. Honours pause (a paused fleet shows the manual Run).
    ipcMain.handle("tasks:resume", async (_e, taskId: string) => {
        const task = getTask(db, taskId);
        if (!task || task.status !== "handed-off") return;
        if (task.worktreePath) await commitAll(task.worktreePath, "ralph: handback");
        updateTask(db, taskId, { status: "queued" }); // worktreePath retained → resume discrimination
        notify();
        scheduler.kick();
    });

    // "I finished it — verify & merge": commit the handback, then the M4 merge stage, mutex-serialized
    // (no concurrency slot — drop-in freed it). Fire-and-forget; the task stays handed-off during the merge.
    ipcMain.handle("tasks:verifyAndMerge", (_e, taskId: string) => {
        const task = getTask(db, taskId);
        if (!task || task.status !== "handed-off") return; // guard a double-click / resume-then-verify
        const project = getProject(db, task.projectId);
        if (!project) return;
        const config = resolveLoopConfig(project);
        const taskBranch = task.branchName ?? `${project.branchPrefix}/task-${task.id}`;
        snapshots.dispatch(task.id, { type: "gate", index: 0, label: "merge: waiting" });
        // M13: a jailed task that verify-&-merges to `merged` has its worktree removed → reap its jail
        // resources too (host mode / non-merged → no-op). Gated on jailImage so host tasks never touch docker.
        void verifyAndMerge(project, task, taskBranch, buildHandbackDeps(config)).then(async (r) => {
            if (r.outcome === "merged" && project.jailImage) await reapJailResources(task.id);
            notify();
        });
    });

    // Abandon: reap the retained worktree + branch, flag abandoned.
    // M16: hoisted — the ctl `abandon` verb calls THIS fn, so a pipe-steered abandon goes through the
    // exact same mutex-wrapped handback (+ jail reap) as the cockpit button.
    const abandonTask = async (taskId: string): Promise<void> => {
        const task = getTask(db, taskId);
        if (!task) return;
        const project = getProject(db, task.projectId);
        if (!project) return;
        const config = resolveLoopConfig(project);
        const taskBranch = task.branchName ?? `${project.branchPrefix}/task-${task.id}`;
        await abandon(project, task, taskBranch, buildHandbackDeps(config));
        if (project.jailImage) await reapJailResources(task.id); // M13: reap the jail container+volume+exchange
        notify();
    };
    ipcMain.handle("tasks:abandon", (_e, taskId: string) => abandonTask(taskId));

    // Observability reads. getVerifyState prefers the live snapshot (with its in-memory feed) and
    // falls back to one rebuilt from durable DB rows (empty feed) for inactive/restarted tasks.
    ipcMain.handle("tasks:verifyState", (_e, taskId: string) => {
        const live = snapshots.get(taskId);
        if (live) return live;
        const task = getTask(db, taskId);
        return task ? snapshotFromRows(task, listIterations(db, taskId)) : null;
    });
    ipcMain.handle("tasks:progress", (_e, taskId: string): string | null => {
        const task = getTask(db, taskId);
        if (!task?.worktreePath) return null; // worktree gone (terminal cleanup) → no progress file
        try { return readFileSync(join(task.worktreePath, ".ralph", "progress.md"), "utf8"); }
        catch { return null; }
    });

    // ── M7 embedded terminal IPC (spec §8/§4) ─────────────────────────────────────────────────────
    // Drive the single PtyManager. attach wires the main-side scrollback-replay-then-live stream to the
    // renderer via pty:data (utf8 strings are fine at v1 volumes); detach stops it WITHOUT killing (a
    // closed view ≠ a closed session). Kill is the only thing that ends a session; disposePtys (Quit)
    // ends them all. The drop-in retrofit (tasks:dropIn) creates its session in-process via ptyManager
    // directly — these handlers are the general surface the renderer + M8 free-tabs also use.
    ipcMain.handle("pty:create", (_e, opts: CreatePtyOptions) => ptyManager.create(opts));
    ipcMain.handle("pty:write", (_e, id: string, data: string) => { ptyManager.write(id, data); });
    ipcMain.handle("pty:resize", (_e, id: string, cols: number, rows: number) => { ptyManager.resize(id, cols, rows); });
    ipcMain.handle("pty:kill", (_e, id: string) => { ptyManager.kill(id); });
    ipcMain.handle("pty:list", () => ptyManager.list());
    ipcMain.handle("pty:attach", (_e, id: string) => { ptyManager.attach(id, (chunk) => getWindow()?.webContents.send("pty:data", id, chunk)); });
    ipcMain.handle("pty:detach", (_e, id: string) => { ptyManager.detach(id); });

    // ── M16 conductor pane (M10's planner absorbed — spec §4) ─────────────────────────────────────
    // The conductor is the project's ONE persistent interactive claude session (kind "planner" — the
    // M10 value, kept stable). The M10 plan-dir + watcher plumbing is unchanged; what changed is the
    // launch contract: open = READ-ONLY hydration (never spawns), launch = the explicit human click.
    const ensurePlanWatch = (project: Project): void => {
        const dir = planDirFor(project.repoPath);
        mkdirSync(dir, { recursive: true });
        ensureHelmExcluded(project.repoPath);
        if (!planWatchers.has(project.id)) {
            planWatchers.set(project.id, watchPlanDir(dir, () => {
                getWindow()?.webContents.send("plan:changed", project.id, buildPlanPush(project.repoPath));
            }));
        }
    };
    const liveConductor = (projectId: string) =>
        ptyManager.list().find((s) => s.kind === "planner" && s.projectId === projectId && s.alive);
    // The resume-guard, conductor edition (M5 kernel "recorded ⇔ resumable"): the recorded id counts
    // only if claude actually persisted that session on disk — a launch that died before the first
    // completed turn leaves no file, so Resume stays disabled and we can never `claude --resume` a
    // conversation claude can't find (spec §6).
    const conductorResumable = (project: Project): boolean =>
        isConductorResumable(project.conductorSessionId, existsSync, homedir(), project.repoPath);

    // The shared spawn body for launch + restart (NOT the reuse/kill decision — that's each caller's).
    // fresh=false resumes ONLY when the guard holds (belt: a stale renderer can't force --resume); anything
    // else forces a fresh --session-id and records it UP FRONT so the next open can offer Resume once claude
    // persists a turn. The resilient `pwsh -NoExit` wrapper is the M5 contract; default permission mode,
    // NOT through spawn.ts — the human seam.
    const spawnConductor = (project: Project, fresh: boolean): PtySession => {
        const resume = !fresh && conductorResumable(project);
        let sessionId = project.conductorSessionId;
        if (!resume) {
            sessionId = randomUUID();
            recordConductorSession(db, project.id, sessionId);
        }
        return ptyManager.create({
            cwd: project.repoPath,
            argv: buildConductorArgv(sessionId, resume),
            kind: "planner",
            title: `${project.name} — conductor`,
            projectId: project.id,
        });
    };

    ipcMain.handle("conductor:open", (_e, projectId: string): ConductorOpenResult | null => {
        const project = getProject(db, projectId);
        if (!project) return null;
        ensurePlanWatch(project);
        const alive = liveConductor(projectId);
        let session: PtySession | null = null;
        if (alive) { const { alive: _a, ...meta } = alive; session = meta; }
        return { session, state: buildPlanPush(project.repoPath), resumable: conductorResumable(project) };
    });

    // Launch on the human's click. A live session is reused (idempotent — a double-click can't fork the
    // conversation). fresh=false resumes ONLY when the guard holds (belt: a stale renderer can't force
    // --resume); anything else is a fresh session whose id is forced (--session-id) and recorded
    // UP FRONT, so the next open can offer Resume once claude persists a turn. The resilient
    // `pwsh -NoExit` wrapper (buildConductorArgv) is the M5 contract: a failed claude lands at a live
    // shell in the repo, never a dead tab. Default permission mode, NOT through spawn.ts — human seam.
    ipcMain.handle("conductor:launch", (_e, projectId: string, fresh: boolean): PtySession | null => {
        const project = getProject(db, projectId);
        if (!project) return null;
        ensurePlanWatch(project);
        const alive = liveConductor(projectId);
        if (alive) { const { alive: _a, ...meta } = alive; return meta; }
        return spawnConductor(project, fresh);
    });

    // The always-on in-pane restart (issue #1). `-NoExit` keeps the conductor pwsh alive after `claude`
    // exits, so the pane stays "live" and never falls back to the launch panel — the user is wedged at a
    // dead shell with claude's "Resume this session with…" message and no button. Restart is the button:
    // it KILLS the live conductor pwsh (unlike launch, which idempotently reuses it) and respawns a fresh
    // or resumed session per the SAME guard. The kill sets alive=false synchronously, so spawnConductor's
    // next liveConductor probe (in a following open) won't see the corpse; the new session is returned.
    ipcMain.handle("conductor:restart", (_e, projectId: string, fresh: boolean): PtySession | null => {
        const project = getProject(db, projectId);
        if (!project) return null;
        ensurePlanWatch(project);
        const alive = liveConductor(projectId);
        if (alive) ptyManager.kill(alive.id);
        return spawnConductor(project, fresh);
    });

    // M11 plan views (reads): the two joins the board's plan badge + plan-detail need. db/plans.ts already
    // holds the fns; these just surface them (getPlan → null so the renderer's `| null` handle is honoured).
    ipcMain.handle("plans:list", (_e, projectId: string) => listPlans(db, projectId));
    ipcMain.handle("plans:get", (_e, planId: string) => getPlan(db, planId) ?? null);

    // M11 dynamic pre-flight (phase 1 of the two-phase approve): re-read + re-validate from disk, then EXECUTE
    // each acceptance command once in a throwaway worktree off the integration tip and classify it. A still-
    // invalid draft yields the parse errors (hard-block, exactly like approve). NO merge mutex — pre-flight is
    // read-only validation off whatever tip it sees; racing a merge is harmless (validated one merge old at worst).
    ipcMain.handle("plans:preflight", async (_e, projectId: string): Promise<PreflightRunResult> => {
        const project = getProject(db, projectId);
        if (!project) return { ok: false, errors: [`unknown project ${projectId}`] };
        // One run at a time per project — a second concurrent run would share the deterministic throwaway
        // branch/path with the first and pre-clean it out from under the live commands.
        if (preflightAborts.has(projectId)) return { ok: false, errors: ["a pre-flight is already running for this project"] };
        const files = readPlanFiles(planDirFor(project.repoPath));
        if (files.tasksJson == null) return { ok: false, errors: ["no tasks.json in .helm/plan/ to pre-flight"] };
        const parsed = parsePlanDraft(files.tasksJson);
        if (!parsed.ok) return { ok: false, errors: parsed.errors };
        const staticV = staticPreflight(parsed.draft, planCtx(project.repoPath));
        const controller = new AbortController();
        preflightAborts.set(projectId, controller);
        // A thrown pre-flight (bad repo state, git failure, cancel) must reach the renderer as a STRUCTURED
        // error, never an ipc rejection — the M10-acceptance finding: an uncaught rejection stuck "loading".
        try {
            const report = await runPreflight(project, parsed.draft, staticV, buildPreflightDeps(resolveLoopConfig(project), controller.signal), {
                signal: controller.signal,
                onProgress: (p) => getWindow()?.webContents.send("preflight:progress", projectId, p),
            });
            // Store the run server-side: approve validates acks against THIS report (draft-hash staleness),
            // never re-executing. Latest run wins; the runId ties the renderer's acks to this exact report.
            const runId = randomUUID();
            preflightRuns.put(projectId, { runId, draftHash: hashDraft(files.tasksJson), integrationSha: report.integrationSha ?? "", report, createdAt: Date.now() });
            return { ok: true, runId, report };
        } catch (err) {
            return { ok: false, errors: [`pre-flight failed: ${(err as Error)?.message ?? String(err)}`] };
        } finally {
            preflightAborts.delete(projectId);
        }
    });

    // Cancel an in-flight pre-flight run (the loading state's Cancel button). Abort kills the current
    // command's child process AND trips the between-commands check; the run's finally still reaps the
    // throwaway worktree, and the thrown cancel surfaces as the structured "pre-flight failed: … cancelled".
    ipcMain.handle("plans:cancelPreflight", async (_e, projectId: string): Promise<void> => {
        preflightAborts.get(projectId)?.abort();
    });

    // Approve ONE draft: re-read + re-validate from disk (never the renderer's copy — it can be stale or
    // spoofed). Any parse failure → structured rejection, NO rows. Then the M11 gate: unless the human explicitly
    // Skipped pre-flight, RE-RUN pre-flight from disk and re-assert every warn is acked (the renderer's report is
    // never trusted). Only past the gate, in ONE transaction: insertPlan (PRD text copied; missing prd.md →
    // stored "" + a warn, so approve isn't wedged) then the tasks in topological order, resolving slug edges to
    // the real ids (the M9 column). After commit: clear ONLY this draft (rows are now durable), refresh the board,
    // kick the scheduler (honours pause). The just-queued tasks then flow through the merged-gate like hand-made ones.
    // Queue-push: opts carry an optional draft NAME (rides ApproveOptions across the dynamically-typed ipc). A
    // null/absent name approves the loose root (back-compat); a <slug> name approves THAT .helm/plan/<slug>/
    // subdir's files. An unknown name resolves to no files → the "no tasks.json" guard, never the root's files.
    ipcMain.handle("plans:approve", async (_e, projectId: string, opts?: ApproveOptions): Promise<ApprovePlanResult> => {
        const project = getProject(db, projectId);
        if (!project) return { ok: false, errors: [`unknown project ${projectId}`] };
        const dir = planDirFor(project.repoPath);
        const name = (opts as (ApproveOptions & { name?: string | null }) | undefined)?.name ?? null;
        const files = resolveDraftFiles(dir, name);
        if (files.tasksJson == null) return { ok: false, errors: [`no tasks.json in .helm/plan/${name ? name + "/" : ""} to approve`] };

        const approved = approveFromTasksJson(files.tasksJson, files.prdText, () => randomUUID());
        if (!approved.ok) return { ok: false, errors: approved.errors }; // parse-invalid → NO rows

        // The ack gate (overhauled 2026-07-14). Skip is an explicit human escape (a hurry stays in control);
        // otherwise validate the acks against the SERVER-STORED run — approve NEVER executes commands. Stale
        // (no run / superseded runId / tasks.json changed on disk since the run) → structured stale error, the
        // renderer offers a re-run. Success CONSUMES the run: a double-Confirm finds nothing and fails stale
        // instead of inserting the plan twice (the elektronik-and-pant ×2 lesson).
        if (!opts?.skipPreflight) {
            const v = validateApproval(preflightRuns.peek(projectId), { runId: opts?.runId, draftHashNow: hashDraft(files.tasksJson), acks: opts?.acks ?? [] });
            if (!v.ok) return { ok: false, stale: v.stale, errors: v.errors };
            preflightRuns.consume(projectId, opts!.runId!);
        }

        const warnings = files.prdText == null ? ["no prd.md in .helm/plan/ — stored an empty PRD for this plan"] : [];
        // Stamp the plan-queue columns from the draft's publish metadata (optional top-level tasks.json
        // fields; absent/bad values fall to the safe defaults — null order, null parent, 'strict' gate).
        const queueMeta = planQueueMetaFromDraft(files.tasksJson);
        db.transaction(() => {
            const plan = insertPlan(db, { projectId, title: approved.plan.planTitle, prdText: approved.plan.prdText, ...queueMeta });
            for (const ins of approved.plan.inserts) insertPlanTask(db, { ...ins, projectId, planId: plan.id });
        })();

        clearDraft(dir, name); // only THIS draft's files — a sibling <slug>/ draft stays on disk, still Approvable
        if (name == null) preflightRuns.clear(projectId); // the loose-root drop is gone — its stored run is moot
        getWindow()?.webContents.send("plan:changed", projectId, buildPlanPush(project.repoPath));
        notify();
        scheduler.kick();
        return { ok: true, count: approved.plan.inserts.length, warnings };
    });

    // ── M16 blessed CLI: the shared actions + the pipe server (spec §3/§6) ─────────────────────────
    // ONE implementation, TWO transports: the steer verbs below ARE the button paths (the exact fns the
    // ipc handlers call — pause/resume = scheduler:setPaused, abandon = the mutex-wrapped tasks:abandon
    // body, clear-deps = tasks:setDependsOn with []); the reads compose the same db/rail reads the
    // cockpit uses. No verb creates tasks/projects — intake stays on the .helm/plan/ ack-gated seam.
    const resolveProjectSel = (sel: ProjectSelector): Project | undefined => {
        const projects = listProjects(db);
        if (sel.project) {
            const name = sel.project.toLowerCase();
            return projects.find((p) => p.name.toLowerCase() === name);
        }
        if (sel.cwd) {
            // The conductor session runs at the project's repo root — scope by the caller's cwd.
            const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const cwd = norm(sel.cwd);
            return projects.find((p) => cwd === norm(p.repoPath) || cwd.startsWith(norm(p.repoPath) + "/"));
        }
        return undefined;
    };
    const taskCostUsd = (taskId: string): number =>
        Math.round(listIterations(db, taskId).reduce((a, it) => a + (it.costUsd ?? 0), 0) * 100) / 100;
    const ctlActions: CtlActions = {
        status: (sel) => {
            const scoped = resolveProjectSel(sel);
            if (sel.project && !scoped) throw new Error(`unknown project "${sel.project}"`);
            const names = new Map(listProjects(db).map((p) => [p.id, p.name]));
            const rows = listTaskItems().filter((t) => !scoped || t.projectId === scoped.id);
            return {
                paused: scheduler.state().paused,
                project: scoped?.name ?? null,
                tasks: rows.map((t) => ({
                    id: t.id, title: t.title, project: names.get(t.projectId) ?? t.projectId, status: t.status,
                    blocked: t.blocked, waitingOn: t.waitingOn.map((w) => `${w.title} (${w.status})`),
                    failureReason: t.failureReason, costUsd: taskCostUsd(t.id),
                })),
            };
        },
        taskDetail: (id) => {
            const task = getTask(db, id);
            if (!task) throw new Error(`unknown task ${id}`);
            return {
                ...task,
                costUsd: taskCostUsd(id),
                iterations: listIterations(db, id).map((it) => ({
                    index: it.index, verdict: it.gateVerdict, costUsd: it.costUsd, durationMs: it.durationMs,
                    tail: it.outputTail ? it.outputTail.slice(-400) : null,
                })),
            };
        },
        progressTail: (id) => {
            const task = getTask(db, id);
            if (!task) throw new Error(`unknown task ${id}`);
            if (!task.worktreePath) return { taskId: id, progress: null, note: "worktree gone (terminal cleanup) — no progress file" };
            try {
                const lines = readFileSync(join(task.worktreePath, ".ralph", "progress.md"), "utf8").split(/\r?\n/);
                return { taskId: id, progress: lines.slice(-60).join("\n") };
            } catch { return { taskId: id, progress: null, note: "no progress.md yet" }; }
        },
        planStatus: (sel) => {
            const project = resolveProjectSel(sel);
            if (!project) throw new Error("no project matched — pass --project <name> or run inside a registered repo");
            const state = readPlanRailState(project.repoPath);
            return {
                project: project.name,
                plans: listPlans(db, project.id).map((p) => ({ id: p.id, title: p.title, createdAt: p.createdAt })),
                draft: {
                    stage: state.stage,
                    parse: state.parse == null ? null : state.parse.ok
                        ? { ok: true as const, tasks: state.parse.draft.tasks.map((c) => ({ slug: c.slug, title: c.title, dependsOn: c.dependsOn })) }
                        : { ok: false as const, errors: state.parse.errors },
                    verdicts: state.verdicts,
                },
            };
        },
        // M17: the failure-ledger read (read-only — the 9th blessed verb mutates nothing). Scopes to the
        // selected project like every other scoped read; --all widens to the fleet. Returns the by-kind
        // rollup + the recent rows (task titles joined in) — deeper slicing is the conductor's job.
        failures: (q) => {
            const scoped = resolveProjectSel(q);
            if (q.project && !scoped) throw new Error(`unknown project "${q.project}"`);
            if (!q.all && !scoped) throw new Error("no project matched — pass --project <name>, run inside a registered repo, or pass --all");
            const filter = { projectId: q.all ? undefined : scoped!.id, open: q.open, kind: q.kind };
            const titles = new Map(listTasks(db).map((t) => [t.id, t.title]));
            return {
                project: q.all ? null : scoped!.name,
                summary: summarizeFailures(db, filter),
                recent: listFailures(db, filter).map((f) => ({
                    kind: f.kind, taskId: f.taskId, task: titles.get(f.taskId) ?? "(deleted task)",
                    iteration: f.iterationIndex, reason: f.reason, createdAt: f.createdAt,
                    resolution: f.resolution, resolvedAt: f.resolvedAt,
                })),
            };
        },
        pause: () => setSchedulerPaused(true),
        resume: () => setSchedulerPaused(false),
        abandonTask,
        clearDeps: (id) => setDeps(id, []),
    };
    const ctlServer = startCtlServer(ctlPipeName, buildCtlVerbs(ctlActions));

    // ── M6 ① boot reconcile (spec §4 "process death is cheap") ────────────────────────────────────
    // Close out the interrupted turn's still-open iteration: mark it FAILED, and — critically — leave
    // sessionId NULL (the M5 resume-guard: a crash-killed turn persisted no resumable claude session, so
    // drop-in's latestSessionId must not target it). Never passes sessionId.
    const closeOutDangling = (taskId: string): void => {
        const last = listIterations(db, taskId).at(-1);
        if (last && last.endedAt == null) {
            finishIteration(db, last.id, { gateVerdict: "failed", outputTail: "interrupted by shutdown/crash" });
        }
    };

    // Reconcile ONE project's DB ↔ git: list git state, filter to worktrees under worktreeDir (the
    // reconcile safety contract — the primary checkout must never reach the planner), plan with the pure
    // reconcile(), then apply each action with real git/DB fns. Its real effects are covered by manual
    // acceptance (a headless slice with fake git can't prove real reconciliation).
    const runReconcile = async (project: Project): Promise<void> => {
        const config = resolveLoopConfig(project);
        const wts = (await listWorktrees(project.repoPath)).filter((w) => isUnderWorktreeDir(w.path, project.repoPath, project.worktreeDir));
        const branches = await listBranches(project.repoPath);
        const tasks = listTasks(db).filter((t) => t.projectId === project.id);
        const byId = new Map(tasks.map((t) => [t.id, t]));

        for (const action of reconcile(tasks, { worktrees: wts, branches })) {
            switch (action.type) {
                case "requeue": {
                    // Intact worktree → close out the dangling iteration, checkpoint any dirty bytes
                    // (commitAll no-ops on a clean tree), flip to queued. worktreePath RETAINED → the boot
                    // kick resumes it via the M5 resume path (worktreePath != null discriminator).
                    closeOutDangling(action.taskId);
                    const task = byId.get(action.taskId);
                    if (task?.worktreePath) await commitAll(task.worktreePath, "ralph: crash-recovery checkpoint");
                    updateTask(db, action.taskId, { status: "queued" });
                    break;
                }
                case "rebuild": {
                    // Worktree gone but branch alive → recreate the worktree from the branch tip, reseed the
                    // lost .ralph files (progress.md was in the lost worktree; the committed code on the branch
                    // is intact), reinstall deps, then queue it. Resume mode then skips clone/.ralph/setup.
                    const task = byId.get(action.taskId);
                    if (!task) break;
                    closeOutDangling(action.taskId);
                    const path = worktreePathFor(project.repoPath, project.worktreeDir, action.branch);
                    await addWorktreeForBranch(project.repoPath, path, action.branch);
                    ensureRalphExcluded(project.repoPath);
                    writeRalphFiles(path, { instructions: buildInstructions(), progress: seedProgress(task), task: buildTaskDirective(task) });
                    if (project.setupCommand) await runSetup(path, project.setupCommand, config.checkTimeoutMs);
                    updateTask(db, action.taskId, { worktreePath: path, status: "queued" });
                    break;
                }
                case "to-needs-human": {
                    closeOutDangling(action.taskId);
                    // M17: the kind is stamped HERE (the apply site), not in the pure planner — every
                    // to-needs-human reconcile action means worktree+branch both gone, nothing to resume.
                    updateTask(db, action.taskId, { status: "needs-human", failureReason: action.reason, failure: { kind: "boot-unrecoverable", iterationIndex: null } });
                    break;
                }
                case "prune-worktree": {
                    // M8: reap any human shell holding the orphan worktree dir BEFORE removing it (a live
                    // pwsh EBUSY-wedges the removal on Windows). reconcile only ever prunes helm throwaways /
                    // no-owner / terminal-owned worktrees — never a handed-off/needs-human/requeued one — so
                    // this never kills a shell in a worktree the human is still meant to be steering.
                    ptyManager.killByCwdPrefix(action.path);
                    // Tolerant — a partially-removed worktree may throw; the postcondition "gone" is what matters.
                    try { await removeWorktree(project.repoPath, action.path, action.branch ?? "", false); }
                    catch (e) { console.log(`[helm] prune skipped for ${action.path}: ${e instanceof Error ? e.message : String(e)}`); }
                    // M13: if a JAILED task owned this pruned worktree (a crash mid terminal-teardown left it),
                    // reap its jail resources too — the per-task volume outlives the worktree by design, so the
                    // loop's terminate is the normal reaper; this is the crash-safety net. Matched by path.
                    if (project.jailImage) {
                        const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
                        const owner = tasks.find((t) => t.worktreePath && norm(t.worktreePath) === norm(action.path));
                        if (owner) await reapJailResources(owner.id);
                    }
                    break;
                }
            }
        }
        notify(); // reflect the reconciled state on the board
    };

    // Boot: reconcile each project's DB ↔ git (crash-resume + orphan-prune) BEFORE the kick — a
    // requeued/rebuilt task must be `queued` in the DB before the scheduler scans, or it's skipped until
    // the next event. Then auto-start any queued tasks (created this session or in a prior one — the
    // scheduler is otherwise event-driven and would leave them idle). Each project's reconcile is wrapped
    // so one bad repo (e.g. deleted on disk) logs + skips rather than aborting the whole boot.
    void (async () => {
        for (const project of listProjects(db)) {
            try { await runReconcile(project); }
            catch (e) { console.log(`[helm] reconcile failed for project ${project.id}: ${e instanceof Error ? e.message : String(e)}`); }
        }
        // M13: reap any lingering helm-jail- container a crash left behind (a normal run auto-removes via --rm).
        // Best-effort + skipped entirely when no project is jailed, so a host-only Helm never invokes docker.
        try { await reapOrphanJailContainers(); }
        catch (e) { console.log(`[helm] jail orphan reap skipped: ${e instanceof Error ? e.message : String(e)}`); }
        scheduler.kick();
    })();

    // The soft hourly check-in (spec §5.3): an OS Notification each interval with the live iteration
    // count + latest activity. Never kills; cleared when the loop terminates. Pure cadence math lives
    // in checkIn.ts — this is the untested Electron edge.
    function startCheckInTimer(taskId: string): () => void {
        const startedAt = Date.now();
        let fired = 0;
        const id = setInterval(() => {
            const due = checkInsDue(Date.now() - startedAt);
            if (due <= fired) return;
            fired = due;
            const snap = snapshots.get(taskId);
            const iters = snap?.iterations.length ?? 0;
            const activity = snap?.currentIteration?.latestActivity || "(working)";
            new Notification({ title: `Helm — task still running (${iters} iteration${iters === 1 ? "" : "s"})`, body: activity }).show();
        }, CHECKIN_POLL_MS);
        return () => clearInterval(id);
    }

    // M12: set the tray tooltip once at startup so it reflects the persisted board immediately (before any
    // mutation). Every later board change refreshes it via notify() → refreshTray().
    refreshTray();

    // Handed to index.ts's before-quit: a real Quit kills every live PTY session (no orphan pwsh/conhost)
    // and closes every plan watcher (M10). A window-hide (M6-④ tray) must NOT call this — sessions + watchers
    // keep running in the main process.
    // M13: on quit, best-effort fire-and-forget reap of any running jail container (a quit leaves the
    // daemon-owned container running — the reliable cleanup is the boot reap next launch; this is a courtesy).
    return { disposePtys: () => { ctlServer.close(); for (const dispose of planWatchers.values()) dispose(); planWatchers.clear(); ptyManager.disposeAll(); void reapOrphanJailContainers().catch(() => {}); } };
}
