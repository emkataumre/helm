// src/main/engine/scheduler.ts
// The per-project auto-start scheduler. It auto-fills each project's running slots (FIFO by createdAt)
// up to that project's concurrencyCap, serves the paused-mode startNow (one task by hand), and owns
// the per-project merge mutexes (so a project's merges serialize while different projects run free).
//
// Event-driven, no clock: kick() is called on task-create, task-settle, resume, and cap-change. It is
// Electron-free and fully DI'd, so the M4 verify slice can drive it headlessly.
import type { Project, Task, TaskStatus, SchedulerState } from "../../shared/types";
import { createKeyedMutex } from "./mutex";

const DEFAULT_CAP = 3;

export interface SchedulerDeps {
    listQueued: () => Task[];                          // tasks currently in status "queued"
    getProject: (id: string) => Project | undefined;
    startTask: (task: Task) => Promise<TaskStatus>;    // run one task's loop to completion (fire-and-forget)
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

    // Fire-and-forget one task: claim its slot, run it, and on settle (success OR failure) free the
    // slot and kick() again to refill it.
    const start = (task: Task): void => {
        running.set(task.id, task.projectId);
        void Promise.resolve()
            .then(() => deps.startTask(task))
            .finally(() => { running.delete(task.id); kick(); });
    };

    const kick = (): void => {
        if (paused) return;
        // Group the queue by project, skipping tasks already claimed (status may still read "queued"
        // in the brief window before the loop flips it).
        const byProject = new Map<string, Task[]>();
        for (const t of deps.listQueued()) {
            if (running.has(t.id)) continue;
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
