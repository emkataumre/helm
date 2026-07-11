// tests/verify/feedback/invariants.ts
// The five M18 failure-feedback invariants — pure predicates over the FeedbackRecording. Each returns
// `true` or a human-readable violation string; runFeedbackInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL").
import type { FeedbackRecording } from "./surface";

export interface FeedbackInvariant { name: string; holds: (r: FeedbackRecording) => true | string }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const FEEDBACK_INVARIANTS: FeedbackInvariant[] = [
    // A recyclable merge loss (conflict / failed re-check) with budget left continues the loop — no
    // needs-human write — and the retry prompt carries BOTH the cause and the merge-demonstrating
    // /goal condition extension (a lazy agent's gates still pass locally: the no-op trap).
    {
        name: "merge-loss-recycles-not-parks",
        holds: (r) => {
            if (r.conflict.finalStatus !== "merged") return `a recyclable conflict loss ended "${r.conflict.finalStatus}" — the loop parked instead of recycling to the merge`;
            if (r.conflict.needsHumanWrites !== 0) return `the recycled loss wrote needs-human ${r.conflict.needsHumanWrites} time(s) — a recycle must never park the card`;
            if (r.conflict.spawnPrompts < 2) return `only ${r.conflict.spawnPrompts} spawn(s) — the loop never retried in-place`;
            if (!r.conflict.retryPromptHasCause) return "the retry prompt does not carry the merge-loss cause — the agent retries blind";
            if (!r.conflict.retryPromptDemandsMerge) return "the retry /goal condition does not demand the integration merge — the no-op trap is open";
            return true;
        },
    },
    // Loss #mergeRecycleK+1 parks at needs-human with the REAL kind and reason — the recycle is a
    // bounded self-heal, not an infinite retry.
    {
        name: "recycle-bounded",
        holds: (r) => {
            if (r.bounded.finalStatus !== "needs-human") return `a permanently-losing merge ended "${r.bounded.finalStatus}" — the bound never parked it`;
            if (r.bounded.mergeAttempts !== r.bounded.recycleK + 1) return `${r.bounded.mergeAttempts} merge attempts with mergeRecycleK=${r.bounded.recycleK} — expected exactly ${r.bounded.recycleK + 1} (K recycles + the parking loss)`;
            if (r.bounded.parkedKind !== "merge-conflict") return `the bound parked with kind ${r.bounded.parkedKind === null ? "NONE" : `"${r.bounded.parkedKind}"`} — the real merge cause was lost`;
            if (!r.bounded.parkedReason?.includes("merge conflict")) return `the parked reason "${r.bounded.parkedReason}" does not name the real merge cause`;
            return true;
        },
    },
    // A merge-SETUP loss (a config fault the agent can't fix) parks on the FIRST loss, zero recycles.
    {
        name: "non-recyclable-kinds-still-park",
        holds: (r) => {
            if (r.nonRecyclable.finalStatus !== "needs-human") return `a merge-setup loss ended "${r.nonRecyclable.finalStatus}" instead of parking`;
            if (r.nonRecyclable.mergeAttempts !== 1) return `${r.nonRecyclable.mergeAttempts} merge attempts for a config fault — it must park on loss #1`;
            if (r.nonRecyclable.recycles !== 0) return `${r.nonRecyclable.recycles} recycle(s) recorded for a non-recyclable kind`;
            return true;
        },
    },
    // Every recycle lands exactly one kind-faithful ledger row pre-stamped 'recycled' — M17's
    // observability survives the self-heal, and nothing recycled ever reads as open/waiting-on-a-human.
    {
        name: "recycled-losses-still-ledgered",
        holds: (r) => {
            if (r.ledger.finalStatus !== "merged") return `the ledger drive ended "${r.ledger.finalStatus}" — the recycle path wasn't exercised, nothing was tested`;
            if (r.ledger.recycledRows < 1) return "a recycled loss landed NO ledger row — the fleet-health data silently vanished (the M17 regression)";
            if (!r.ledger.recycledKinds.every((k) => k === "merge-conflict" || k === "recheck-failed")) return `a recycled row carries a non-recyclable kind (${r.ledger.recycledKinds.join(", ")})`;
            if (!r.ledger.resolutions.every((x) => x === "recycled")) return `a recycle row's resolution is ${JSON.stringify(r.ledger.resolutions)} — every recycle row must land pre-stamped 'recycled'`;
            if (r.ledger.openRowsAfterMerge !== 0) return `${r.ledger.openRowsAfterMerge} open row(s) after the merge — a recycle must never read as waiting-on-a-human`;
            return true;
        },
    },
    // A resumed run whose task carries a parked failureReason gets it in the FIRST prompt (parked
    // framing); a clean resume (no reason) seeds nothing.
    {
        name: "resume-carries-parked-cause",
        holds: (r) => {
            if (!r.resume.parkedPromptHasCause) return "a resumed run's first prompt does not carry the parked reason — the agent resumes blind";
            if (r.resume.cleanPromptSeeded) return "a CLEAN resume was seeded with a parked framing — there was nothing to report";
            return true;
        },
    },
];

export function runFeedbackInvariants(r: FeedbackRecording): InvariantResult[] {
    return FEEDBACK_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
