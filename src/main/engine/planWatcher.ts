// src/main/engine/planWatcher.ts
// The .helm/plan/ side-rail engine (spec §3). watchPlanDir watches the single FLAT drop dir (no recursion →
// no chokidar), DEBOUNCEs a burst of fs events (editors + a `claude` writing a file fire storms), does an
// initial read, and is tolerant of the dir not existing yet. The debounce/read logic + the pure rail-state
// composition are unit-tested with an injected fs (the fs.watch edge is thin and Windows-flaky). buildPlanRailState
// composes the REAL parsePlanDraft + staticPreflight into the shape the renderer renders.
import { readFileSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { parsePlanDraft, staticPreflight, type PreflightCtx } from "./planDraft";
import type { PlanRailState, PlanStage, PreflightVerdict } from "../../shared/types";

export interface PlanFiles { prdText: string | null; tasksJson: string | null; }

export const DEBOUNCE_MS = 200;

// Injectable seams so the debounce logic is deterministically testable (fake scheduler, fake watch). The real
// wiring uses node:fs.watch + setTimeout.
export interface WatchDeps {
    read: () => PlanFiles;
    watch: (onEvent: () => void) => { close: () => void };
    schedule: (fn: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
}

const readFileOrNull = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const blankToNull = (s: string | null): string | null => (s && s.trim().length ? s : null);

// Read the two flat files. A missing OR blank file → null (a half-written file must not flip the stage). The
// reader is injectable (unit tests) and defaults to the real fs.
export function readPlanFiles(dir: string, readFile: (p: string) => string | null = readFileOrNull): PlanFiles {
    return {
        prdText: blankToNull(readFile(join(dir, "prd.md"))),
        tasksJson: blankToNull(readFile(join(dir, "tasks.json"))),
    };
}

// Real fs.watch on a flat dir, tolerant of it not existing yet (ENOENT → a no-op watcher). persistent:false so
// it never keeps the process alive; a transient watch error is swallowed (must never crash main).
function realWatch(dir: string, onEvent: () => void): { close: () => void } {
    try {
        const w = fsWatch(dir, { persistent: false }, () => onEvent());
        w.on("error", () => { /* swallow — a transient watch error must not crash main */ });
        return { close: () => { try { w.close(); } catch { /* already closed */ } } };
    } catch { return { close: () => { /* dir absent — nothing to close */ } }; }
}

// Watch `dir`, calling onChange(files) on the initial read and (debounced) after every fs event. Returns a
// dispose() that cancels any pending fire and closes the watcher — idempotent.
export function watchPlanDir(dir: string, onChange: (files: PlanFiles) => void, injected?: Partial<WatchDeps>): () => void {
    const deps: WatchDeps = {
        read: injected?.read ?? (() => readPlanFiles(dir)),
        watch: injected?.watch ?? ((onEvent) => realWatch(dir, onEvent)),
        schedule: injected?.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
        cancel: injected?.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
    let pending: unknown = null;
    let disposed = false;

    const fire = () => { pending = null; if (!disposed) onChange(deps.read()); };
    const onEvent = () => {
        if (disposed) return;
        if (pending != null) deps.cancel(pending); // coalesce: cancel the prior timer, restart the window
        pending = deps.schedule(fire, DEBOUNCE_MS);
    };

    const watcher = deps.watch(onEvent);
    onChange(deps.read()); // initial read

    return () => {
        if (disposed) return;
        disposed = true;
        if (pending != null) deps.cancel(pending);
        try { watcher.close(); } catch { /* best effort */ }
    };
}

// Pure composition of the REAL validators into the renderer-facing rail state. stage is derived only from which
// files exist; parse is null until tasks.json lands (even a malformed one flips the stage to "tasks" and carries
// its errors); verdicts are the static pre-flight, only when the draft parses.
export function buildPlanRailState(files: PlanFiles, ctx: PreflightCtx): PlanRailState {
    const stage: PlanStage = files.tasksJson != null ? "tasks" : files.prdText != null ? "prd" : "conversing";
    let parse: PlanRailState["parse"] = null;
    let verdicts: PreflightVerdict[] = [];
    if (files.tasksJson != null) {
        const r = parsePlanDraft(files.tasksJson);
        parse = r;
        if (r.ok) verdicts = staticPreflight(r.draft, ctx);
    }
    return { stage, prdText: files.prdText, parse, verdicts };
}
