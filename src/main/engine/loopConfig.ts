// src/main/engine/loopConfig.ts
// The loop's termination bounds. M2 holds these as a constant passed into runTaskLoop;
// M3 graduates them to per-project DB-backed config set via the project form.
import type { Project } from "../../shared/types";

export interface LoopConfig {
    iterationCap: number;   // max attempts per task (backstop)
    noProgressK: number;    // bail after K consecutive iterations with no new commit
    denyWallK: number;      // escalate to needs-human after K consecutive iterations blocked on the same permissions.deny key
    mergeRecycleK: number;  // M18: max merge-stage losses (conflict/failed re-check) recycled in-place per run before parking
    // LEGACY M12 USD ceiling. Superseded by tokenCap as the production runaway backstop (the dollars were
    // synthetic — derived from tokens anyway). Kept as a field because the projects.costCapUsd column and
    // the M12 cost-cap verify slice still exercise it; the DEFAULT is now Infinity, so the $ gate only
    // fires for a project that explicitly configures a cap.
    costCapUsd: number;
    // The runaway backstop, denominated in BILLABLE tokens: input + output + cacheCreation, cacheRead
    // EXCLUDED (see billableTokens in verifyState.ts). OPTIONAL so pre-tokenCap LoopConfig literals stay
    // valid; undefined ⇒ the token gate is off. resolveLoopConfig always supplies it.
    tokenCap?: number;
    stallTimeoutMs: number; // kill an iteration whose event stream is silent this long (hang)
    checkTimeoutMs: number; // total timeout for each check / acceptance command
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
    iterationCap: 8,
    noProgressK: 2,
    denyWallK: 3,
    mergeRecycleK: 2,
    // The $ cap is retired as the default backstop — Infinity means the $ gate never fires unless a
    // project explicitly sets projects.costCapUsd. The token cap below is what guards a runaway run.
    costCapUsd: Number.POSITIVE_INFINITY,
    // ≈ the old $25 default at Opus-class pricing for the Ralph-loop spend profile (cache-creation-
    // dominated, ~$18.75/M): 2M billable tokens ≈ $25–40. A backstop against a runaway task overnight,
    // not per-run tuning.
    tokenCap: 2_000_000,
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
    project: Pick<Project, "iterationCap" | "noProgressK" | "stallTimeoutMin" | "costCapUsd"> & { tokenCap?: number | null },
): LoopConfig {
    return {
        iterationCap: project.iterationCap ?? DEFAULT_LOOP_CONFIG.iterationCap,
        noProgressK: project.noProgressK ?? DEFAULT_LOOP_CONFIG.noProgressK,
        // Engine-default only — no DB column, so it always resolves to the built-in default (the deny
        // fail-fast breaker is a safety backstop, not per-project tuning).
        denyWallK: DEFAULT_LOOP_CONFIG.denyWallK,
        // Engine-default only, same rationale: a bounded self-heal, not per-project tuning (M18).
        mergeRecycleK: DEFAULT_LOOP_CONFIG.mergeRecycleK,
        // `??`, not `== null`: NULL → the engine default (now Infinity — the $ gate is legacy, off unless
        // explicitly configured), but an explicit 0 is HONORED (spend nothing — the cap is reached before
        // the first spawn, so a 0-cap project spawns nothing at all).
        costCapUsd: project.costCapUsd ?? DEFAULT_LOOP_CONFIG.costCapUsd,
        // Same `??` semantics as the $ cap it replaces: NULL/absent → the engine default; an explicit 0
        // is honored (spawn nothing).
        tokenCap: project.tokenCap ?? DEFAULT_LOOP_CONFIG.tokenCap,
        // `== null` (not `??`) so 0 minutes resolves to 0 ms rather than the default.
        stallTimeoutMs: project.stallTimeoutMin == null
            ? DEFAULT_LOOP_CONFIG.stallTimeoutMs
            : project.stallTimeoutMin * 60 * 1000,
        checkTimeoutMs: DEFAULT_LOOP_CONFIG.checkTimeoutMs,
    };
}
