// src/main/engine/loopConfig.ts
// The loop's termination bounds. M2 holds these as a constant passed into runTaskLoop;
// M3 graduates them to per-project DB-backed config set via the project form.
export interface LoopConfig {
    iterationCap: number;   // max attempts per task (backstop)
    noProgressK: number;    // bail after K consecutive iterations with no new commit
    stallTimeoutMs: number; // kill an iteration whose event stream is silent this long (hang)
    checkTimeoutMs: number; // total timeout for each check / acceptance command
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
    iterationCap: 8,
    noProgressK: 2,
    stallTimeoutMs: 40 * 60 * 1000,
    checkTimeoutMs: 30 * 60 * 1000,
};
