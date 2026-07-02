// tests/verify/promote/invariants.ts
// The three M6-③ Promote safety invariants — pure predicates over the flat PromoteRecording. Each returns
// `true` or a human-readable violation string; runPromoteInvariants wraps them so a predicate that THROWS
// becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and complementary to,
// the untouched M2–M6-② slices.
import type { PromoteRecording } from "./surface";

export interface PromoteInvariant { name: string; holds: (r: PromoteRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// A ref "touches the target" if it IS the target branch, in either bare or refs/heads/ form.
const touchesTarget = (ref: string | undefined, target: string): boolean =>
    ref === target || ref === `refs/heads/${target}`;

export const PROMOTE_INVARIANTS: PromoteInvariant[] = [
    // THE safety property (spec §13, reframed for one-click): the tool advances the target ONLY to a commit
    // it just re-validated, and ONLY in `direct` mode. So every push that touches the target ref must be a
    // `direct`-mode push of EXACTLY the validated sha — never a branch, never a different sha, and never at
    // all in `pr`/`strict`. (The agent loop can't push the target regardless — that's the CLI-layer belt.)
    {
        name: "target-advance-is-validated",
        holds: (r) => {
            for (const p of r.pushes) {
                const hitsTarget = touchesTarget(p.localRef, r.targetBranch) || touchesTarget(p.remoteRef, r.targetBranch);
                if (!hitsTarget) continue;
                if (r.mode !== "direct") return `the target was pushed in ${r.mode} mode (only direct may advance it): ${p.localRef} → ${p.remoteRef}`;
                if (p.localRef !== r.validatedSha) return `the target was advanced to a NON-validated ref: ${p.localRef} (expected the re-checked sha ${r.validatedSha})`;
                if (p.remoteRef !== `refs/heads/${r.targetBranch}`) return `target advance used an unexpected remote ref: ${p.remoteRef}`;
            }
            return true;
        },
    },
    // A `ready` graduation (a validated sha the human's push advances the target to) may ONLY appear when
    // BOTH gates went green on the fresh tip. A red gate must yield recheck-failed with no sha — the
    // re-check is the whole point, so it can't be theatre.
    {
        name: "promote-recheck-before-ready",
        holds: (r) => {
            if (r.outcome === "ready") {
                if (r.validatedSha == null) return "ready outcome carries no validated sha";
                if (!r.checkGreen) return "ready despite a RED check re-check (the gate was skipped)";
                if (!r.acceptanceGreen) return "ready despite a RED acceptance re-check (the gate was skipped)";
            }
            // …and no validated sha may leak on any non-ready outcome.
            if (r.outcome !== "ready" && r.validatedSha != null) return `non-ready outcome (${r.outcome}) leaked a validated sha`;
            return true;
        },
    },
    // Nothing beyond the target ⇒ nothing-to-promote, detected BEFORE any worktree is built (no throwaway
    // worktree churn, and certainly no push). createWorktree must be uncalled.
    {
        name: "nothing-to-promote-detected",
        holds: (r) => {
            if (r.beyond === 0) {
                if (r.outcome !== "nothing-to-promote") return `0 commits beyond the target but outcome was ${r.outcome}`;
                if (r.worktreeCreated) return "built a throwaway worktree despite there being nothing to promote";
            }
            return true;
        },
    },
];

export function runPromoteInvariants(r: PromoteRecording): InvariantResult[] {
    return PROMOTE_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
