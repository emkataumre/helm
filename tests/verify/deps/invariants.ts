// tests/verify/deps/invariants.ts
// The three M9 safety invariants — pure predicates over the cross-task DepsRecording. Each returns `true`
// or a human-readable violation string; runDepsInvariants wraps them so a predicate that THROWS becomes a
// failed check, never a silent pass ("when in doubt, FAIL"). Separate from, and complementary to, the M4
// tests/verify/scheduler/ slice.
import type { DepsRecording } from "./surface";

export interface DepsInvariant { name: string; holds: (r: DepsRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// The gate's single truth: a parent is satisfied iff MERGED or UNKNOWN (deleted). Everything else blocks.
const satisfied = (status: string | undefined): boolean => status === undefined || status === "merged";
const sorted = (xs: string[]): string => JSON.stringify([...xs].sort());

export const DEPS_INVARIANTS: DepsInvariant[] = [
    // The scheduler never STARTS a task while any of its existing parents is unmerged. Read from the parent
    // statuses observed at the instant of each start — the ground truth of the merged-gate.
    {
        name: "no-start-before-deps-merged",
        holds: (r) => {
            for (const s of r.starts) {
                for (const p of s.parents) {
                    if (!satisfied(p.status)) return `task ${s.taskId} started while parent ${p.id} was ${p.status}`;
                }
            }
            return true;
        },
    },
    // The DERIVED blocked/waitingOn agree with the semantics table: blocked ⟺ some existing parent is
    // unmerged, and waitingOn lists exactly those parents.
    {
        name: "blocked-derivation-correct",
        holds: (r) => {
            for (const d of r.derivations) {
                const expectedBlocked = d.parents.some((p) => !satisfied(p.status));
                if (d.blocked !== expectedBlocked) return `task ${d.taskId}: blocked=${d.blocked} but expected ${expectedBlocked}`;
                const expectedWaiting = d.parents.filter((p) => !satisfied(p.status)).map((p) => p.id);
                if (sorted(d.waitingOnIds) !== sorted(expectedWaiting)) return `task ${d.taskId}: waitingOn=${JSON.stringify(d.waitingOnIds)} but expected ${JSON.stringify(expectedWaiting)}`;
            }
            return true;
        },
    },
    // A no-edges board schedules exactly as M4 did — the start order equals the FIFO (createdAt) order.
    // Only claimed for edge-free boards (an edges board legitimately reorders around the gate).
    {
        name: "empty-deps-byte-identical",
        holds: (r) => {
            if (r.hasEdges) return true;
            if (JSON.stringify(r.startOrder) !== JSON.stringify(r.fifoOrder)) {
                return `no-edges start order ${JSON.stringify(r.startOrder)} != FIFO ${JSON.stringify(r.fifoOrder)}`;
            }
            return true;
        },
    },
];

export function runDepsInvariants(r: DepsRecording): InvariantResult[] {
    return DEPS_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
