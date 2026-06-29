// tests/engine/resolveLoopConfig.test.ts
import { describe, it, expect } from "vitest";
import { resolveLoopConfig, DEFAULT_LOOP_CONFIG } from "../../src/main/engine/loopConfig";

// The three bound project columns resolveLoopConfig reads; NULL everywhere by default.
const cfg = (over: Partial<{ iterationCap: number | null; noProgressK: number | null; stallTimeoutMin: number | null }> = {}) =>
    ({ iterationCap: null, noProgressK: null, stallTimeoutMin: null, ...over });

describe("resolveLoopConfig", () => {
    it("all-NULL config resolves to exactly DEFAULT_LOOP_CONFIG", () => {
        expect(resolveLoopConfig(cfg())).toEqual(DEFAULT_LOOP_CONFIG);
    });

    it("merges populated bounds, converting stallTimeoutMin minutes → ms (the units seam)", () => {
        const r = resolveLoopConfig(cfg({ iterationCap: 12, noProgressK: 4, stallTimeoutMin: 10 }));
        expect(r.iterationCap).toBe(12);
        expect(r.noProgressK).toBe(4);
        expect(r.stallTimeoutMs).toBe(10 * 60 * 1000);
    });

    it("never overrides checkTimeoutMs — it has no project column", () => {
        const r = resolveLoopConfig(cfg({ iterationCap: 1, noProgressK: 1, stallTimeoutMin: 1 }));
        expect(r.checkTimeoutMs).toBe(DEFAULT_LOOP_CONFIG.checkTimeoutMs);
    });

    it("preserves a legitimate 0 (iterationCap: 0 stays 0, not the default)", () => {
        expect(resolveLoopConfig(cfg({ iterationCap: 0 })).iterationCap).toBe(0);
        expect(resolveLoopConfig(cfg({ stallTimeoutMin: 0 })).stallTimeoutMs).toBe(0);
    });
});
