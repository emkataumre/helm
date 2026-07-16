// tests/renderer/spend-display.test.tsx
// Proof for "Remove the $ display and costUsd capture": the spend surfaces (fleet-stat panel,
// task cards, task detail) now read out TOKENS and carry NO money-spent dollar figure. Every
// fixture is fed a fat costUsd (42.42) that the old UI would have rendered as "$42.42" — so its
// ABSENCE is the assertion, and the still-live "cost cap" config ($25, a token-independent loop
// bound) is deliberately untouched. Same static-markup harness as components.test.tsx (react-dom/
// server, no jsdom). The PROBE is the negative control: the old fmtUsd readout DOES emit "$42.42",
// proving the not-toContain checks below have teeth (a $ in a spend readout MUST FAIL them).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ActionCtx, ActivityPanel, fmtUsd, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import { TaskCard } from "../../src/renderer/views/Board";
import { Inspector, IterationsTable } from "../../src/renderer/views/TaskDetail";
import type { EngineSnapshot, Project } from "../../src/shared/types";

/* ---------- fixtures (mirrors components.test.tsx) ---------- */
const noop = () => { /* render-only */ };
const STUB_ACTIONS: CockpitActions = {
    openTask: noop, openPlan: noop, startNow: noop, dropIn: noop, startFresh: noop,
    resume: noop, verifyMerge: noop, abandon: noop, clearDeps: noop, openShell: noop,
};
const render = (el: ReactElement): string =>
    renderToStaticMarkup(<ActionCtx.Provider value={STUB_ACTIONS}>{el}</ActionCtx.Provider>);

// The load-bearing spend fixture: a real costUsd that fmtUsd would render as "$42.42".
const SPEND = 42.42;
const DOLLARS = "$42.42";
const tokens = (over: Partial<EngineSnapshot["totals"]> = {}) =>
    ({ input: 1200, output: 3400, cacheRead: 90000, cacheCreation: 800, costUsd: SPEND, ...over });
const snap = (over: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
    taskId: "t", status: "running", currentIteration: null, iterations: [],
    totals: tokens(), feed: [], feedEventsConsumed: 0, terminalReason: null, ...over,
});
const iv = (index: number, over: Partial<EngineSnapshot["iterations"][number]> = {}) => ({
    index, verdict: "green" as const, tokens: tokens(), durationMs: 100, sessionId: "s", commitSha: "c", outputTail: null, ...over,
});
const vm = (over: Partial<TaskVM> = {}): TaskVM => ({
    id: "t", projectId: "p", title: "Build it", intent: "Do the thing", acceptance: ["npm test"],
    status: "running", scopeHint: null, dependsOn: [], planId: null, branchName: null,
    worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
    resumable: false, blocked: false, waitingOn: [], snap: null, validating: false, ...over,
});
const project = (over: Partial<Project> = {}): Project => ({
    id: "p", name: "alpha", repoPath: "C:\\repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null,
    model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null,
    promotionMode: "pr", jailImage: null, conductorSessionId: null, ...over,
});
// The two spend-carrying tasks the fleet-stat panel aggregates.
const spendingFleet = (): TaskVM[] => [
    vm({ id: "a", status: "merged", updatedAt: 1, snap: snap({ status: "merged" }) }),
    vm({ id: "b", status: "running", snap: snap({ iterations: [iv(0)] }) }),
];

describe("fleet-stat panel (ActivityPanel) — tokens, no spend $", () => {
    it("reports the tokens tile and NO dollar figure at all", () => {
        const html = render(<ActivityPanel tasks={spendingFleet()} />);
        expect(html).toContain("tokens");        // the tokens stat survives
        expect(html).not.toContain("spent");      // the old $ "spent" tile is gone
        expect(html).not.toContain("$");          // the whole panel is dollar-free
    });
    it("PROBE: the panel is dollar-free even when every task carries a fat costUsd", () => {
        // Guards against a happy-path replay: the fixtures DO carry spend (SPEND each) — had the
        // "spent" tile survived it would read fmtUsd(sum) and this would trip.
        const html = render(<ActivityPanel tasks={spendingFleet()} />);
        expect(html).not.toContain(DOLLARS);
        expect(html.includes("$")).toBe(false);
    });
});

describe("task cards (Board) — tokens, no spend $", () => {
    it("a running card shows a token figure and no dollar figure", () => {
        const html = render(<TaskCard task={vm({ status: "running", snap: snap({ iterations: [iv(0)] }) })} project={project()} />);
        expect(html).toContain("tok");            // the token read-out replaced the cost read-out
        expect(html).not.toContain("$");
    });
    it("PROBE: a card whose snapshot carries costUsd still renders NO $ (the cost read-out is gone)", () => {
        const html = render(<TaskCard task={vm({ status: "running", snap: snap() })} project={project()} />);
        expect(html).not.toContain(DOLLARS);
        expect(html).not.toContain("$");
    });
});

describe("task detail — Iterations table — tokens, no spend $", () => {
    it("renders the token cell but no cost column and no dollar figure", () => {
        const html = render(<IterationsTable task={vm({ snap: snap({ iterations: [iv(0), iv(1)] }) })} />);
        expect(html).toContain(">tokens<");       // the tokens column header survives
        expect(html).toContain("out");            // the …in · …out token cell survives
        expect(html).not.toContain(">cost<");     // the "cost" column header is gone
        expect(html).not.toContain("$");
    });
    it("PROBE: even an iteration carrying costUsd renders no $ (the cost cell is gone)", () => {
        const html = render(<IterationsTable task={vm({ snap: snap({ iterations: [iv(0)] }) })} />);
        expect(html).not.toContain(DOLLARS);
        expect(html).not.toContain("$");
    });
});

describe("task detail — Inspector — tokens, no spend $", () => {
    // The Inspector still shows the "cost cap" config ($25) — a token-independent loop bound, NOT
    // money-spent — so we assert the SPEND figure (fmtUsd(costUsd)) is gone, not every $.
    it("shows the tokens metric and never the money-spent figure", () => {
        const html = render(<Inspector task={vm({ snap: snap({ iterations: [iv(0)] }) })} project={project()} tasksById={{}} plans={[]} />);
        expect(html).toContain("tokens");         // the tokens metric survives
        expect(html).not.toContain(DOLLARS);      // the "cost" spend metric (fmtUsd(42.42)) is gone
    });
    it("PROBE: the money-spent figure is absent even with a fat costUsd on the snapshot", () => {
        const html = render(<Inspector task={vm({ snap: snap() })} project={project({ costCapUsd: 99 })} tasksById={{}} plans={[]} />);
        expect(html).not.toContain(DOLLARS);      // spend is gone…
        expect(html).toContain("$99");            // …though the (untouched) cost-cap config still reads out
    });
});

describe("PROBE — the negative control (a $ spend readout MUST FAIL these checks)", () => {
    it("the OLD fmtUsd spend readout DOES emit '$42.42' — proving the not-toContain checks have teeth", () => {
        const lying = renderToStaticMarkup(<span data-verify-unit="SpendReadout">{fmtUsd(SPEND)}</span>);
        expect(lying).toContain(DOLLARS);         // exactly what the de-dollarized surfaces must never emit
        expect(lying.includes("$")).toBe(true);
    });
});
