// tests/verify/planqueue/gate.test.ts
// The plan-level gate's proof (plan-queue slice 3). Drives the REAL scheduler (createScheduler, with the
// real planGateAllows inside it) over fake deps — the tests/verify/deps idiom lifted one level: the edge
// lives on the PLAN (dependsOnPlan), and a child plan's WHOLE task set stays queued until every task in the
// parent plan reads 'merged'. On an all-terminal parent with unmerged tasks the modes split: gateMode=
// 'strict' keeps holding + raises the needs-attention (release-or-hold) notice; gateMode='yolo' releases +
// the notice names which parent tasks didn't land. Invariants: child-held-until-all-parent-merged /
// strict-holds-on-unmerged-terminal / yolo-releases-on-all-terminal — each with a negative-control probe
// (a hand-crafted broken recording) that MUST FAIL. Vocabulary from ~/.claude/verification.md.
import { describe, it, expect } from "vitest";
import { createScheduler, type PlanGateMode, type PlanGateNotice } from "../../../src/main/engine/scheduler";
import type { Project, Task, TaskStatus } from "../../../src/shared/types";

// ── the scenario surface (tests/verify/deps/surface.ts idiom, plan edition) ───────────────────────

interface ScenarioPlan { id: string; dependsOnPlan?: string | null; gateMode?: PlanGateMode }
interface ScenarioTask {
    id: string;
    planId?: string;
    initialStatus?: TaskStatus; // default "queued" (a non-queued seed models a parent already settled)
    settlesTo?: TaskStatus;     // what a started task settles to when released (default "merged")
}
interface Scenario { cap?: number; plans?: ScenarioPlan[]; tasks: ScenarioTask[] }

type ParentSnapshot = Array<{ id: string; status: TaskStatus }>;

// One gated child (a task whose plan carries a dependsOnPlan edge), as observed by the recording.
interface ChildObservation {
    taskId: string;
    planId: string;
    parentPlanId: string;
    gateMode: PlanGateMode;
    started: boolean;
    parentAtStart: ParentSnapshot | null; // parent-plan statuses AT the start instant (null = never started)
    parentAtEnd: ParentSnapshot;          // parent-plan statuses at quiescence
}
interface GateRecording {
    unit: "planqueue-gate";
    startOrder: string[];
    children: ChildObservation[];
    notices: PlanGateNotice[];
}

const mkProject = (concurrencyCap: number): Project => ({
    id: "p", name: "p", repoPath: "/r", integrationBranch: "integration/ralph", targetBranch: "main", branchPrefix: "ralph",
    checkCommand: "c", worktreeDir: ".helm/worktrees", setupCommand: null, iterationCap: null, noProgressK: null,
    stallTimeoutMin: null, model: null, concurrencyCap, terminalCommand: null, autoModeEnvironment: null,
    promotionMode: "pr", jailImage: null, conductorSessionId: null,
});
const mkTask = (id: string, createdAt: number, planId: string | null, status: TaskStatus): Task => ({
    id, projectId: "p", title: id, intent: "", acceptance: ["x"], status, scopeHint: null, dependsOn: [], planId,
    branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt, updatedAt: createdAt,
});

// Drive the real scheduler through one scenario and distill the recording. Deterministic: no timers, only
// microtask flushes; started tasks hang on a deferred resolver released one at a time (in start order), so
// a parent plan's last settle re-kicks and may release the child plan — exactly the gate under test.
async function runScenario(scenario: Scenario): Promise<GateRecording> {
    const project = mkProject(scenario.cap ?? 3);
    const plans = new Map<string, { dependsOnPlan: string | null; gateMode: PlanGateMode }>(
        (scenario.plans ?? []).map((p) => [p.id, { dependsOnPlan: p.dependsOnPlan ?? null, gateMode: p.gateMode ?? "strict" }]),
    );
    const tasks = scenario.tasks.map((t, i) => mkTask(t.id, i, t.planId ?? null, t.initialStatus ?? "queued"));
    const settlesTo = new Map<string, TaskStatus>(scenario.tasks.map((t) => [t.id, t.settlesTo ?? "merged"]));
    // Live status map: queued → running on start → its settlesTo on release. listPlanTasks reads it, so the
    // plan gate sees real parent statuses evolve.
    const statuses = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));

    const planTasksOf = (planId: string): ParentSnapshot =>
        tasks.filter((t) => t.planId === planId).map((t) => ({ id: t.id, status: statuses.get(t.id)! }));

    let queued = tasks.filter((t) => t.status === "queued");
    const startOrder: string[] = [];
    const parentAtStart = new Map<string, ParentSnapshot>();
    const notices: PlanGateNotice[] = [];
    const resolvers = new Map<string, () => void>();

    const startTask = (task: Task): Promise<TaskStatus> => {
        startOrder.push(task.id);
        const edge = task.planId != null ? plans.get(task.planId)?.dependsOnPlan : null;
        if (edge != null) parentAtStart.set(task.id, planTasksOf(edge)); // snapshot AT the start instant
        statuses.set(task.id, "running");
        queued = queued.filter((q) => q.id !== task.id);
        const to = settlesTo.get(task.id) ?? "merged";
        return new Promise<TaskStatus>((resolve) => { resolvers.set(task.id, () => { statuses.set(task.id, to); resolve(to); }); });
    };

    const scheduler = createScheduler({
        listQueued: () => queued,
        getProject: () => project,
        startTask,
        getTaskStatus: (id) => statuses.get(id),
        getPlanGate: (planId) => plans.get(planId),
        listPlanTasks: planTasksOf,
        onPlanGateNotice: (n) => notices.push(n),
    });

    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    scheduler.kick();
    await flush();
    // Release started-but-unsettled tasks one at a time; each settle re-kicks and may release a gated child.
    // A held task never starts → never gets a resolver → the loop terminates at quiescence.
    for (;;) {
        const pending = startOrder.find((id) => resolvers.has(id));
        if (!pending) break;
        const release = resolvers.get(pending)!;
        resolvers.delete(pending);
        release();
        await flush();
    }
    // One extra kick at quiescence: the notice dedupe must hold (a still-held child re-evaluated on a later
    // kick must NOT re-raise the same decision) — every notices assertion below bakes this in.
    scheduler.kick();
    await flush();

    const children: ChildObservation[] = tasks
        .filter((t) => t.planId != null && plans.get(t.planId)?.dependsOnPlan != null)
        .map((t) => {
            const planId = t.planId!;
            const parentPlanId = plans.get(planId)!.dependsOnPlan!;
            return {
                taskId: t.id, planId, parentPlanId, gateMode: plans.get(planId)!.gateMode,
                started: startOrder.includes(t.id),
                parentAtStart: parentAtStart.get(t.id) ?? null,
                parentAtEnd: planTasksOf(parentPlanId),
            };
        });

    return { unit: "planqueue-gate", startOrder, children, notices };
}

// ── invariants (each returns true or a human-readable violation — the verification.md contract) ───

const TERMINAL = new Set<TaskStatus>(["merged", "needs-human", "abandoned"]);
const allMerged = (ts: ParentSnapshot) => ts.every((t) => t.status === "merged");
const allTerminal = (ts: ParentSnapshot) => ts.every((t) => TERMINAL.has(t.status));
const unmergedIds = (ts: ParentSnapshot) => ts.filter((t) => t.status !== "merged").map((t) => t.id).sort();

const GATE_INVARIANTS: Array<{ name: string; check: (r: GateRecording) => true | string }> = [
    {
        // No gated child may start while ANY parent-plan task is still in flight (queued/running/handed-off);
        // and a parent plan that fully lands must actually release the child (held UNTIL, never wedged).
        name: "child-held-until-all-parent-merged",
        check: (r) => {
            for (const c of r.children) {
                if (c.parentAtStart && !allTerminal(c.parentAtStart))
                    return `${c.taskId} started while parent plan ${c.parentPlanId} had in-flight tasks`;
                if (allMerged(c.parentAtEnd) && c.parentAtEnd.length > 0 && !c.started)
                    return `${c.taskId} never started although every task in parent plan ${c.parentPlanId} merged`;
            }
            return true;
        },
    },
    {
        // strict: a child may only ever start on an ALL-MERGED parent; an all-terminal parent with unmerged
        // tasks keeps it held AND raises the needs-attention (release-or-hold) notice.
        name: "strict-holds-on-unmerged-terminal",
        check: (r) => {
            for (const c of r.children) {
                if (c.gateMode !== "strict") continue;
                if (c.parentAtStart && !allMerged(c.parentAtStart))
                    return `strict child ${c.taskId} started with unmerged parent tasks ${unmergedIds(c.parentAtStart).join(",")}`;
                if (allTerminal(c.parentAtEnd) && unmergedIds(c.parentAtEnd).length > 0) {
                    if (c.started) return `strict child ${c.taskId} started on an unmerged-terminal parent plan`;
                    if (!r.notices.some((n) => n.childPlanId === c.planId && n.action === "held"))
                        return `strict child plan ${c.planId} is held with no needs-attention notice`;
                }
            }
            return true;
        },
    },
    {
        // yolo: an all-terminal parent releases the child even with unmerged tasks — and the notice must
        // name exactly which parent tasks didn't land.
        name: "yolo-releases-on-all-terminal",
        check: (r) => {
            for (const c of r.children) {
                if (c.gateMode !== "yolo") continue;
                if (!allTerminal(c.parentAtEnd) || c.parentAtEnd.length === 0) continue;
                if (!c.started) return `yolo child ${c.taskId} never started although parent plan ${c.parentPlanId} is all-terminal`;
                const unmerged = unmergedIds(c.parentAtEnd);
                if (unmerged.length > 0) {
                    const n = r.notices.find((x) => x.childPlanId === c.planId && x.action === "released");
                    if (!n) return `yolo child plan ${c.planId} released with no notice of what didn't land`;
                    if ([...n.unmergedTaskIds].sort().join(",") !== unmerged.join(","))
                        return `yolo notice names [${n.unmergedTaskIds.join(",")}] but unmerged parent tasks are [${unmerged.join(",")}]`;
                }
            }
            return true;
        },
    },
];

type Check = { name: string; ok: boolean; why?: string };
function runGateInvariants(r: GateRecording): Check[] {
    return GATE_INVARIANTS.map(({ name, check }) => {
        try {
            const v = check(r);
            return v === true ? { name, ok: true } : { name, ok: false, why: v };
        } catch (err) {
            return { name, ok: false, why: `verifier threw: ${String(err)}` }; // when in doubt, FAIL
        }
    });
}
const failed = (r: GateRecording) => runGateInvariants(r).filter((c) => !c.ok).map((c) => c.name);

// ── probes 🔍: hand-crafted BROKEN recordings (negative controls) — each MUST FAIL its invariant ───

const probeChild = (over: Partial<ChildObservation>): ChildObservation => ({
    taskId: "C1", planId: "child", parentPlanId: "parent", gateMode: "strict",
    started: false, parentAtStart: null, parentAtEnd: [{ id: "P1", status: "merged" }], ...over,
});
const PROBES: Array<{ mustFail: string; why: string; recording: GateRecording }> = [
    {
        mustFail: "child-held-until-all-parent-merged",
        why: "a child that starts while a parent task is still running",
        recording: {
            unit: "planqueue-gate", startOrder: ["C1"], notices: [],
            children: [probeChild({
                gateMode: "yolo", started: true,
                parentAtStart: [{ id: "P1", status: "running" }], parentAtEnd: [{ id: "P1", status: "merged" }],
            })],
        },
    },
    {
        mustFail: "strict-holds-on-unmerged-terminal",
        why: "a strict child that starts although a terminal parent task never merged",
        recording: {
            unit: "planqueue-gate", startOrder: ["C1"], notices: [],
            children: [probeChild({
                started: true,
                parentAtStart: [{ id: "P1", status: "needs-human" }], parentAtEnd: [{ id: "P1", status: "needs-human" }],
            })],
        },
    },
    {
        mustFail: "yolo-releases-on-all-terminal",
        why: "a yolo child still held although the parent plan is all-terminal",
        recording: {
            unit: "planqueue-gate", startOrder: [], notices: [],
            children: [probeChild({ gateMode: "yolo", parentAtEnd: [{ id: "P1", status: "needs-human" }] })],
        },
    },
];

// ── the matrix ─────────────────────────────────────────────────────────────────────────────────────

describe("verify/planqueue-gate: the recording is the real scheduler's behaviour", () => {
    it("a child plan's WHOLE task set is held until every parent task merges, then released in FIFO", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }, { id: "B", dependsOnPlan: "A", gateMode: "strict" }],
            tasks: [{ id: "P1", planId: "A" }, { id: "P2", planId: "A" }, { id: "C1", planId: "B" }, { id: "C2", planId: "B" }],
        });
        expect(rec.startOrder).toEqual(["P1", "P2", "C1", "C2"]); // no child start interleaves the parents
        for (const id of ["C1", "C2"]) {
            const c = rec.children.find((x) => x.taskId === id)!;
            expect(c.parentAtStart).toEqual([{ id: "P1", status: "merged" }, { id: "P2", status: "merged" }]);
        }
        expect(rec.notices).toEqual([]); // a fully-landed parent releases silently — no attention needed
        expect(failed(rec)).toEqual([]);
    });

    it("gateMode='strict': an all-terminal parent with an unmerged task holds the child and raises ONE held notice", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }, { id: "B", dependsOnPlan: "A", gateMode: "strict" }],
            tasks: [
                { id: "P1", planId: "A" }, { id: "P2", planId: "A", settlesTo: "needs-human" },
                { id: "C1", planId: "B" }, { id: "C2", planId: "B" },
            ],
        });
        expect(rec.startOrder).toEqual(["P1", "P2"]); // both children stay queued
        // ONE notice despite two held children and the extra quiescence kick — the dedupe holds.
        expect(rec.notices).toEqual([{
            childPlanId: "B", parentPlanId: "A", gateMode: "strict", action: "held", unmergedTaskIds: ["P2"],
        }]);
        expect(failed(rec)).toEqual([]);
    });

    it("gateMode='yolo': an all-terminal parent releases the child; the notice names what didn't land", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }, { id: "B", dependsOnPlan: "A", gateMode: "yolo" }],
            tasks: [
                { id: "P1", planId: "A" }, { id: "P2", planId: "A", settlesTo: "needs-human" },
                { id: "C1", planId: "B" },
            ],
        });
        expect(rec.startOrder).toEqual(["P1", "P2", "C1"]); // released, but only once the parent settled
        expect(rec.notices).toEqual([{
            childPlanId: "B", parentPlanId: "A", gateMode: "yolo", action: "released", unmergedTaskIds: ["P2"],
        }]);
        expect(failed(rec)).toEqual([]);
    });

    it("a parent seeded all-terminal pre-boot (merged + abandoned) gates the same way — strict holds at first kick", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }, { id: "B", dependsOnPlan: "A", gateMode: "strict" }],
            tasks: [
                { id: "P1", planId: "A", initialStatus: "merged" }, { id: "P2", planId: "A", initialStatus: "abandoned" },
                { id: "C1", planId: "B" },
            ],
        });
        expect(rec.startOrder).toEqual([]);
        expect(rec.notices).toEqual([{
            childPlanId: "B", parentPlanId: "A", gateMode: "strict", action: "held", unmergedTaskIds: ["P2"],
        }]);
        expect(failed(rec)).toEqual([]);
    });

    it("handed-off is NOT terminal: a handed-off parent keeps the child waiting with no notice (both modes would)", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }, { id: "B", dependsOnPlan: "A", gateMode: "yolo" }],
            tasks: [{ id: "P1", planId: "A", initialStatus: "handed-off" }, { id: "C1", planId: "B" }],
        });
        expect(rec.startOrder).toEqual([]); // even yolo waits — the parent is in flight, not settled
        expect(rec.notices).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("a ghost parent plan (edge to a plan with no tasks) never wedges the child — it starts, silently", async () => {
        const rec = await runScenario({
            plans: [{ id: "B", dependsOnPlan: "ghost", gateMode: "strict" }],
            tasks: [{ id: "C1", planId: "B" }],
        });
        expect(rec.startOrder).toEqual(["C1"]);
        expect(rec.notices).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("a task whose plan row is gone, and a plan with no edge, schedule exactly as before (FIFO, no notices)", async () => {
        const rec = await runScenario({
            plans: [{ id: "A" }],
            tasks: [{ id: "a", planId: "unknown-plan" }, { id: "b", planId: "A" }, { id: "c" }],
        });
        expect(rec.startOrder).toEqual(["a", "b", "c"]); // the M4 baseline, byte-identical
        expect(rec.children).toEqual([]);                // nothing on this board is gated
        expect(rec.notices).toEqual([]);
        expect(failed(rec)).toEqual([]);
    });

    it("startNow can't race the plan gate — the paused-mode manual start is held under the same rule", async () => {
        const plans = new Map<string, { dependsOnPlan: string | null; gateMode: PlanGateMode }>([
            ["A", { dependsOnPlan: null, gateMode: "strict" }],
            ["B", { dependsOnPlan: "A", gateMode: "strict" }],
        ]);
        const tasks = [mkTask("P1", 0, "A", "queued"), mkTask("C1", 1, "B", "queued")];
        const statuses = new Map<string, TaskStatus>(tasks.map((t) => [t.id, t.status]));
        const started: string[] = [];
        const scheduler = createScheduler({
            listQueued: () => tasks.filter((t) => statuses.get(t.id) === "queued"),
            getProject: () => mkProject(3),
            startTask: (t) => {
                started.push(t.id);
                statuses.set(t.id, "running");
                return new Promise<TaskStatus>(() => {}); // never settles — P1 stays unmerged
            },
            getTaskStatus: (id) => statuses.get(id),
            getPlanGate: (planId) => plans.get(planId),
            listPlanTasks: (planId) => tasks.filter((t) => t.planId === planId).map((t) => ({ id: t.id, status: statuses.get(t.id)! })),
        });
        scheduler.setPaused(true);
        scheduler.startNow("C1"); // gated (parent plan unmerged) → must not start
        scheduler.startNow("P1"); // ungated → starts
        scheduler.startNow("C1"); // parent now running → still gated
        await Promise.resolve();
        expect(started).toEqual(["P1"]);
    });
});

describe("verify/planqueue-gate: the checklist itself", () => {
    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(PROBES.length).toBeGreaterThan(0);
    });

    it("declares a must-FAIL probe for every invariant", () => {
        expect([...new Set(PROBES.map((p) => p.mustFail))].sort()).toEqual(GATE_INVARIANTS.map((i) => i.name).sort());
    });

    it("evaluates every declared invariant on every recording", async () => {
        const rec = await runScenario({ tasks: [{ id: "a" }] });
        expect(runGateInvariants(rec).map((c) => c.name).sort()).toEqual(GATE_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/planqueue-gate: negative controls — each broken recording FAILS its named invariant", () => {
    it.each(PROBES.map((p) => [p.why, p] as const))("🔍 %s MUST FAIL", (_why, probe) => {
        expect(failed(probe.recording)).toContain(probe.mustFail);
    });

    it("a verifier fed garbage FAILS rather than silently passing (when in doubt, FAIL)", () => {
        const garbage = {} as unknown as GateRecording; // .children access throws inside every predicate
        const results = runGateInvariants(garbage);
        expect(results.every((c) => typeof c.ok === "boolean")).toBe(true);
        expect(results.some((c) => !c.ok)).toBe(true);
    });
});
