// tests/verify/reconcile/invariants.ts
// The M6 ① reconcile safety invariants — pure predicates over the flat ReconcileRecording. Each returns
// `true` or a human-readable violation string; runReconcileInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL").
import type { ReconcileRecording } from "./surface";

export interface ReconcileInvariant { name: string; holds: (r: ReconcileRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const RECONCILE_INVARIANTS: ReconcileInvariant[] = [
    // The core completeness+safety guarantee: boot leaves DB and git consistent. Every crashed running
    // task is re-driven exactly once (requeue|rebuild|to-needs-human — never zero, never double), every
    // orphan is reaped, and NO worktree a human is legitimately steering (running being requeued, or
    // handed-off / needs-human) is pruned.
    {
        name: "db-git-reconciled",
        holds: (r) => {
            for (const id of r.runningTaskIds) {
                const n = r.taskActionCountById[id] ?? 0;
                if (n !== 1) return `crashed running task ${id} got ${n} task actions (must be exactly 1)`;
            }
            for (const p of r.mustPrunePaths) {
                if (!r.prunedPaths.includes(p)) return `orphan worktree left unpruned: ${p}`;
            }
            for (const p of r.mustNotPrunePaths) {
                if (r.prunedPaths.includes(p)) return `retaining worktree wrongly pruned (a human is steering it): ${p}`;
            }
            return true;
        },
    },
    // A leftover worktree owned only by a terminal (merged|abandoned) task is reaped — terminal statuses
    // don't retain, so their crash-leftover worktrees must not accumulate as orphans.
    {
        name: "worktree-cleaned-on-terminal",
        holds: (r) => {
            for (const p of r.terminalOwnedPaths) {
                if (!r.prunedPaths.includes(p)) return `terminal-owned leftover worktree not pruned: ${p}`;
            }
            return true;
        },
    },
];

export function runReconcileInvariants(r: ReconcileRecording): InvariantResult[] {
    return RECONCILE_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
