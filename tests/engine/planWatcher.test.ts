// tests/engine/planWatcher.test.ts — the debounce/read logic + the pure rail-state composition. The fs.watch
// edge itself is thin (real node:fs.watch, Windows-flaky) so it's driven here with an INJECTED watch/schedule
// (deterministic — no timers, no disk): a fake scheduler models the debounce coalescing exactly.
import { describe, it, expect } from "vitest";
import { watchPlanDir, readPlanFiles, buildPlanRailState, type PlanFiles, type WatchDeps } from "../../src/main/engine/planWatcher";

// A deterministic harness: inject read/watch/schedule/cancel so a "burst" of events + a single timer-flush
// reproduces real debounce behaviour without wall-clock or fs.
function harness(initial: PlanFiles) {
    let files = initial;
    const calls: PlanFiles[] = [];
    let emit: (() => void) | null = null;
    let closed = false;
    let seq = 0;
    const timers = new Map<number, () => void>();
    const deps: WatchDeps = {
        read: () => files,
        watch: (onEvent) => { emit = onEvent; return { close: () => { closed = true; } }; },
        schedule: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
        cancel: (h) => { timers.delete(h as number); },
    };
    const dispose = watchPlanDir("/plan", (f) => calls.push(f), deps);
    return {
        calls, dispose,
        setFiles: (f: PlanFiles) => { files = f; },
        fire: () => emit!(),
        flush: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()); },
        pendingCount: () => timers.size,
        isClosed: () => closed,
    };
}

const empty: PlanFiles = { prdText: null, tasksJson: null };

describe("watchPlanDir — debounce/read", () => {
    it("does an initial read immediately (one onChange with the current files)", () => {
        const h = harness({ prdText: "# prd", tasksJson: null });
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]).toEqual({ prdText: "# prd", tasksJson: null });
    });

    it("coalesces a burst of events into a single onChange", () => {
        const h = harness(empty);
        h.fire(); h.fire(); h.fire();
        expect(h.pendingCount()).toBe(1); // only one timer outstanding — earlier ones were cancelled
        h.flush();
        expect(h.calls).toHaveLength(2); // initial + one coalesced
    });

    it("reads the latest files at flush time (picks up a write that happened during the debounce)", () => {
        const h = harness(empty);
        h.fire();
        h.setFiles({ prdText: "# prd", tasksJson: '{"planTitle":"p"}' });
        h.flush();
        expect(h.calls.at(-1)).toEqual({ prdText: "# prd", tasksJson: '{"planTitle":"p"}' });
    });

    it("dispose cancels a pending fire and closes the watcher; later events are ignored", () => {
        const h = harness(empty);
        h.fire();               // schedules a debounced fire
        h.dispose();            // …which dispose must cancel
        h.flush();
        h.fire();               // a stray event after dispose
        h.flush();
        expect(h.calls).toHaveLength(1); // only the initial read ever fired
        expect(h.isClosed()).toBe(true);
    });
});

describe("readPlanFiles", () => {
    it("reads prd.md + tasks.json, mapping missing/blank to null", () => {
        // Match on basename so the assertion is path-separator agnostic (join uses \ on Windows).
        const read = (p: string) => (p.endsWith("prd.md") ? "# PRD" : p.endsWith("tasks.json") ? "" : null);
        const files = readPlanFiles("/p", read);
        expect(files.prdText).toBe("# PRD");
        expect(files.tasksJson).toBeNull(); // blank file → null
    });
});

describe("buildPlanRailState — stage derivation", () => {
    const ctx = { npmScripts: ["check"], fileExists: () => false };
    it("neither file → conversing", () => {
        const s = buildPlanRailState(empty, ctx);
        expect(s.stage).toBe("conversing");
        expect(s.parse).toBeNull();
        expect(s.verdicts).toEqual([]);
    });
    it("prd only → prd", () => {
        const s = buildPlanRailState({ prdText: "# prd", tasksJson: null }, ctx);
        expect(s.stage).toBe("prd");
        expect(s.prdText).toBe("# prd");
        expect(s.parse).toBeNull();
    });
    it("valid tasks.json → tasks, parse.ok, verdicts computed", () => {
        const tasksJson = JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check", "npm run nope"] }] });
        const s = buildPlanRailState({ prdText: "# prd", tasksJson }, ctx);
        expect(s.stage).toBe("tasks");
        expect(s.parse?.ok).toBe(true);
        expect(s.verdicts.filter((v) => v.level === "warn").map((v) => v.command)).toEqual(["npm run nope"]);
    });
    it("malformed tasks.json → stage still tasks, parse.ok false with errors, no verdicts", () => {
        const s = buildPlanRailState({ prdText: null, tasksJson: "{not json" }, ctx);
        expect(s.stage).toBe("tasks");
        expect(s.parse?.ok).toBe(false);
        expect(s.verdicts).toEqual([]);
    });
});
