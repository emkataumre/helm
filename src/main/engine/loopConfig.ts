// src/main/engine/loopConfig.ts
// The loop's termination bounds. M2 holds these as a constant passed into runTaskLoop;
// M3 graduates them to per-project DB-backed config set via the project form.
import type { Project } from "../../shared/types";

export interface LoopConfig {
    iterationCap: number;   // max attempts per task (backstop)
    noProgressK: number;    // bail after K consecutive iterations with no new commit
    denyWallK: number;      // escalate to needs-human after K consecutive iterations blocked on the same permissions.deny key
    mergeRecycleK: number;  // M18: max merge-stage losses (conflict/failed re-check) recycled in-place per run before parking
    costCapUsd: number;     // M12 USD spend ceiling for the whole run; stop spawning once accumulated cost reaches it
    stallTimeoutMs: number; // kill an iteration whose event stream is silent this long (hang)
    checkTimeoutMs: number; // total timeout for each check / acceptance command
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
    iterationCap: 8,
    noProgressK: 2,
    denyWallK: 3,
    mergeRecycleK: 2,
    costCapUsd: 25,
    stallTimeoutMs: 40 * 60 * 1000,
    checkTimeoutMs: 30 * 60 * 1000,
};

// The single place nullable project columns become a concrete LoopConfig. NULL → the engine
// default (via ??, so a legitimate 0 is preserved); stallTimeoutMin is MINUTES → ms here and
// nowhere else (the units seam); checkTimeoutMs has no column and is always the default.
export function resolveLoopConfig(
    project: Pick<Project, "iterationCap" | "noProgressK" | "stallTimeoutMin" | "costCapUsd">,
): LoopConfig {
    return {
        iterationCap: project.iterationCap ?? DEFAULT_LOOP_CONFIG.iterationCap,
        noProgressK: project.noProgressK ?? DEFAULT_LOOP_CONFIG.noProgressK,
        // Engine-default only — no DB column, so it always resolves to the built-in default (the deny
        // fail-fast breaker is a safety backstop, not per-project tuning).
        denyWallK: DEFAULT_LOOP_CONFIG.denyWallK,
        // Engine-default only, same rationale: a bounded self-heal, not per-project tuning (M18).
        mergeRecycleK: DEFAULT_LOOP_CONFIG.mergeRecycleK,
        // `??`, not `== null`: NULL → the engine default 25, but an explicit 0 is HONORED (spend nothing —
        // the cap is reached before the first spawn, so a 0-cap project spawns nothing at all).
        costCapUsd: project.costCapUsd ?? DEFAULT_LOOP_CONFIG.costCapUsd,
        // `== null` (not `??`) so 0 minutes resolves to 0 ms rather than the default.
        stallTimeoutMs: project.stallTimeoutMin == null
            ? DEFAULT_LOOP_CONFIG.stallTimeoutMs
            : project.stallTimeoutMin * 60 * 1000,
        checkTimeoutMs: DEFAULT_LOOP_CONFIG.checkTimeoutMs,
    };
}
