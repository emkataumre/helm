// tests/engine/deps.test.ts
// The M9 merged-gate predicate. A pure function over a task's dependency edges + a status lookup — the
// one place the "blocked-until-all-parents-merged" rule lives, so the scheduler (kick/startNow) and the
// cockpit derivation both read the SAME truth. blocked is DERIVED, not a stored TaskStatus.
import { describe, it, expect } from "vitest";
import { depsSatisfied } from "../../src/main/engine/deps";
import type { Task, TaskStatus } from "../../src/shared/types";

const mkTask = (id: string, dependsOn: string[]): Task => ({
    id, projectId: "p", title: id, intent: "", acceptance: ["x"], status: "queued", scopeHint: null,
    dependsOn, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
});

describe("depsSatisfied — the blocked-until-all-parents-merged gate", () => {
    it("a task with no edges is always satisfied (never consults the lookup)", () => {
        let consulted = false;
        expect(depsSatisfied(mkTask("t", []), () => { consulted = true; return undefined; })).toBe(true);
        expect(consulted).toBe(false); // .every over [] short-circuits — Phase-1 tasks pay nothing
    });

    // The semantics table (plan Task 2): a single parent at each status decides eligibility.
    const cases: Array<[TaskStatus | undefined, boolean]> = [
        ["merged", true],        // parent landed on integration → eligible
        ["queued", false],       // parent hasn't started → blocked (waiting)
        ["running", false],      // parent in flight → blocked (waiting)
        ["handed-off", false],   // parent paused for drop-in → blocked (waiting)
        ["needs-human", false],  // parent wedged → blocked (stuck — needs the human)
        ["abandoned", false],    // parent dead → blocked (stuck — needs the human)
        [undefined, true],       // parent deleted (unknown) → satisfied (deliberate; don't wedge on a ghost)
    ];
    it.each(cases)("a single parent at status %s → satisfied=%s", (status, expected) => {
        expect(depsSatisfied(mkTask("child", ["p1"]), () => status)).toBe(expected);
    });

    it("multiple parents: satisfied iff EVERY parent is merged-or-unknown", () => {
        const statuses: Record<string, TaskStatus | undefined> = { a: "merged", b: "merged", c: "running" };
        expect(depsSatisfied(mkTask("child", ["a", "b"]), (id) => statuses[id])).toBe(true);
        expect(depsSatisfied(mkTask("child", ["a", "b", "c"]), (id) => statuses[id])).toBe(false); // c running blocks
        expect(depsSatisfied(mkTask("child", ["a", "ghost"]), (id) => statuses[id])).toBe(true);   // merged + deleted = ok
    });
});
