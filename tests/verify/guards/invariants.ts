// tests/verify/guards/invariants.ts
// The two M12 deny-fail-fast invariants — pure predicates over the flat GuardsRecording. Each returns `true`
// or a human-readable violation string; runGuardInvariants wraps them so a predicate that THROWS becomes a
// failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and complementary to, the
// untouched M2–M11 slices.
import type { GuardsRecording } from "./surface";

export interface GuardInvariant { name: string; holds: (r: GuardsRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// Re-derive, from the recorded per-iteration denials, the 1-based iteration at which SOME key first reaches
// `k` CONSECUTIVE hits (a key absent in an iteration resets its run to zero). -1 if no key ever reaches k.
// This is an INDEPENDENT restatement of the loop's streak rule; the invariants check the loop's ACTUAL
// escalation against it, so a misfire or a miss is caught rather than tautologically confirmed.
export function firstDenyWallIteration(perIter: string[][], k: number): number {
    const streak = new Map<string, number>();
    for (let i = 0; i < perIter.length; i++) {
        const denied = new Set(perIter[i]);
        for (const key of [...streak.keys()]) if (!denied.has(key)) streak.delete(key);
        for (const key of denied) {
            const n = (streak.get(key) ?? 0) + 1;
            streak.set(key, n);
            if (n >= k) return i + 1; // 1-based: the count of iterations run at the moment of escalation
        }
    }
    return -1;
}

export const GUARDS_INVARIANTS: GuardInvariant[] = [
    // A genuine wall escalates EARLY. Once a single denied key reaches denyWallK consecutive hits within the
    // iterations that ran (and the loop didn't already succeed), the loop MUST terminate via the deny-wall
    // reason, at exactly that iteration, strictly before the cap — never thrashing to the cap. (This invariant
    // says nothing about escalations WITHOUT a wall; that false-positive concern is the second invariant's.)
    {
        name: "deny-wall-escalates-early",
        holds: (r) => {
            const firstWall = firstDenyWallIteration(r.perIterationDenied, r.denyWallK);
            // No wall was reached within the run (or the loop merged) → this invariant imposes nothing.
            if (firstWall === -1 || firstWall > r.iterationsRun || r.finalStatus === "merged") return true;
            if (!r.escalatedDenyWall) {
                return `a key reached denyWallK by iteration ${firstWall} (loop ran ${r.iterationsRun}, status ${r.finalStatus}) but the deny wall never escalated`;
            }
            if (r.iterationsRun !== firstWall) {
                return `deny wall was first reached at iteration ${firstWall} but escalation fired at ${r.iterationsRun}`;
            }
            if (r.iterationsRun >= r.iterationCap) {
                return `deny-wall escalation only fired at the iteration cap (${r.iterationCap}) instead of firing early`;
            }
            return true;
        },
    },
    // A deny that STOPS repeating (the agent adapted) must NEVER produce a deny-wall escalation: an escalation
    // is legitimate ONLY when some key genuinely reached denyWallK consecutive hits.
    {
        name: "recoverable-deny-not-escalated",
        holds: (r) => {
            if (!r.escalatedDenyWall) return true; // no escalation → nothing to justify
            const firstWall = firstDenyWallIteration(r.perIterationDenied, r.denyWallK);
            if (firstWall === -1) return "escalated a deny wall although no key ever repeated to denyWallK consecutive iterations (the deny was recoverable)";
            return true;
        },
    },
];

export function runGuardInvariants(r: GuardsRecording): InvariantResult[] {
    return GUARDS_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
