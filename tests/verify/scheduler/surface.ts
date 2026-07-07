// tests/verify/scheduler/surface.ts
// The M4 verify SURFACE. A single per-task EngineSnapshot can't express concurrency, so this slice
// records a CROSS-TASK timeline: it drives the REAL scheduler + the REAL per-project mutex (via
// scheduler.mutexFor, mimicking the ipc wiring) + the REAL runMergeStage, with fake git/check deps,
// and distills a flat SchedulerRecording the invariants read. Merges share one project mutex, so two
// same-project merges can only interleave if the mutex fails — making the recording a real test of it.
import { createScheduler } from "../../../src/main/engine/scheduler";
import { runMergeStage, type MergeStageDeps } from "../../../src/main/engine/mergeStage";
import type { Project, Task, TaskStatus } from "../../../src/shared/types";

export interface MergeInterval {
    taskId: string;
    projectId: string;
    enter: number;                    // logical tick when this merge acquired the mutex and started
    exit: number;                     // logical tick when runMergeStage returned (mutex released after)
    recheckPassed: boolean;           // did check ∧ acceptance pass against the fresh tip?
    recheckRanBeforeAdvance: boolean; // was the re-check observed before advanceBranch?
    advanced: boolean;                // did this merge advance the integration ref?
}

export interface SchedulerRecording {
    unit: "scheduler";
    caps: Record<string, number>;                 // per-project cap (concurrencyCap ?? 3)
    maxRunningPerProject: Record<string, number>; // peak observed running per project
    merges: MergeInterval[];
}

export interface ScenarioTask { id: string; projectId: string; recheckPasses: boolean; }
export interface Scenario { projects: Project[]; tasks: ScenarioTask[]; }

export const mkProject = (id: string, concurrencyCap: number | null): Project => ({
    id, name: id, repoPath: "/r", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph",
    checkCommand: "c", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null,
    stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null,
});
export const mkTask = (id: string, projectId: string, createdAt: number): Task => ({
    id, projectId, title: id, intent: "", acceptance: ["x"], status: "queued", scopeHint: null, dependsOn: [], planId: null,
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt, updatedAt: createdAt,
});

// Drive the real units through one scenario and distill the recording. Deterministic: a logical clock
// (not wall time) timestamps merge enter/exit; everything is event-driven (no timers).
export async function runScenario(scenario: Scenario): Promise<SchedulerRecording> {
    const caps: Record<string, number> = {};
    for (const p of scenario.projects) caps[p.id] = p.concurrencyCap ?? 3;
    const maxRunningPerProject: Record<string, number> = {};
    const merges: MergeInterval[] = [];

    let clock = 0;
    const tick = () => ++clock;

    const projectById = new Map(scenario.projects.map((p) => [p.id, p]));
    const scenById = new Map(scenario.tasks.map((t) => [t.id, t]));
    let queued: Task[] = scenario.tasks.map((t, i) => mkTask(t.id, t.projectId, i));

    let scheduler!: ReturnType<typeof createScheduler>;
    const sample = () => {
        for (const { projectId, running } of scheduler.state().perProject) {
            maxRunningPerProject[projectId] = Math.max(maxRunningPerProject[projectId] ?? 0, running);
        }
    };

    let remaining = scenario.tasks.length;
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => { resolveDone = res; });

    const startTask = async (task: Task): Promise<TaskStatus> => {
        queued = queued.filter((q) => q.id !== task.id);
        sample(); // a slot was just claimed — capture the peak running count
        const scen = scenById.get(task.id)!;
        const project = projectById.get(task.projectId)!;

        // Mimic the ipc wiring: the merge runs INSIDE the project's mutex. The interval is the span of
        // runMergeStage; the mutex guarantees same-project intervals are disjoint.
        const result = await scheduler.mutexFor(task.projectId).withLock(async () => {
            const enter = tick();
            sample();
            let recheckRan = false, advanced = false, recheckRanBeforeAdvance = false;
            const deps: MergeStageDeps = {
                createWorktree: async () => `/wt/${task.id}`,
                squashMergeInto: async () => ({ merged: true, conflict: false }),
                runSetup: async () => ({ ok: true, output: "" }),
                runCheck: async () => { recheckRan = true; return { green: scen.recheckPasses, timedOut: false, output: "" }; },
                runAcceptance: async () => ({ ok: true, output: "" }),
                removeWorktree: async () => {},
                diffStat: async () => "+1 -0",
                advanceBranch: async () => { advanced = true; recheckRanBeforeAdvance = recheckRan; },
                headSha: async () => `sha-${task.id}`,
                checkTimeoutMs: 1000,
            };
            try {
                return await runMergeStage(project, task, `ralph/task-${task.id}`, deps);
            } finally {
                merges.push({ taskId: task.id, projectId: task.projectId, enter, exit: tick(), recheckPassed: scen.recheckPasses, recheckRanBeforeAdvance, advanced });
            }
        });
        return result.outcome === "merged" ? "merged" : "needs-human";
    };

    scheduler = createScheduler({
        listQueued: () => queued,
        getProject: (id) => projectById.get(id),
        // M4 fixtures carry no dependency edges, so depsSatisfied([]) short-circuits true and this is never
        // consulted — a stub keeps the M4 slice byte-identical while satisfying the widened deps shape.
        getTaskStatus: () => undefined,
        startTask: (task) => {
            const p = startTask(task);
            void p.finally(() => { if (--remaining === 0) resolveDone(); });
            return p;
        },
    });

    if (remaining === 0) resolveDone();
    scheduler.kick();
    await done;
    return { unit: "scheduler", caps, maxRunningPerProject, merges };
}
