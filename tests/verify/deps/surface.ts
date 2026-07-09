// tests/verify/deps/surface.ts
// The M9 verify SURFACE. A single per-task snapshot can't express the merged-gate (it's a cross-task
// relationship), so this slice records a CROSS-TASK view: it drives the REAL scheduler (with the REAL
// depsSatisfied gate inside it) plus the REAL waitingOnFor derivation, over fake startTask/getTaskStatus
// with deferred-promise settles, and distills a flat DepsRecording the invariants read. Complementary to,
// and separate from, the M4 tests/verify/scheduler/ slice (whose staying-green is the byte-identical witness).
import { createScheduler } from "../../../src/main/engine/scheduler";
import { waitingOnFor } from "../../../src/main/engine/deps";
import type { Project, Task, TaskStatus } from "../../../src/shared/types";

export interface ScenarioTask {
    id: string;
    dependsOn?: string[];
    initialStatus?: TaskStatus; // default "queued" (a non-queued seed models a parent already stuck/merged)
    settlesTo?: TaskStatus;     // what a started task settles to when released (default "merged")
}
export interface Scenario { cap?: number | null; tasks: ScenarioTask[]; }

export interface ParentObservation { id: string; status: TaskStatus | undefined }
export interface StartObservation { taskId: string; parents: ParentObservation[]; } // parent statuses AT start
export interface DerivationObservation { taskId: string; blocked: boolean; waitingOnIds: string[]; parents: ParentObservation[]; }

export interface DepsRecording {
    unit: "deps";
    hasEdges: boolean;                       // any task carries a dependency edge?
    startOrder: string[];                    // order the REAL scheduler started tasks
    fifoOrder: string[];                     // createdAt order of the initially-queued tasks (the M4 baseline)
    starts: StartObservation[];              // for each start: the parent statuses observed at that instant
    derivations: DerivationObservation[];    // waitingOnFor over the initial board, per task
}

export const mkProject = (concurrencyCap: number | null): Project => ({
    id: "p", name: "p", repoPath: "/r", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph",
    checkCommand: "c", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null,
    stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
const mkTask = (id: string, createdAt: number, dependsOn: string[], status: TaskStatus): Task => ({
    id, projectId: "p", title: id, intent: "", acceptance: ["x"], status, scopeHint: null, dependsOn, planId: null,
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt, updatedAt: createdAt,
});

// Drive the real scheduler through one scenario and distill the recording. Deterministic: no timers, only
// microtask flushes; started tasks hang on a deferred resolver we release one at a time (in start order),
// so a parent's release re-kicks and may unblock its child — exactly the merged-gate under test.
export async function runScenario(scenario: Scenario): Promise<DepsRecording> {
    const project = mkProject(scenario.cap ?? 3);
    const tasks = scenario.tasks.map((t, i) => mkTask(t.id, i, t.dependsOn ?? [], t.initialStatus ?? "queued"));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const settlesTo = new Map(scenario.tasks.map((t) => [t.id, t.settlesTo ?? ("merged" as TaskStatus)]));
    // Live status map: queued → running on start → its settlesTo on release. getTaskStatus reads it, so the
    // gate sees real parent statuses. The Task objects' own .status stays at the INITIAL value (derivations
    // read that — a deterministic snapshot of the semantics table).
    const statuses = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));

    let queued = tasks.filter((t) => t.status === "queued");
    const startOrder: string[] = [];
    const starts: StartObservation[] = [];
    const resolvers = new Map<string, () => void>();

    const startTask = (task: Task): Promise<TaskStatus> => {
        startOrder.push(task.id);
        starts.push({ taskId: task.id, parents: task.dependsOn.map((id) => ({ id, status: statuses.get(id) })) });
        statuses.set(task.id, "running");
        queued = queued.filter((q) => q.id !== task.id);
        const to = settlesTo.get(task.id) ?? "merged";
        return new Promise<TaskStatus>((resolve) => { resolvers.set(task.id, () => { statuses.set(task.id, to); resolve(to); }); });
    };

    const scheduler = createScheduler({
        listQueued: () => queued,
        getProject: () => project,
        startTask,
        getTaskStatus: (id) => statuses.get(id),
    });

    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    scheduler.kick();
    await flush();
    // Release started-but-unsettled tasks one at a time; each settle re-kicks and may start a dependent.
    // A blocked task never starts → never gets a resolver → the loop terminates at quiescence.
    for (;;) {
        const pending = startOrder.find((id) => resolvers.has(id));
        if (!pending) break;
        const release = resolvers.get(pending)!;
        resolvers.delete(pending);
        release();
        await flush();
    }

    const derivations: DerivationObservation[] = tasks.map((t) => {
        const wo = waitingOnFor(t, (id) => byId.get(id));
        return {
            taskId: t.id, blocked: wo.length > 0, waitingOnIds: wo.map((w) => w.id),
            parents: t.dependsOn.map((id) => ({ id, status: byId.get(id)?.status })),
        };
    });
    const hasEdges = tasks.some((t) => t.dependsOn.length > 0);
    const fifoOrder = tasks.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id);

    return { unit: "deps", hasEdges, startOrder, fifoOrder, starts, derivations };
}
