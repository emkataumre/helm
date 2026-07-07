// tests/verify/guards/trayCounts.test.ts
// The M12 tray-counts verify slice. Drives the REAL pure functions — deriveTrayCounts + formatTrayTooltip
// from src/main/engine/trayCounts.ts — across fixtures (a mixed board, an empty board, an all-terminal
// board) and asserts each fixture's CLAIMED counts/tooltip match what the real functions actually produce.
// A deliberately-wrong PROBE (a lying fixture whose claimed tooltip contradicts its board's true counts)
// MUST FAIL: it proves the harness catches a lie, not just confirms truths. Verdict vocabulary from
// ~/.claude/verification.md. Self-contained in this one file — a sibling task owns the rest of guards/.
import { describe, it, expect } from "vitest";
import { deriveTrayCounts, formatTrayTooltip, type TrayCountable, type TrayCounts } from "../../../src/main/engine/trayCounts";
import type { TaskStatus } from "../../../src/shared/types";

const task = (status: TaskStatus): TrayCountable => ({ status });

// A fixture is a named board plus the counts + tooltip it CLAIMS are true. A probe deliberately lies (its
// claim disagrees with the board's real counts), so the harness must catch it → its verdict MUST be FAIL.
interface Fixture {
    id: string;
    board: TrayCountable[];
    claimedCounts: TrayCounts;
    claimedTooltip: string;
    probe?: boolean;
}

const FIXTURES: Fixture[] = [
    {
        // Mixed board: 2 running, 1 needs-human, 5 merged, plus queued/handed-off/abandoned that must NOT
        // be surfaced (proves the fold ignores every non-reported status).
        id: "mixed",
        board: [
            task("running"), task("running"),
            task("needs-human"),
            task("merged"), task("merged"), task("merged"), task("merged"), task("merged"),
            task("queued"), task("handed-off"), task("abandoned"),
        ],
        claimedCounts: { running: 2, needsHuman: 1, merged: 5 },
        claimedTooltip: "Helm — 2 running · 1 needs-human · 5 merged",
    },
    {
        // Empty board: the zero state must render cleanly (no crash, all zeros).
        id: "empty",
        board: [],
        claimedCounts: { running: 0, needsHuman: 0, merged: 0 },
        claimedTooltip: "Helm — 0 running · 0 needs-human · 0 merged",
    },
    {
        // All-terminal board: every task has settled (merged / needs-human / abandoned) — nothing running.
        // Proves running=0 while merged/needs-human still count, and abandoned is excluded.
        id: "all-terminal",
        board: [
            task("merged"), task("merged"), task("merged"),
            task("needs-human"), task("needs-human"),
            task("abandoned"), task("abandoned"),
        ],
        claimedCounts: { running: 0, needsHuman: 2, merged: 3 },
        claimedTooltip: "Helm — 0 running · 2 needs-human · 3 merged",
    },
    {
        // PROBE (deliberately wrong): the board truly has 1 running / 0 needs-human / 1 merged, but the
        // claim LIES that it's "3 running". A harness that trusted the claim would pass this; ours must FAIL.
        id: "lying-tooltip",
        probe: true,
        board: [task("running"), task("merged")],
        claimedCounts: { running: 3, needsHuman: 0, merged: 1 },
        claimedTooltip: "Helm — 3 running · 0 needs-human · 1 merged",
    },
];

type Verdict = "PASS" | "FAIL";

// Run one fixture against the REAL functions: PASS iff the claimed counts AND claimed tooltip both match
// what deriveTrayCounts/formatTrayTooltip actually produce for the board; FAIL otherwise. "When in doubt,
// FAIL" — a lying probe lands here as FAIL by construction.
function runFixture(f: Fixture): { verdict: Verdict; counts: TrayCounts; tooltip: string } {
    const counts = deriveTrayCounts(f.board);
    const tooltip = formatTrayTooltip(counts);
    const countsMatch =
        counts.running === f.claimedCounts.running &&
        counts.needsHuman === f.claimedCounts.needsHuman &&
        counts.merged === f.claimedCounts.merged;
    const verdict: Verdict = countsMatch && tooltip === f.claimedTooltip ? "PASS" : "FAIL";
    return { verdict, counts, tooltip };
}

describe("verify/guards/trayCounts: the CI matrix over every fixture", () => {
    it.each(FIXTURES.filter((f) => !f.probe).map((f) => [f.id, f] as const))(
        "honest fixture %s → PASS (real functions match the claim)",
        (_id, fixture) => {
            expect<Verdict>(runFixture(fixture).verdict).toBe("PASS");
        },
    );

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it.each(FIXTURES.filter((f) => f.probe).map((f) => [f.id, f] as const))(
        "probe %s → MUST FAIL (the harness catches the lie)",
        (_id, fixture) => {
            expect<Verdict>(runFixture(fixture).verdict).toBe("FAIL");
        },
    );
});

describe("verify/guards/trayCounts: deriveTrayCounts folds the board correctly", () => {
    it("counts only running / needs-human / merged; ignores queued, handed-off, abandoned", () => {
        const counts = deriveTrayCounts([
            task("running"), task("running"),
            task("needs-human"),
            task("merged"), task("merged"), task("merged"), task("merged"), task("merged"),
            task("queued"), task("handed-off"), task("abandoned"),
        ]);
        expect(counts).toEqual({ running: 2, needsHuman: 1, merged: 5 });
    });

    it("an empty board is all zeros", () => {
        expect(deriveTrayCounts([])).toEqual({ running: 0, needsHuman: 0, merged: 0 });
    });

    it("does not miscount when only non-reported statuses are present", () => {
        expect(deriveTrayCounts([task("queued"), task("handed-off"), task("abandoned")])).toEqual({
            running: 0, needsHuman: 0, merged: 0,
        });
    });
});

describe("verify/guards/trayCounts: formatTrayTooltip renders the stable one-line shape", () => {
    it("renders 'Helm — R running · N needs-human · M merged'", () => {
        expect(formatTrayTooltip({ running: 2, needsHuman: 1, merged: 5 })).toBe(
            "Helm — 2 running · 1 needs-human · 5 merged",
        );
    });

    it("is a pure fn of its counts (zeros render literally, no pluralization tricks)", () => {
        expect(formatTrayTooltip({ running: 0, needsHuman: 0, merged: 0 })).toBe(
            "Helm — 0 running · 0 needs-human · 0 merged",
        );
    });

    it("round-trips derive → format for the mixed board", () => {
        const board = [task("running"), task("needs-human"), task("merged"), task("queued")];
        expect(formatTrayTooltip(deriveTrayCounts(board))).toBe("Helm — 1 running · 1 needs-human · 1 merged");
    });
});

describe("verify/guards/trayCounts: the lying probe is genuinely wrong (not a coincidental match)", () => {
    it("the probe's real output disagrees with its claimed tooltip", () => {
        const probe = FIXTURES.find((f) => f.id === "lying-tooltip")!;
        const { tooltip } = runFixture(probe);
        expect(tooltip).not.toBe(probe.claimedTooltip);
        expect(tooltip).toBe("Helm — 1 running · 0 needs-human · 1 merged");
    });
});
