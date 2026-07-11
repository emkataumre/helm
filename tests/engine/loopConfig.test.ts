// tests/engine/loopConfig.test.ts
import { describe, it, expect } from "vitest";
import { DEFAULT_LOOP_CONFIG } from "../../src/main/engine/loopConfig";

describe("DEFAULT_LOOP_CONFIG", () => {
    it("encodes the spec's M2 bounds", () => {
        expect(DEFAULT_LOOP_CONFIG.iterationCap).toBe(8);
        expect(DEFAULT_LOOP_CONFIG.noProgressK).toBe(2);
        expect(DEFAULT_LOOP_CONFIG.stallTimeoutMs).toBe(40 * 60 * 1000);
        expect(DEFAULT_LOOP_CONFIG.checkTimeoutMs).toBe(30 * 60 * 1000);
    });

    it("encodes the M18 merge-recycle bound", () => {
        expect(DEFAULT_LOOP_CONFIG.mergeRecycleK).toBe(2);
    });
});
