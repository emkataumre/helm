// tests/db/failures.test.ts
// M18: recordRecycledFailure — the ledger insert for an in-place merge-loss recycle. Unlike
// recordFailure (open row, stamped later by the task's terminal outcome), a recycle row lands
// ALREADY stamped 'recycled': nothing waits on a human, so it must never count as open, and the
// terminal-outcome stamping must never rewrite it.
import { describe, it, expect } from "vitest";
import { openDb } from "../../src/main/db/db";
import { insertTask, updateTask } from "../../src/main/db/tasks";
import { listFailures, recordRecycledFailure, summarizeFailures } from "../../src/main/db/failures";

const setup = () => {
    const db = openDb(":memory:");
    const task = insertTask(db, { projectId: "p1", title: "T", intent: "x", acceptance: ["a"] });
    return { db, task };
};

describe("recordRecycledFailure", () => {
    it("lands a kind-faithful row already stamped resolution='recycled' (never open)", () => {
        const { db, task } = setup();
        recordRecycledFailure(db, task.id, "merge conflict", { kind: "merge-conflict", iterationIndex: 2 });
        const rows = listFailures(db);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ taskId: task.id, kind: "merge-conflict", reason: "merge conflict", iterationIndex: 2, resolution: "recycled" });
        expect(rows[0].resolvedAt).not.toBeNull();
        expect(listFailures(db, { open: true })).toHaveLength(0); // nothing waits on a human
    });

    it("is untouched by the terminal-outcome stamping (only OPEN rows get resolved/abandoned)", () => {
        const { db, task } = setup();
        recordRecycledFailure(db, task.id, "merge conflict", { kind: "merge-conflict", iterationIndex: 0 });
        updateTask(db, task.id, { status: "merged", failureReason: null }); // stamps open rows only
        expect(listFailures(db)[0].resolution).toBe("recycled"); // not rewritten to 'resolved'
    });

    it("summarizes alongside terminal rows so fixed-itself vs needed-me is answerable", () => {
        const { db, task } = setup();
        recordRecycledFailure(db, task.id, "merge conflict", { kind: "merge-conflict", iterationIndex: 0 });
        updateTask(db, task.id, { status: "needs-human", failureReason: "merge conflict", failure: { kind: "merge-conflict", iterationIndex: 1 } });
        const summary = summarizeFailures(db);
        expect(summary).toEqual([{ kind: "merge-conflict", total: 2, open: 1 }]); // the recycle counts, but not as open
    });

    it("skips the write when the task row is missing (nothing to attribute), like recordFailure", () => {
        const { db } = setup();
        recordRecycledFailure(db, "no-such-task", "merge conflict", { kind: "merge-conflict", iterationIndex: 0 });
        expect(listFailures(db)).toHaveLength(0);
    });
});
