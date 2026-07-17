// tests/renderer/terminal-filter.test.tsx
// Proof for "Two-level project -> task terminal filter": the Terminals view narrows its tab
// strip first by project, then (within that project) by task, and clearing the filter restores
// the full list. Renderer-only and computed from the current terminal set — nothing persisted.
// Two seams: the pure filterSessions() function (the narrowing logic) and the statically
// rendered TerminalsView surface, driven to a known filter state via its initialFilter
// initializer (the no-jsdom stand-in for operating the two Selects). Same static-markup
// harness as components.test.tsx / spend-display.test.tsx (react-dom/server, node env).
// The PROBE is the negative control: an unfiltered render / an identity "filter" DOES carry
// another project's terminal — a project filter that still shows it MUST FAIL these checks.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { TerminalsView, filterSessions } from "../../src/renderer/views/Terminals";
import { ActionCtx, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import type { Project, PtySessionInfo } from "../../src/shared/types";

/* ---------- fixtures (mirrors spend-display.test.tsx) ---------- */
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
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null,
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

// Two projects' worth of terminals. Tab titles are the load-bearing markers — deliberately
// distinct from project names ("alpha"/"beta" legitimately appear in the Open-shell / filter
// Select options regardless of filter) and from task titles.
const A1 = sess({ id: "s-a1", kind: "dropin", projectId: "pa", taskId: "ta-1", title: "tab-alpha-one" });
const A2 = sess({ id: "s-a2", kind: "dropin", projectId: "pa", taskId: "ta-2", title: "tab-alpha-two" });
const ASH = sess({ id: "s-ash", kind: "free", projectId: "pa", title: "tab-alpha-shell" });
const B1 = sess({ id: "s-b1", kind: "dropin", projectId: "pb", taskId: "tb-1", title: "tab-beta-one" });
const ALL = [A1, A2, ASH, B1];

const PROJECTS = [project({ id: "pa", name: "alpha" }), project({ id: "pb", name: "beta" })];
const TASKS: Record<string, TaskVM> = {
    "ta-1": vm({ id: "ta-1", title: "Steer alpha one" }),
    "ta-2": vm({ id: "ta-2", title: "Steer alpha two" }),
    "tb-1": vm({ id: "tb-1", projectId: "pb", title: "Steer beta one" }),
};

const view = (initialFilter?: { projectId: string | null; taskId: string | null }) =>
    render(<TerminalsView sessions={ALL} activeId={null} onSelect={noop} onKill={noop} onNewShell={noop}
        projects={PROJECTS} tasksById={TASKS} initialFilter={initialFilter} />);

describe("filterSessions — the two-level narrowing seam", () => {
    it("no filter returns the full set unchanged", () => {
        expect(filterSessions(ALL, null, null)).toEqual(ALL);
    });
    it("a project filter narrows to that project's terminals only", () => {
        const got = filterSessions(ALL, "pa", null);
        expect(got.map((s) => s.id)).toEqual(["s-a1", "s-a2", "s-ash"]);
        expect(got.some((s) => s.projectId !== "pa")).toBe(false);
    });
    it("a further task filter narrows to that task's terminal", () => {
        expect(filterSessions(ALL, "pa", "ta-1").map((s) => s.id)).toEqual(["s-a1"]);
    });
    it("the task level is scoped to the project level: without a project, a task filter is inert", () => {
        expect(filterSessions(ALL, null, "ta-1")).toEqual(ALL);
    });
    it("clearing restores the full list", () => {
        filterSessions(ALL, "pa", "ta-1");          // narrow…
        expect(filterSessions(ALL, null, null)).toEqual(ALL); // …then clear: everything is back
    });
});

describe("TerminalsView surface — the rendered tab strip narrows and restores", () => {
    it("with no filter the full list renders as today (all four tabs)", () => {
        const html = view();
        for (const s of ALL) expect(html).toContain(s.title);
        expect(html).toContain('data-verify-shown="4"');
    });
    it("a project filter renders only that project's tabs", () => {
        const html = view({ projectId: "pa", taskId: null });
        expect(html).toContain("tab-alpha-one");
        expect(html).toContain("tab-alpha-two");
        expect(html).toContain("tab-alpha-shell");
        expect(html).not.toContain("tab-beta-one"); // the other project's terminal is GONE
        expect(html).toContain('data-verify-shown="3"');
        expect(html).toContain('data-verify-filter-project="pa"');
    });
    it("a further task filter renders only that task's tab", () => {
        const html = view({ projectId: "pa", taskId: "ta-1" });
        expect(html).toContain("tab-alpha-one");
        expect(html).not.toContain("tab-alpha-two");
        expect(html).not.toContain("tab-alpha-shell");
        expect(html).not.toContain("tab-beta-one");
        expect(html).toContain('data-verify-shown="1"');
        expect(html).toContain('data-verify-filter-task="ta-1"');
    });
    it("clearing the filter restores the full list", () => {
        const html = view({ projectId: null, taskId: null });
        for (const s of ALL) expect(html).toContain(s.title);
        expect(html).toContain('data-verify-shown="4"');
    });
});

describe("PROBE — a project filter that still shows another project's terminal MUST FAIL", () => {
    it("negative control: the UNFILTERED render DOES carry the beta tab — the not-toContain checks have teeth", () => {
        expect(view()).toContain("tab-beta-one");
    });
    it("negative control: an identity 'filter' leaks the other project and trips the narrowing predicate", () => {
        const lying = ALL;                            // a broken filter that narrowed nothing
        expect(lying.some((s) => s.projectId !== "pa")).toBe(true); // exactly what real output must never do
        expect(filterSessions(ALL, "pa", null).some((s) => s.projectId !== "pa")).toBe(false);
    });
});
