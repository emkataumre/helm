// tests/engine/checkIn.test.ts
import { describe, it, expect } from "vitest";
import { checkInsDue, CHECKIN_INTERVAL_MS } from "../../src/main/engine/checkIn";

describe("checkInsDue", () => {
    it("is none before the first interval elapses", () => {
        expect(checkInsDue(0, 1000)).toBe(0);
        expect(checkInsDue(999, 1000)).toBe(0);
    });

    it("is one exactly at the boundary, then accumulates each interval", () => {
        expect(checkInsDue(1000, 1000)).toBe(1);
        expect(checkInsDue(1999, 1000)).toBe(1);
        expect(checkInsDue(2000, 1000)).toBe(2);
        expect(checkInsDue(3000, 1000)).toBe(3);
    });

    it("defaults to the 60-minute interval", () => {
        expect(CHECKIN_INTERVAL_MS).toBe(60 * 60 * 1000);
        expect(checkInsDue(CHECKIN_INTERVAL_MS - 1)).toBe(0);
        expect(checkInsDue(CHECKIN_INTERVAL_MS)).toBe(1);
        expect(checkInsDue(2 * CHECKIN_INTERVAL_MS)).toBe(2);
    });

    it("guards against a non-positive interval or negative elapsed (no spurious check-ins)", () => {
        expect(checkInsDue(5000, 0)).toBe(0);
        expect(checkInsDue(5000, -10)).toBe(0);
        expect(checkInsDue(-1, 1000)).toBe(0);
    });
});
