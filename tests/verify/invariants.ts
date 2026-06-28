// tests/verify/invariants.ts
// The INVARIANTS for the runTaskSinglePass unit: named predicates that must hold whenever
// the unit has run. They read the machine-readable Snapshot only — never engine internals —
// so they describe durable behavioral truths (the gate is honored, terminal states clean up
// after themselves) and survive refactors of runTask.ts.
//
// "When in doubt, FAIL" (~/.claude/verification.md): runInvariants wraps each predicate in
// try/catch so a verifier that THROWS becomes a failed check with the error as evidence —
// never swallowed into a false pass.
import type { Snapshot } from "./surface";

// A predicate returns true when it holds, or a human-readable string explaining the violation.
export interface Invariant {
    name: string;
    holds: (s: Snapshot) => true | string;
}

export interface InvariantResult {
    name: string;
    ok: boolean;
    detail?: string;
}

export const INVARIANTS: Invariant[] = [
    {
        name: "terminal-status",
        // A single pass always lands in one of the two terminal states — never mid-flight.
        holds: (s) =>
            s.finalStatus === "merged" || s.finalStatus === "needs-human"
                ? true
                : `finalStatus=${s.finalStatus} is not terminal`,
    },
    {
        name: "no-merge-on-red",
        // The load-bearing safety property: code only lands behind a green gate.
        holds: (s) =>
            s.mergedWithoutGreenGate === false
                ? true
                : "a squash-merge landed without agent-ok && check-green",
    },
    {
        name: "merged-cleanup",
        // A merged task tore down its worktree, deleted its branch, and recorded a diffstat.
        holds: (s) =>
            s.finalStatus !== "merged" ||
            (s.squashMergeApplied && s.worktreeRemoved && !s.branchKept && s.diffstatRecorded)
                ? true
                : `merged but cleanup incomplete (squashMergeApplied=${s.squashMergeApplied}, worktreeRemoved=${s.worktreeRemoved}, branchKept=${s.branchKept}, diffstatRecorded=${s.diffstatRecorded})`,
    },
    {
        name: "needs-human-evidence",
        // A handed-off task left evidence: a reason, the worktree gone but the branch kept,
        // and crucially no merge.
        holds: (s) =>
            s.finalStatus !== "needs-human" ||
            (s.failureReasonSet && s.worktreeRemoved && s.branchKept && !s.squashMergeApplied)
                ? true
                : `needs-human but evidence incomplete (failureReasonSet=${s.failureReasonSet}, worktreeRemoved=${s.worktreeRemoved}, branchKept=${s.branchKept}, squashMergeApplied=${s.squashMergeApplied})`,
    },
    {
        name: "one-finished-iteration",
        // Exactly one iteration opened and exactly one closed with a verdict — no orphans.
        holds: (s) =>
            s.iterationsAdded === 1 && s.iterationsFinished === 1
                ? true
                : `iterationsAdded=${s.iterationsAdded}, iterationsFinished=${s.iterationsFinished} (expected 1 and 1)`,
    },
];

// Run every invariant against a snapshot. A predicate that throws is reported as a failed
// check with the error message as detail — the harness must be able to catch a lie, including
// one that crashes the checker.
export function runInvariants(snapshot: Snapshot): InvariantResult[] {
    return INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(snapshot);
            return verdict === true
                ? { name: inv.name, ok: true }
                : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
