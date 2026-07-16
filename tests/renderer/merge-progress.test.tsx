// tests/renderer/merge-progress.test.tsx
// The merge-stage visual (UI-only). The engine marks the merge stage with gate feed labels
// ("merge: waiting" / "merge: merging" / "merge re-check: running|passed") while the task is
// still running/handed-off — no TaskStatus exists for it. mergePhaseOf derives the phase from
// the snapshot's feed; MergeChip is the distinct treatment; TaskCard and TaskDetail stamp
// data-verify-merge-phase so the state is assertable off the DOM. The load-bearing PROBE:
// a running-NOT-merging card asserting the merge treatment MUST FAIL (no stamp, no chip).
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ActionCtx, mergePhaseOf, MergeChip, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import { TaskCard } from "../../src/renderer/views/Board";
import { TaskDetail } from "../../src/renderer/views/TaskDetail";
import type { ActivityEntry, EngineSnapshot, Project, TaskStatus } from "../../src/shared/types";

/* ---------- fixtures (the components.test.tsx shapes) ---------- */
const noop = () => { /* render-only */ };
const STUB_ACTIONS: CockpitActions = {
    openTask: noop, openPlan: noop, startNow: noop, dropIn: noop, startFresh: noop,
    resume: noop, verifyMerge: noop, abandon: noop, clearDeps: noop, openShell: noop,
};
const render = (el: ReactElement): string =>
    renderToStaticMarkup(<ActionCtx.Provider value={STUB_ACTIONS}>{el}</ActionCtx.Provider>);

const tokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 });
const gate = (text: string): ActivityEntry => ({ iterationIndex: 0, kind: "gate", text });
const snap = (over: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
    taskId: "t", status: "running", currentIteration: null, iterations: [],
    totals: tokens(), feed: [], feedEventsConsumed: 0, terminalReason: null, ...over,
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
// A task whose feed ends in the given entries — the shape a landing task's snapshot actually has.
const inFeed = (entries: ActivityEntry[], status: TaskStatus = "running") =>
    vm({ status, snap: snap({ feed: entries, feedEventsConsumed: entries.length }) });

describe("mergePhaseOf (feed → merge-stage derivation)", () => {
    it("maps each live engine label to its phase", () => {
        expect(mergePhaseOf(inFeed([gate("merge: waiting")]))).toBe("waiting");
        expect(mergePhaseOf(inFeed([gate("merge: merging")]))).toBe("merging");
        expect(mergePhaseOf(inFeed([gate("merge re-check: running")]))).toBe("re-check");
        expect(mergePhaseOf(inFeed([gate("merge re-check: passed")]))).toBe("re-check");
    });
    it("covers the handed-off verify-&-merge path (the task never passes through running)", () => {
        expect(mergePhaseOf(inFeed([gate("merge: waiting")], "handed-off"))).toBe("waiting");
    });
    it("a later feed entry ends the phase — terminal merge labels, recycle, agent output", () => {
        expect(mergePhaseOf(inFeed([gate("merge: merging"), gate("merge: merged")]))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("merge re-check: running"), gate("merge re-check: failed")]))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("merge: merging"), gate("merge: lost race — recycled (merge-conflict)")]))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("merge: waiting"), { iterationIndex: 1, kind: "assistant", text: "retrying" }]))).toBeNull();
    });
    it("PROBE: a plain running task is NEVER in the merge phase (loop gates don't count)", () => {
        expect(mergePhaseOf(vm())).toBeNull();                                             // no snapshot at all
        expect(mergePhaseOf(inFeed([]))).toBeNull();                                       // empty feed
        expect(mergePhaseOf(inFeed([{ iterationIndex: 0, kind: "tool-use", text: "Bash" }]))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("check: passed")]))).toBeNull();                  // the loop's own gate
        expect(mergePhaseOf(inFeed([gate("acceptance: passed")]))).toBeNull();
    });
    it("PROBE: a terminal status is never merging, even with a live merge label last", () => {
        expect(mergePhaseOf(inFeed([gate("merge: merging")], "merged"))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("merge re-check: running")], "needs-human"))).toBeNull();
        expect(mergePhaseOf(inFeed([gate("merge: waiting")], "queued"))).toBeNull();
    });
});

describe("MergeChip (the distinct treatment)", () => {
    it("stamps its unit + phase and names the phase distinctly", () => {
        const html = render(<MergeChip phase="merging" />);
        expect(html).toContain('data-verify-unit="MergeChip"');
        expect(html).toContain('data-verify-phase="merging"');
        expect(html).toContain("merging onto integration");
        expect(render(<MergeChip phase="waiting" />)).toContain("merge: waiting on the lane");
        expect(render(<MergeChip phase="re-check" />)).toContain("merge re-check running");
    });
});

describe("TaskCard merge treatment (the board face)", () => {
    it("a landing running card renders the merge treatment and stamps data-verify-merge-phase", () => {
        const html = render(<TaskCard task={inFeed([gate("merge: merging")])} project={project()} />);
        expect(html).toContain('data-verify-merge-phase="merging"');
        expect(html).toContain('data-verify-unit="MergeChip"');
        expect(html).toContain("merging onto integration");
    });
    it("a handed-off card mid verify-&-merge shows the waiting treatment", () => {
        const html = render(<TaskCard task={inFeed([gate("merge: waiting")], "handed-off")} project={project()} />);
        expect(html).toContain('data-verify-merge-phase="waiting"');
        expect(html).toContain("merge: waiting on the lane");
    });
    it("PROBE: a running-NOT-merging card MUST NOT carry the merge treatment", () => {
        const plain = vm({
            snap: snap({
                feed: [{ iterationIndex: 0, kind: "tool-use", text: "Bash" }],
                currentIteration: { index: 0, phase: "working", latestActivity: "editing foo.ts" },
            }),
        });
        const html = render(<TaskCard task={plain} project={project()} />);
        expect(html).toContain('data-verify-status="running"');   // it IS the plain running card
        expect(html).not.toContain("data-verify-merge-phase");    // …with NO merge stamp
        expect(html).not.toContain('data-verify-unit="MergeChip"');
        expect(html).not.toContain("merging onto integration");
    });
    it("PROBE: an already-merged card carries no merge treatment (the stage is over)", () => {
        const html = render(<TaskCard task={inFeed([gate("merge: merged")], "merged")} project={project()} />);
        expect(html).not.toContain("data-verify-merge-phase");
        expect(html).not.toContain('data-verify-unit="MergeChip"');
    });
});

describe("TaskDetail merge treatment (the detail face)", () => {
    const detailProps = { project: project(), tasksById: {}, plans: [], onBack: noop };
    it("a landing task's detail stamps merge-phase on its root and shows the chip in the header", () => {
        const html = render(<TaskDetail task={inFeed([gate("merge re-check: running")])} {...detailProps} />);
        expect(html).toContain('data-verify-unit="TaskDetail"');
        expect(html).toContain('data-verify-merge-phase="re-check"');
        expect(html).toContain('data-verify-unit="MergeChip"');
        expect(html).toContain("merge re-check running");
    });
    it("PROBE: a running-NOT-merging detail MUST NOT carry the merge treatment", () => {
        const plain = vm({
            snap: snap({
                feed: [{ iterationIndex: 0, kind: "assistant", text: "working on it" }],
                currentIteration: { index: 0, phase: "working", latestActivity: "working on it" },
            }),
        });
        const html = render(<TaskDetail task={plain} {...detailProps} />);
        expect(html).toContain('data-verify-status="running"');
        expect(html).not.toContain("data-verify-merge-phase");
        expect(html).not.toContain('data-verify-unit="MergeChip"');
    });
});
