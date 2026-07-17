// tests/renderer/terminal-tiling.test.tsx
// Proof for "In-app terminal tiling — side by side, resizable": two (or more) terminals render
// side by side in a resizable split, so a running session and its drop-in can be watched together.
// Two seams: the pure resizeSplit() function (the drag math — clamped, sum-preserving) and the
// statically rendered TerminalTiling surface — both panes present, an assertable role="separator"
// resize handle between them, and independent per-pane sizing driven to a known state via the
// initialSizes initializer (the no-jsdom stand-in for dragging the handle). The TerminalsView
// integration mounts the tiling via its initialTiled initializer, same pattern as initialFilter.
// Same static-markup harness as terminal-filter.test.tsx (react-dom/server, node env).
// The PROBE is the negative control: a SINGLE-pane render asserting two visible panes MUST FAIL —
// one pane, no handle, and the two-pane predicates come out false against it.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TerminalTiling, resizeSplit, evenSplit } from "../../src/renderer/components/TerminalTiling";
import { TerminalsView } from "../../src/renderer/views/Terminals";
import { ActionCtx, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import type { Project, PtySessionInfo } from "../../src/shared/types";

/* ---------- fixtures (mirrors terminal-filter.test.tsx) ---------- */
const noop = () => { /* render-only */ };
const STUB_ACTIONS: CockpitActions = {
    openTask: noop, openPlan: noop, startNow: noop, dropIn: noop, startFresh: noop,
    resume: noop, verifyMerge: noop, abandon: noop, clearDeps: noop, openShell: noop,
};
const render = (el: ReactElement): string =>
    renderToStaticMarkup(<ActionCtx.Provider value={STUB_ACTIONS}>{el}</ActionCtx.Provider>);

const project = (over: Partial<Project> & { id: string; name: string }): Project => ({
    repoPath: "C:\\repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null,
    model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null,
    promotionMode: "pr", jailImage: null, conductorSessionId: null, ...over,
});
const vm = (over: Partial<TaskVM> & { id: string }): TaskVM => ({
    projectId: "pa", title: over.id, intent: "steer", acceptance: ["npm test"],
    status: "running", scopeHint: null, dependsOn: [], planId: null, branchName: null,
    worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
    resumable: false, blocked: false, waitingOn: [], snap: null, validating: false, ...over,
});
const sess = (over: Partial<PtySessionInfo> & { id: string; title: string }): PtySessionInfo => ({
    kind: "free", cwd: "C:\\w", alive: true, ...over,
});

// A running loop session and its drop-in — the pair the feature exists to watch together.
const RUN = sess({ id: "s-run", kind: "free", projectId: "pa", title: "tile-run" });
const DROP = sess({ id: "s-drop", kind: "dropin", projectId: "pa", taskId: "ta-1", title: "tile-drop" });

const PROJECTS = [project({ id: "pa", name: "alpha" })];
const TASKS: Record<string, TaskVM> = { "ta-1": vm({ id: "ta-1", title: "Steer alpha one" }) };

/* ---------- assertion helpers: what "a visible pane" means in the static markup ---------- */
const countPanes = (html: string): number => html.split('data-verify-unit="TerminalPane"').length - 1;
const countHandles = (html: string): number => html.split('role="separator"').length - 1;

describe("resizeSplit — the pure drag-math seam", () => {
    it("evenSplit divides 100 across the panes", () => {
        expect(evenSplit(2)).toEqual([50, 50]);
        expect(evenSplit(4)).toEqual([25, 25, 25, 25]);
    });
    it("dragging a handle grows one pane and shrinks its neighbour by the same amount", () => {
        expect(resizeSplit([50, 50], 0, 10)).toEqual([60, 40]);
        expect(resizeSplit([50, 50], 0, -10)).toEqual([40, 60]);
    });
    it("only the pair either side of the handle moves — other panes are untouched", () => {
        expect(resizeSplit([40, 30, 30], 1, 10)).toEqual([40, 40, 20]);
    });
    it("clamps so neither pane collapses below the minimum", () => {
        expect(resizeSplit([50, 50], 0, 80)).toEqual([85, 15]);
        expect(resizeSplit([50, 50], 0, -80)).toEqual([15, 85]);
    });
    it("preserves the total across any drag", () => {
        const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        expect(total(resizeSplit([50, 50], 0, 23))).toBe(100);
        expect(total(resizeSplit([40, 30, 30], 1, -45))).toBe(100);
    });
});

describe("TerminalTiling surface — two terminals side by side with a resizable split", () => {
    it("a two-terminal layout renders BOTH panes", () => {
        const html = render(<TerminalTiling sessions={[RUN, DROP]} />);
        expect(countPanes(html)).toBe(2);
        expect(html).toContain(`data-verify-pane-session="${RUN.id}"`);
        expect(html).toContain(`data-verify-pane-session="${DROP.id}"`);
        expect(html).toContain('data-verify-unit="TerminalTiling"');
        expect(html).toContain('data-verify-panes="2"');
    });
    it("exactly one split/resize handle sits between the two panes", () => {
        const html = render(<TerminalTiling sessions={[RUN, DROP]} />);
        expect(countHandles(html)).toBe(1);
        expect(html).toContain('aria-orientation="vertical"');
        expect(html).toContain('data-verify-handle="0"');
    });
    it("panes are sized independently — a driven 60/40 split renders each pane at its own width", () => {
        const html = render(<TerminalTiling sessions={[RUN, DROP]} initialSizes={[60, 40]} />);
        expect(html).toContain("flex-basis:60%");
        expect(html).toContain("flex-basis:40%");
        expect(html).toContain('data-verify-sizes="60,40"');
    });
    it("defaults to an even split when no sizes are driven", () => {
        const html = render(<TerminalTiling sessions={[RUN, DROP]} />);
        expect(html).toContain('data-verify-sizes="50,50"');
    });
    it("scales past two: three terminals render three panes and two handles", () => {
        const third = sess({ id: "s-three", projectId: "pa", title: "tile-three" });
        const html = render(<TerminalTiling sessions={[RUN, DROP, third]} />);
        expect(countPanes(html)).toBe(3);
        expect(countHandles(html)).toBe(2);
    });
});

describe("TerminalsView integration — a tiled session renders beside the active one", () => {
    const view = (initialTiled?: string[]) =>
        render(<TerminalsView sessions={[RUN, DROP]} activeId={RUN.id} onSelect={noop} onKill={noop}
            onNewShell={noop} projects={PROJECTS} tasksById={TASKS} initialTiled={initialTiled} />);
    it("driven to a tiled state, the view shows the running session AND its drop-in side by side", () => {
        const html = view([DROP.id]);
        expect(countPanes(html)).toBe(2);
        expect(html).toContain(`data-verify-pane-session="${RUN.id}"`);
        expect(html).toContain(`data-verify-pane-session="${DROP.id}"`);
        expect(countHandles(html)).toBe(1);
    });
    it("without a tiled session the view stays single-pane, as today", () => {
        const html = view();
        expect(countPanes(html)).toBe(1);
        expect(countHandles(html)).toBe(0);
    });
});

describe("PROBE — a single-pane render asserting two visible panes MUST FAIL", () => {
    it("a single-pane layout renders ONE pane and NO split handle", () => {
        const html = render(<TerminalTiling sessions={[RUN]} />);
        expect(countPanes(html)).toBe(1);
        expect(countHandles(html)).toBe(0);
    });
    it("negative control: the two-pane predicates come out false against the single-pane render — the assertions above have teeth", () => {
        const html = render(<TerminalTiling sessions={[RUN]} />);
        expect(countPanes(html) === 2).toBe(false);                              // the exact predicate a real two-pane layout must satisfy
        expect(html.includes(`data-verify-pane-session="${DROP.id}"`)).toBe(false); // the second session simply is not there
    });
});
