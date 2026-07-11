// tests/verify/failures/invariants.ts
// The five M17 failure-ledger invariants — pure predicates over the FailuresRecording. Each returns
// `true` or a human-readable violation string; runFailuresInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL").
import type { FailuresRecording } from "./surface";

export interface FailuresInvariant { name: string; holds: (r: FailuresRecording) => true | string }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const FAILURES_INVARIANTS: FailuresInvariant[] = [
    // Every needs-human write lands exactly one open row — including a write whose caller supplied no
    // structured note, which must land as kind 'unknown' (completeness is structural, not discipline).
    {
        name: "ledger-append-on-every-needs-human",
        holds: (r) => {
            if (r.openRowsAfterWrites !== r.needsHumanWrites) {
                return `${r.needsHumanWrites} needs-human writes but ${r.openRowsAfterWrites} open ledger rows — a failure went unrecorded (or was double-recorded)`;
            }
            if (r.noteLessKind !== "unknown") {
                return `a note-less needs-human write recorded kind ${r.noteLessKind === null ? "NO ROW AT ALL" : `"${r.noteLessKind}"`} — the structural 'unknown' default is broken`;
            }
            return true;
        },
    },
    // The task's terminal outcome stamps EVERY still-open row (merged → resolved, abandoned →
    // abandoned); a mere requeue/resume in between stamps nothing.
    {
        name: "resolution-stamped-on-terminal-success",
        holds: (r) => {
            if (r.merged.open !== 0) return `a merged task left ${r.merged.open} ledger row(s) open — resolution was not stamped`;
            if (r.merged.resolved < 1) return "the merged task has no row stamped 'resolved'";
            if (r.abandoned.open !== 0) return `an abandoned task left ${r.abandoned.open} ledger row(s) open`;
            if (r.abandoned.abandoned !== 2) return `the twice-failed abandoned task has ${r.abandoned.abandoned} 'abandoned' rows, expected 2 (one per needs-human)`;
            if (r.requeueStampedRows !== 0) return `a non-terminal requeue stamped ${r.requeueStampedRows} row(s) — only merged/abandoned may resolve`;
            return true;
        },
    },
    // The kind recorded at each engine site matches the terminal cause there — derived structurally at
    // the source, never parsed from the reason string.
    {
        name: "kind-faithful",
        holds: (r) => {
            if (r.kinds.length === 0) return "no engine sites were exercised";
            for (const k of r.kinds) {
                if (k.recorded !== k.expected) {
                    return `site "${k.site}" recorded kind ${k.recorded === null ? "NONE" : `"${k.recorded}"`}, expected "${k.expected}"`;
                }
            }
            return true;
        },
    },
    // The direct anti-regression of the bug that motivated M17: a task that fails then merges keeps its
    // (now-resolved) ledger row with the original reason, even though the card's failureReason banner
    // was cleared on recovery.
    {
        name: "ledger-survives-recovery",
        holds: (r) => {
            if (r.recovery.taskFailureReason !== null) return `the card banner was not cleared on recovery (failureReason="${r.recovery.taskFailureReason}") — recovery didn't happen, nothing was tested`;
            if (!r.recovery.ledgerReason) return "the ledger row's reason is gone after recovery — the evidence was lost (today's bug, regressed)";
            if (r.recovery.ledgerResolution !== "resolved") return `the recovered task's ledger row is ${r.recovery.ledgerResolution === null ? "still open" : `"${r.recovery.ledgerResolution}"`}, expected 'resolved'`;
            return true;
        },
    },
    // The 9th blessed verb is a pure read: declared in the READ set, answers structurally, mutates no
    // DB state, and fires only its own shared action.
    {
        name: "failures-verb-is-readonly",
        holds: (r) => {
            if (!r.verbInReadSet) return "`failures` is not declared as a READ verb (or leaked into the steer set)";
            if (!r.verbResponded) return "dispatching `failures` did not return { ok: true }";
            if (r.dbChangedByVerb) return "dispatching `failures` CHANGED the DB — the read verb mutated state";
            if (!r.onlyReadActionFired) return "dispatching `failures` fired more than its own shared read action";
            return true;
        },
    },
];

export function runFailuresInvariants(r: FailuresRecording): InvariantResult[] {
    return FAILURES_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
