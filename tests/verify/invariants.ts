// tests/verify/invariants.ts
// Named predicates that must hold whenever runTaskLoop has run. They read the Snapshot only —
// never engine internals — so they describe durable behavioural truths and survive refactors.
// "When in doubt, FAIL": runInvariants wraps each predicate so a verifier that THROWS becomes a
// failed check with the error as evidence, never a silent pass.
import type { Snapshot } from "./surface";

export interface Invariant { name: string; holds: (s: Snapshot) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string; }

export const INVARIANTS: Invariant[] = [
    { name: "terminal-status", holds: (s) => s.finalStatus === "merged" || s.finalStatus === "needs-human" ? true : `finalStatus=${s.finalStatus} is not terminal` },
    { name: "no-merge-on-red", holds: (s) => s.mergedWithoutGreenGate === false ? true : "a squash-merge landed without agent-ok && check-green && acceptance-green" },
    { name: "acceptance-gate-mandatory", holds: (s) => !s.squashMergeApplied || s.acceptanceRanGreenBeforeMerge ? true : "merged without a green Layer-B acceptance gate" },
    { name: "iteration-cap-respected", holds: (s) => s.capRespected ? true : `iterationsRun=${s.iterationsRun} exceeds cap=${s.config.iterationCap}` },
    { name: "at-most-one-merge", holds: (s) => s.mergeApplications <= 1 ? true : `${s.mergeApplications} merges applied (loop must stop at the first green)` },
    { name: "merged-cleanup", holds: (s) => s.finalStatus !== "merged" || (s.squashMergeApplied && s.worktreeRemoved && !s.branchKept && s.diffstatRecorded) ? true : `merged but cleanup incomplete (merge=${s.squashMergeApplied}, wtRemoved=${s.worktreeRemoved}, branchKept=${s.branchKept}, diffstat=${s.diffstatRecorded})` },
    // M5 worktree lifecycle (spec §12): a needs-human task RETAINS its worktree (it's in use for drop-in),
    // so the durable truth is now "reason set, worktree NOT removed, no merge" — the pre-M5 "removed,
    // branch kept" was an interim deviation the M5 retention change corrects. (See the M5 dropin slice's
    // worktree-retained-while-handed-off/needs-human invariant for the same truth, cross-task.)
    { name: "needs-human-evidence", holds: (s) => s.finalStatus !== "needs-human" || (s.failureReasonSet && !s.worktreeRemoved && !s.squashMergeApplied) ? true : `needs-human but evidence incomplete (reason=${s.failureReasonSet}, wtRetained=${!s.worktreeRemoved}, merge=${s.squashMergeApplied})` },
    { name: "iteration-accounting", holds: (s) => s.iterationsRun === s.iterationsFinished ? true : `iterationsRun=${s.iterationsRun} != iterationsFinished=${s.iterationsFinished}` },
    { name: "session-id-per-iteration", holds: (s) => s.sessionIdsCaptured ? true : "an iteration ran without capturing a session id" },
];

export function runInvariants(snapshot: Snapshot): InvariantResult[] {
    return INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(snapshot);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
