// tests/verify/snapshot/invariants.ts
// The M3 verify slice's invariants — pure predicates over the REAL EngineSnapshot (the same object
// the cockpit reads), so the verifier asserts on production truth, not a parallel shadow. Each
// predicate returns `true` or a human-readable violation string; runSnapshotInvariants wraps them
// so a predicate that THROWS becomes a failed check (never a silent pass — "when in doubt, FAIL").
// Distinct from, and complementary to, the untouched M2 loop-safety slice in tests/verify/.
import type { EngineSnapshot, TokenTotals } from "../../../src/shared/types";

export interface SnapshotInvariant { name: string; holds: (s: EngineSnapshot) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

const TOKEN_KEYS: Array<keyof TokenTotals> = ["input", "output", "cacheRead", "cacheCreation", "costUsd"];
const EPS = 1e-9;

function sumSeries(series: TokenTotals[]): TokenTotals {
    const t: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
    for (const x of series) for (const k of TOKEN_KEYS) t[k] += x[k];
    return t;
}

export const SNAPSHOT_INVARIANTS: SnapshotInvariant[] = [
    // The verify surface IS the snapshot: it must be a self-identifying, machine-readable object.
    {
        name: "surface-present",
        holds: (s) =>
            (typeof s.taskId === "string" && s.taskId.length > 0
                && Array.isArray(s.iterations) && Array.isArray(s.feed)
                && s.totals != null && typeof s.totals === "object")
                ? true
                : "snapshot is not a self-identifying machine-readable surface (missing taskId / iterations / feed / totals)",
    },
    // Tokens never go negative (so the cumulative series never decreases), AND the displayed totals
    // reconcile with the sum of the per-iteration series — totals can't drift from what it summarizes.
    {
        name: "token-accounting-monotonic",
        holds: (s) => {
            for (const it of s.iterations) {
                for (const k of TOKEN_KEYS) {
                    if (it.tokens[k] < 0) return `iteration ${it.index} has negative ${k}=${it.tokens[k]}`;
                }
            }
            const sum = sumSeries(s.iterations.map((i) => i.tokens));
            for (const k of TOKEN_KEYS) {
                if (Math.abs(s.totals[k] - sum[k]) > EPS) return `totals.${k}=${s.totals[k]} != sum of series ${sum[k]}`;
            }
            return true;
        },
    },
    // The feed never fabricates entries: it can't be longer than the count of events that fed it,
    // and every entry must reference an iteration that actually exists.
    {
        name: "activity-feed-matches-events",
        holds: (s) => {
            if (s.feed.length > s.feedEventsConsumed) {
                return `feed.length ${s.feed.length} > feedEventsConsumed ${s.feedEventsConsumed} (fabricated entries)`;
            }
            const known = new Set(s.iterations.map((i) => i.index));
            for (const e of s.feed) {
                if (!known.has(e.iterationIndex)) return `feed entry references unknown iteration ${e.iterationIndex}`;
            }
            return true;
        },
    },
];

export function runSnapshotInvariants(s: EngineSnapshot): InvariantResult[] {
    return SNAPSHOT_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(s);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
