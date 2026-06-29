// tests/verify/scheduler/invariants.ts
// The three M4 safety invariants — pure predicates over the cross-task SchedulerRecording. Each returns
// `true` or a human-readable violation string; runSchedulerInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and
// complementary to, the untouched M2 (tests/verify/) and M3 (tests/verify/snapshot/) slices.
import type { SchedulerRecording, MergeInterval } from "./surface";

export interface SchedulerInvariant { name: string; holds: (r: SchedulerRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

const overlaps = (a: MergeInterval, b: MergeInterval): boolean => a.enter < b.exit && b.enter < a.exit;

function groupByProject(merges: MergeInterval[]): Map<string, MergeInterval[]> {
    const m = new Map<string, MergeInterval[]>();
    for (const x of merges) {
        const list = m.get(x.projectId);
        if (list) list.push(x); else m.set(x.projectId, [x]);
    }
    return m;
}

export const SCHEDULER_INVARIANTS: SchedulerInvariant[] = [
    // The mutex's single-flight guarantee: per project, no two merge intervals overlap in time
    // (max concurrent merge depth ≤ 1). Two parallel merges to one integration branch corrupt it.
    {
        name: "at-most-one-merge-in-flight",
        holds: (r) => {
            for (const [pid, list] of groupByProject(r.merges)) {
                for (let i = 0; i < list.length; i++) {
                    for (let j = i + 1; j < list.length; j++) {
                        if (overlaps(list[i], list[j])) return `project ${pid}: merges ${list[i].taskId} and ${list[j].taskId} overlap`;
                    }
                }
            }
            return true;
        },
    },
    // The scheduler never runs more than a project's cap concurrently.
    {
        name: "running-count-within-cap",
        holds: (r) => {
            for (const pid of Object.keys(r.maxRunningPerProject)) {
                const cap = r.caps[pid];
                if (cap == null) return `project ${pid} has no declared cap`;
                if (r.maxRunningPerProject[pid] > cap) return `project ${pid}: maxRunning ${r.maxRunningPerProject[pid]} > cap ${cap}`;
            }
            return true;
        },
    },
    // Rebase-on-tip + re-check: integration advances only after a passing check ∧ acceptance re-run
    // against the fresh tip, and a merge whose re-check FAILED must not advance.
    {
        name: "rebase-on-tip-then-recheck",
        holds: (r) => {
            for (const m of r.merges) {
                if (m.advanced && !(m.recheckPassed && m.recheckRanBeforeAdvance)) {
                    return `merge ${m.taskId} advanced without a passing re-check before the advance`;
                }
                if (!m.recheckPassed && m.advanced) {
                    return `merge ${m.taskId} advanced despite a failed re-check`;
                }
            }
            return true;
        },
    },
];

export function runSchedulerInvariants(r: SchedulerRecording): InvariantResult[] {
    return SCHEDULER_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
