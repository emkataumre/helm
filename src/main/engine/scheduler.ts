// src/main/engine/scheduler.ts
// The per-project auto-start scheduler. It auto-fills each project's running slots (FIFO by createdAt)
// up to that project's concurrencyCap, serves the paused-mode startNow (one task by hand), and owns
// the per-project merge mutexes (so a project's merges serialize while different projects run free).
// It also enforces both merged-gates: the M9 task-level dependsOn gate and the plan-queue plan-level
// gate (dependsOnPlan + gateMode strict/yolo) — see planGateAllows below.
//
// Event-driven, no clock: kick() is called on task-create, task-settle, resume, and cap-change. It is
// Electron-free and fully DI'd, so the M4 verify slice can drive it headlessly.
import type { Project, Task, TaskStatus, SchedulerState } from "../../shared/types";
import { createKeyedMutex } from "./mutex";
import { depsSatisfied } from "./deps";

const DEFAULT_CAP = 3;

// Plan-queue slice 3: the plan-level gate's vocabulary. Defined here as literals (not imported from
// db/plans) so the scheduler stays an Electron-free, db-free leaf; anything that isn't exactly "yolo"
// reads as "strict" wherever the value arrives (the asGateMode defensiveness, applied locally).
export type PlanGateMode = "strict" | "yolo";

// What the scheduler reports when a parent plan settles ALL-TERMINAL with unmerged tasks: strict →
// the child plan stays held and a human must release-or-hold; yolo → the child was released and the
// notice names which parent tasks didn't land. Deduped per situation (child, parent, action, set),
// so the per-kick re-evaluation raises each decision once but a CHANGED situation raises fresh.
export interface PlanGateNotice {
    childPlanId: string;
    parentPlanId: string;
    gateMode: PlanGateMode;
    action: "held" | "released";
    unmergedTaskIds: string[]; // the parent-plan tasks that reached terminal without merging (sorted)
}

// Statuses that can no longer change on their own — the loop has settled and only a human verb
// (resume / verify-&-merge / abandon) moves the task again. handed-off is deliberately NOT terminal:
// a human is steering and a handback is expected, so the gate keeps waiting rather than deciding.
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["merged", "needs-human", "abandoned"]);

export interface SchedulerDeps {
    listQueued: () => Task[];                          // tasks currently in status "queued"
    getProject: (id: string) => Project | undefined;
    startTask: (task: Task) => Promise<TaskStatus>;    // run one task's loop to completion (fire-and-forget)
    // M9: current status of any task by id (undefined = unknown/deleted). The dependsOn merged-gate reads
    // this to hold a child until every parent has merged. A no-deps task never triggers a lookup.
    getTaskStatus: (id: string) => TaskStatus | undefined;
    // Plan-queue slice 3: the plan-level merged-gate (the M9 dependsOn gate lifted to plans — same
    // authority: the scheduler only declines to start; no status is ever written). Optional as a trio so
    // wiring without a plan layer (the M4/M9 verify surfaces, ipc until the queue slice wires it) keeps
    // the exact pre-slice behavior. getPlanGate reads a plan's edge + mode (undefined = plan row gone);
    // listPlanTasks reads the LIVE statuses of every task born from a plan.
    getPlanGate?: (planId: string) => { dependsOnPlan: string | null; gateMode: PlanGateMode } | undefined;
    listPlanTasks?: (planId: string) => Array<{ id: string; status: TaskStatus }>;
    onPlanGateNotice?: (notice: PlanGateNotice) => void;
}

export interface Scheduler {
    mutexFor: (projectId: string) => { withLock: <T>(fn: () => Promise<T>) => Promise<T> };
    kick: () => void;
    startNow: (taskId: string) => void;
    setPaused: (paused: boolean) => void;
    state: () => SchedulerState;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
    // running maps taskId → projectId for every task the scheduler started and that hasn't settled —
    // a task waiting on the merge mutex still counts (it holds its slot), which is what keeps
    // running-count ≤ cap true through a merge burst.
    const running = new Map<string, string>();
    const mutex = createKeyedMutex();
    let paused = false;

    const capFor = (projectId: string) => deps.getProject(projectId)?.concurrencyCap ?? DEFAULT_CAP;
    const runningIn = (projectId: string) => {
        let n = 0;
        for (const pid of running.values()) if (pid === projectId) n++;
        return n;
    };

    // Plan-gate notices already raised (see PlanGateNotice for the key's semantics).
    const raisedNotices = new Set<string>();

    // The plan-level gate. A queued task born from a plan whose plan carries a dependsOnPlan edge is held
    // until every task in the parent plan reads "merged". Once the parent is ALL-TERMINAL with unmerged
    // tasks the modes split: strict keeps holding and raises the needs-attention (release-or-hold) notice;
    // yolo releases and the notice names what didn't land. No edge, an unknown plan, or an empty/ghost
    // parent releases — deletion is deliberate human intent (the deps.ts ghost precedent), never a wedge.
    const planGateAllows = (task: Task): boolean => {
        const { getPlanGate, listPlanTasks, onPlanGateNotice } = deps;
        if (!getPlanGate || !listPlanTasks || task.planId == null) return true;
        const gate = getPlanGate(task.planId);
        if (!gate || gate.dependsOnPlan == null) return true;
        const parentTasks = listPlanTasks(gate.dependsOnPlan);
        const unmerged = parentTasks.filter((t) => t.status !== "merged");
        if (parentTasks.length === 0 || unmerged.length === 0) return true;               // ghost or fully landed
        if (!parentTasks.every((t) => TERMINAL_STATUSES.has(t.status))) return false;     // parent in flight → hold
        const gateMode: PlanGateMode = gate.gateMode === "yolo" ? "yolo" : "strict";      // defensive read
        const action = gateMode === "yolo" ? "released" : "held";
        const unmergedTaskIds = unmerged.map((t) => t.id).sort();
        const key = `${task.planId}→${gate.dependsOnPlan}:${action}:${unmergedTaskIds.join(",")}`;
        if (!raisedNotices.has(key)) {
            raisedNotices.add(key);
            onPlanGateNotice?.({ childPlanId: task.planId, parentPlanId: gate.dependsOnPlan, gateMode, action, unmergedTaskIds });
        }
        return gateMode === "yolo";
    };

    // Fire-and-forget one task: claim its slot, run it, and on settle (success OR failure) free the
    // slot and kick() again to refill it.
    const start = (task: Task): void => {
        running.set(task.id, task.projectId);
        void Promise.resolve()
            .then(() => deps.startTask(task))
            // startTask should resolve a terminal status even on failure (runTaskLoop catches its own
            // setup errors → needs-human). This .catch is belt-and-suspenders: an unexpected throw must
            // never become an unhandled rejection — log it and free the slot rather than crash the loop.
            .catch((err) => { console.error(`[helm] scheduler: task ${task.id} crashed before settling:`, err); })
            .finally(() => { running.delete(task.id); kick(); });
    };

    const kick = (): void => {
        if (paused) return;
        // Group the queue by project, skipping tasks already claimed (status may still read "queued"
        // in the brief window before the loop flips it).
        const byProject = new Map<string, Task[]>();
        for (const t of deps.listQueued()) {
            if (running.has(t.id)) continue;
            if (!depsSatisfied(t, deps.getTaskStatus)) continue; // M9: an unmerged parent holds the child
            if (!planGateAllows(t)) continue; // plan-queue: a gated parent PLAN holds the child plan's tasks
            (byProject.get(t.projectId) ?? byProject.set(t.projectId, []).get(t.projectId)!).push(t);
        }
        for (const [pid, tasks] of byProject) {
            tasks.sort((a, b) => a.createdAt - b.createdAt); // FIFO
            const cap = capFor(pid);
            let i = 0;
            while (runningIn(pid) < cap && i < tasks.length) start(tasks[i++]);
        }
    };

    const startNow = (taskId: string): void => {
        if (running.has(taskId)) return;
        const task = deps.listQueued().find((t) => t.id === taskId);
        if (!task) return;
        if (!depsSatisfied(task, deps.getTaskStatus)) return; // M9: the paused-mode manual start respects the
        // gate too — the escape hatch for a wrongly-blocked task is editing its edges, not racing the gate.
        if (!planGateAllows(task)) return; // the plan-level gate binds the manual start under the same rule
        if (runningIn(task.projectId) >= capFor(task.projectId)) return; // no slot — no-op (ignores FIFO + pause)
        start(task);
    };

    const setPaused = (p: boolean): void => {
        paused = p;
        if (!paused) kick(); // resume → auto-fleet
    };

    const state = (): SchedulerState => {
        const pids = new Set<string>([...running.values(), ...deps.listQueued().map((t) => t.projectId)]);
        return {
            paused,
            perProject: [...pids].map((projectId) => ({ projectId, running: runningIn(projectId), cap: capFor(projectId) })),
        };
    };

    return {
        mutexFor: (projectId) => ({ withLock: (fn) => mutex.withLock(projectId, fn) }),
        kick, startNow, setPaused, state,
    };
}
