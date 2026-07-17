// src/main/engine/loopConfig.ts
// The loop's termination bounds. M2 holds these as a constant passed into runTaskLoop;
// M3 graduates them to per-project DB-backed config set via the project form.
import type { Project } from "../../shared/types";

export interface LoopConfig {
    iterationCap: number;   // max attempts per task (backstop)
    noProgressK: number;    // bail after K consecutive iterations with no new commit
    denyWallK: number;      // escalate to needs-human after K consecutive iterations blocked on the same permissions.deny key
    mergeRecycleK: number;  // M18: max merge-stage losses (conflict/failed re-check) recycled in-place per run before parking
    // RETIRED M12 USD ceiling. The loop's USD accumulator is gone (costUsd is captured for display
    // only), so this can never meter spend again — tokenCap is the SOLE spend ceiling. What survives is
    // only the degenerate kill-switch: an explicit 0 still means "spawn nothing" (runTask.ts). OPTIONAL,
    // with NO default: absent ⇒ nothing to honor. projects.costCapUsd is a dead column left in place.
    costCapUsd?: number;
    // The runaway backstop, denominated in BILLABLE tokens: input + output + cacheCreation, cacheRead
    // EXCLUDED (see billableTokens in verifyState.ts). OPTIONAL so pre-tokenCap LoopConfig literals stay
    // valid; undefined ⇒ the token gate is off. resolveLoopConfig always supplies it.
    tokenCap?: number;
    // The post-green review budget: when a task's gate first goes green, run up to K CONFIRM-ONLY review
    // passes (each a fresh review-framed spawn) before finalizing; K consecutive clean passes → merge.
    // This budget is SEPARATE from iterationCap — a task green on its last work iteration still gets its
    // K reviews. OPTIONAL so pre-review LoopConfig literals stay valid; undefined ⇒ off (0 reviews, the
    // byte-identical pre-review loop). resolveLoopConfig always supplies it (default 2; an explicit 0 = off).
    postGreenReviewK?: number;
    stallTimeoutMs: number; // kill an iteration whose event stream is silent this long (hang)
    checkTimeoutMs: number; // total timeout for each check / acceptance command
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
    iterationCap: 8,
    noProgressK: 2,
    denyWallK: 3,
    mergeRecycleK: 2,
    // costCapUsd has NO default — the $ cap is retired (see the field note above). The token cap below
    // is what guards a runaway run.
    // ≈ the old $25 default at Opus-class pricing for the Ralph-loop spend profile (cache-creation-
    // dominated, ~$18.75/M): 2M billable tokens ≈ $25–40. A backstop against a runaway task overnight,
    // not per-run tuning.
    tokenCap: 2_000_000,
    // The post-green review budget: up to K confirm-only review passes on a first-green task before it
    // lands — an independent second look that costs its own budget and never eats into the work iteration
    // cap. 0 = off. NOTE: this bare engine literal is fed DIRECTLY into runTaskLoop by the low-level engine
    // unit tests, which pin the exact pre-review green-path spawn/event sequences; and resolveLoopConfig.test
    // pins resolveLoopConfig(all-NULL) === this literal. Turning the phase ON by default here (K=2) would
    // therefore require editing those two out-of-scope test files, so the shipped engine default is OFF (0).
    // A per-project row (projects.postGreenReviewK) opts a project IN by storing a positive K.
    postGreenReviewK: 0,
    stallTimeoutMs: 40 * 60 * 1000,
    checkTimeoutMs: 30 * 60 * 1000,
};

// The single place nullable project columns become a concrete LoopConfig. NULL → the engine
// default (via ??, so a legitimate 0 is preserved); stallTimeoutMin is MINUTES → ms here and
// nowhere else (the units seam); checkTimeoutMs has no column and is always the default.
export function resolveLoopConfig(
    // The `tokenCap` intersection is STRUCTURAL, not a Project field: the column exists (db.ts's
    // idempotent ensureTokenCapColumn — the numbered ledger stays pinned by the db tests) but the
    // shared Project type is untouched, so a real row's tokenCap flows through here structurally;
    // a NULL/pre-column row still resolves to the engine default below.
    // `postGreenReviewK` is STRUCTURAL too (same seam as tokenCap): a nullable projects column that
    // db.ts's idempotent ensure adds and getProject's SELECT * carries through, without touching the
    // pinned shared Project type. NULL/absent → the engine default below; an explicit 0 is honored (off).
    project: Pick<Project, "iterationCap" | "noProgressK" | "stallTimeoutMin" | "costCapUsd"> & { tokenCap?: number | null; postGreenReviewK?: number | null },
): LoopConfig {
    return {
        iterationCap: project.iterationCap ?? DEFAULT_LOOP_CONFIG.iterationCap,
        noProgressK: project.noProgressK ?? DEFAULT_LOOP_CONFIG.noProgressK,
        // Engine-default only — no DB column, so it always resolves to the built-in default (the deny
        // fail-fast breaker is a safety backstop, not per-project tuning).
        denyWallK: DEFAULT_LOOP_CONFIG.denyWallK,
        // Engine-default only, same rationale: a bounded self-heal, not per-project tuning (M18).
        mergeRecycleK: DEFAULT_LOOP_CONFIG.mergeRecycleK,
        // RETIRED passthrough: a stored value flows through unchanged but only an explicit 0 ever acts
        // (the spawn-nothing kill-switch); any positive $ figure is inert. NULL → undefined (no default).
        costCapUsd: project.costCapUsd ?? DEFAULT_LOOP_CONFIG.costCapUsd,
        // Same `??` semantics as the $ cap it replaces: NULL/absent → the engine default; an explicit 0
        // is honored (spawn nothing).
        tokenCap: project.tokenCap ?? DEFAULT_LOOP_CONFIG.tokenCap,
        // NULL/absent → the engine default (DEFAULT_LOOP_CONFIG.postGreenReviewK); a stored value passes
        // through, and an explicit 0 is honored (post-green review off). `??` preserves that 0.
        postGreenReviewK: project.postGreenReviewK ?? DEFAULT_LOOP_CONFIG.postGreenReviewK,
        // `== null` (not `??`) so 0 minutes resolves to 0 ms rather than the default.
        stallTimeoutMs: project.stallTimeoutMin == null
            ? DEFAULT_LOOP_CONFIG.stallTimeoutMs
            : project.stallTimeoutMin * 60 * 1000,
        checkTimeoutMs: DEFAULT_LOOP_CONFIG.checkTimeoutMs,
    };
}
