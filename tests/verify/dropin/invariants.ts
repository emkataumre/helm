// tests/verify/dropin/invariants.ts
// The four M5 drop-in safety invariants — pure predicates over the cross-task DropinRecording. Each
// returns `true` or a human-readable violation string; runDropinInvariants wraps them so a predicate
// that THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and
// complementary to, the untouched M2 (tests/verify/), M3 (tests/verify/snapshot/) and M4
// (tests/verify/scheduler/) slices.
import type { DropinRecording } from "./surface";

export interface DropinInvariant { name: string; holds: (r: DropinRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const DROPIN_INVARIANTS: DropinInvariant[] = [
    // A drop-in on a running task frees the concurrency slot: the running count drops and the waiting
    // queued task starts, with the cap still honoured. This is the whole point — grab a task and the
    // fleet keeps flowing.
    {
        name: "drop-in-frees-a-slot",
        holds: (r) => {
            if (!r.slotFreedOnDropIn) return "drop-in did not free a slot (the waiting task never started)";
            for (const pid of Object.keys(r.maxRunningPerProject)) {
                if (r.maxRunningPerProject[pid] > r.cap) return `project ${pid}: maxRunning ${r.maxRunningPerProject[pid]} > cap ${r.cap}`;
            }
            return true;
        },
    },
    // handed-off is an EXPLICIT pause: the scheduler never auto-starts a handed-off task (its listQueued
    // filters status === "queued"). Resume must flip to queued BEFORE kicking.
    {
        name: "handed-off-is-an-explicit-pause-state",
        holds: (r) => !r.handedOffEverStarted || "a handed-off task was auto-started by the scheduler",
    },
    // No work lost: commitAll runs at the drop-in entry boundary (checkpoint the killed session) AND
    // before the merge/resume on every handback (capture the human's edits).
    {
        name: "commit-before-handback",
        holds: (r) => (r.commitAtEntryBoundary && r.everyHandbackPrecededByCommit) ||
            `commit missing (entryBoundary=${r.commitAtEntryBoundary}, beforeHandback=${r.everyHandbackPrecededByCommit})`,
    },
    // Worktree lifecycle (spec §12): a task that ends handed-off or needs-human RETAINS its worktree
    // (in use for drop-in); merged/abandoned remove it.
    {
        name: "worktree-retained-while-handed-off/needs-human",
        holds: (r) => (r.handedOffOrNeedsHumanWorktreeRetained && r.mergedOrAbandonedWorktreeRemoved) ||
            `retention violated (retained=${r.handedOffOrNeedsHumanWorktreeRetained}, removedOnMerge=${r.mergedOrAbandonedWorktreeRemoved})`,
    },
];

export function runDropinInvariants(r: DropinRecording): InvariantResult[] {
    return DROPIN_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
