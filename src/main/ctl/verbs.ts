// src/main/ctl/verbs.ts
// The blessed verb registry (M16, spec §3): a CLOSED set, each verb delegating to a shared action that
// IS the corresponding ipc handler's body — ipc.ts builds the actions once and hands them to BOTH
// ipcMain.handle and this registry (one implementation, two transports). The steer verbs therefore hit
// the exact mutex-wrapped / single-flight paths the cockpit buttons hit; this registry adds no logic of
// its own. DELIBERATELY ABSENT: create-task or any intake verb — conductor-planned work goes through
// the .helm/plan/ seam with its parse → pre-flight → human-ack gates, identically to human-planned work.
//
// PURE (imports only the protocol types): the verify slice drives buildCtlVerbs/dispatchCtl with
// recording actions (invariants ctl-verbs-are-blessed + mutations-route-through-mutex).
import type { CtlRequest, CtlResponse } from "./protocol";

export const CTL_READ_VERBS = ["status", "task", "progress", "plan-status"] as const;
export const CTL_STEER_VERBS = ["pause", "resume", "abandon", "clear-deps"] as const;
export const CTL_VERBS = [...CTL_READ_VERBS, ...CTL_STEER_VERBS] as const;
export type CtlVerb = (typeof CTL_VERBS)[number];

// How the scoped reads pick a project: an explicit --project name, else the client's cwd (the conductor
// session runs at the project's repo root, so `helm plan status` just works there).
export interface ProjectSelector {
    project?: string;
    cwd?: string;
}

// The shared actions, built in ipc.ts closing over db/scheduler/handback exactly like the ipc handlers:
// pause/resume = the scheduler:setPaused body; abandonTask = the tasks:abandon body (mutex-wrapped
// handback + jail reap); clearDeps = the tasks:setDependsOn body with []. Reads compose the same db/rail
// reads the cockpit uses.
export interface CtlActions {
    status(sel: ProjectSelector): unknown;
    taskDetail(id: string): unknown;
    progressTail(id: string): unknown;
    planStatus(sel: ProjectSelector): unknown;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
    abandonTask(id: string): unknown | Promise<unknown>;
    clearDeps(id: string): unknown;
}

export type CtlHandler = (req: CtlRequest) => unknown | Promise<unknown>;

export function buildCtlVerbs(actions: CtlActions): Record<CtlVerb, CtlHandler> {
    const sel = (req: CtlRequest): ProjectSelector => ({ project: req.args.project, cwd: req.cwd });
    const id = (req: CtlRequest): string => {
        if (!req.args.id) throw new Error("missing task id");
        return req.args.id;
    };
    return {
        "status": (r) => actions.status(sel(r)),
        "task": (r) => actions.taskDetail(id(r)),
        "progress": (r) => actions.progressTail(id(r)),
        "plan-status": (r) => actions.planStatus(sel(r)),
        "pause": () => actions.pause(),
        "resume": () => actions.resume(),
        "abandon": (r) => actions.abandonTask(id(r)),
        "clear-deps": (r) => actions.clearDeps(id(r)),
    };
}

// One request → one structured response. An unknown verb is REJECTED with a structured error (never
// guessed at); a handler throw becomes { ok: false } — a ctl failure must never crash the app
// (server.ts adds the per-connection belt on top of this).
export async function dispatchCtl(verbs: Record<string, CtlHandler>, req: CtlRequest): Promise<CtlResponse> {
    const handler = Object.prototype.hasOwnProperty.call(verbs, req.verb) ? verbs[req.verb] : undefined;
    if (!handler) return { ok: false, error: `unknown verb "${req.verb}" — blessed verbs: ${Object.keys(verbs).join(", ")}` };
    try {
        return { ok: true, data: (await handler(req)) ?? null };
    } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
}
