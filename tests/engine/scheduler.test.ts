// tests/engine/scheduler.test.ts
// The per-project auto-start scheduler: fills each project's slots (FIFO by createdAt) up to its cap,
// serves the paused-mode startNow, and owns the per-project merge mutexes. Event-driven (no clock).
// startTask is a fake returning a deferred the test controls, so tasks can be held "running".
import { describe, it, expect } from "vitest";
import { createScheduler } from "../../src/main/engine/scheduler";
import type { Project, Task, TaskStatus } from "../../src/shared/types";

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

const mkTask = (id: string, projectId: string, createdAt: number): Task => ({
    id, projectId, title: id, intent: "", acceptance: ["x"], status: "queued", scopeHint: null,
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt, updatedAt: createdAt,
});
const mkProject = (id: string, concurrencyCap: number | null): Project => ({
    id, name: id, repoPath: "/r", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph",
    checkCommand: "c", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null,
    stallTimeoutMin: null, model: null, concurrencyCap, terminalCommand: null,
});

// A harness with a controllable startTask: each started task hangs until the test settles it, and
// starting a task removes it from the queue (mirroring the DB flipping its status off "queued").
function harness(tasks: Task[], projects: Project[]) {
    let queued = [...tasks];
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    const startTask = (t: Task): Promise<TaskStatus> => {
        started.push(t.id);
        queued = queued.filter((q) => q.id !== t.id);
        return new Promise<TaskStatus>((resolve) => { resolvers.set(t.id, () => resolve("merged")); });
    };
    const scheduler = createScheduler({
        listQueued: () => queued,
        getProject: (id) => projects.find((p) => p.id === id),
        startTask,
    });
    const settle = async (id: string) => { resolvers.get(id)?.(); await flush(); };
    const runningOf = (pid: string) => scheduler.state().perProject.find((x) => x.projectId === pid)?.running ?? 0;
    return { scheduler, started, settle, runningOf };
}

describe("createScheduler — slot filling", () => {
    it("starts exactly cap tasks, refills a freed slot on settle, never exceeds the cap", async () => {
        const project = mkProject("p", 3);
        const tasks = [1, 2, 3, 4, 5].map((n) => mkTask(`t${n}`, "p", n));
        const h = harness(tasks, [project]);

        h.scheduler.kick();
        await flush();
        expect(h.started).toHaveLength(3);     // exactly cap started
        expect(h.runningOf("p")).toBe(3);

        await h.settle("t1");                  // one slot frees
        expect(h.started).toHaveLength(4);     // a 4th started to refill
        expect(h.runningOf("p")).toBe(3);      // still capped at 3
    });

    it("starts tasks in createdAt order (FIFO)", async () => {
        const project = mkProject("p", 2);
        // declared out of order; createdAt should decide
        const tasks = [mkTask("late", "p", 30), mkTask("early", "p", 10), mkTask("mid", "p", 20)];
        const h = harness(tasks, [project]);
        h.scheduler.kick();
        await flush();
        expect(h.started).toEqual(["early", "mid"]); // the two lowest createdAt
    });

    it("defaults the cap to 3 when concurrencyCap is NULL", async () => {
        const project = mkProject("p", null);
        const tasks = [1, 2, 3, 4].map((n) => mkTask(`t${n}`, "p", n));
        const h = harness(tasks, [project]);
        h.scheduler.kick();
        await flush();
        expect(h.started).toHaveLength(3);
    });

    it("when paused, kick() starts nothing; resuming fills slots", async () => {
        const project = mkProject("p", 3);
        const tasks = [1, 2, 3].map((n) => mkTask(`t${n}`, "p", n));
        const h = harness(tasks, [project]);
        h.scheduler.setPaused(true);
        h.scheduler.kick();
        await flush();
        expect(h.started).toHaveLength(0);
        expect(h.scheduler.state().paused).toBe(true);

        h.scheduler.setPaused(false); // resume → auto-fleet
        await flush();
        expect(h.started).toHaveLength(3);
        expect(h.scheduler.state().paused).toBe(false);
    });

    it("startNow starts a specific task even when paused, but never past the cap", async () => {
        const project = mkProject("p", 1);
        const tasks = [mkTask("a", "p", 1), mkTask("b", "p", 2)];
        const h = harness(tasks, [project]);
        h.scheduler.setPaused(true);

        h.scheduler.startNow("b"); // ignores FIFO + pause
        await flush();
        expect(h.started).toEqual(["b"]);

        h.scheduler.startNow("a"); // cap is 1 and b holds the slot → no-op
        await flush();
        expect(h.started).toEqual(["b"]);

        await h.settle("b");       // slot frees; but still paused → kick() auto-starts nothing
        h.scheduler.startNow("a"); // now a slot exists
        await flush();
        expect(h.started).toEqual(["b", "a"]);
    });

    it("fills two projects independently and concurrently (per-project accounting)", async () => {
        const projects = [mkProject("p1", 3), mkProject("p2", 2)];
        const tasks = [
            ...[1, 2, 3, 4].map((n) => mkTask(`p1-${n}`, "p1", n)),
            ...[1, 2, 3].map((n) => mkTask(`p2-${n}`, "p2", n)),
        ];
        const h = harness(tasks, projects);
        h.scheduler.kick();
        await flush();
        expect(h.runningOf("p1")).toBe(3); // p1 fills to its own cap
        expect(h.runningOf("p2")).toBe(2); // p2 fills to its own cap, concurrently
    });
});

describe("createScheduler — mutexFor", () => {
    it("serializes same-project merges and runs different projects' merges concurrently", async () => {
        const scheduler = createScheduler({ listQueued: () => [], getProject: () => undefined, startTask: async () => "merged" });
        const order: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((res) => { releaseFirst = res; });

        const a1 = scheduler.mutexFor("p1").withLock(async () => { order.push("p1-a-start"); await firstGate; order.push("p1-a-end"); });
        const a2 = scheduler.mutexFor("p1").withLock(async () => { order.push("p1-b"); });
        const b1 = scheduler.mutexFor("p2").withLock(async () => { order.push("p2-a"); });

        await flush();
        // p2 ran (different key); p1's second is blocked behind the first
        expect(order).toContain("p2-a");
        expect(order).toContain("p1-a-start");
        expect(order).not.toContain("p1-b");

        releaseFirst();
        await Promise.all([a1, a2, b1]);
        expect(order.indexOf("p1-a-end")).toBeLessThan(order.indexOf("p1-b"));
    });
});
