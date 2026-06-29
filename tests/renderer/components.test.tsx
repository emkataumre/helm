// tests/renderer/components.test.tsx
// The M3 renderer verify slice. The presentational components are pure and prop-driven, so we drive
// them with fixture snapshots and read the data-verify-* contract straight out of the static markup
// (react-dom/server — no jsdom). The probe: a displayed total that disagrees with the sum of
// iterations MUST surface data-verify-consistent="false".
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { verifyAttrs } from "../../src/renderer/components/verifyAttrs";
import { TokenReadout } from "../../src/renderer/components/TokenReadout";
import { ActivityFeed } from "../../src/renderer/components/ActivityFeed";
import { IterationHistory } from "../../src/renderer/components/IterationHistory";
import { ProgressPanel } from "../../src/renderer/components/ProgressPanel";
import { BoardCard } from "../../src/renderer/components/BoardCard";
import { parseProgress } from "../../src/renderer/progress";
import type { IterationView, TokenTotals, ActivityEntry, Task } from "../../src/shared/types";

const iv = (index: number, output: number, costUsd = 0): IterationView =>
    ({ index, verdict: "green", tokens: { input: 0, output, cacheRead: 0, cacheCreation: 0, costUsd }, durationMs: 100, sessionId: "s", commitSha: "c" });

const task = (over: Partial<Task> = {}): Task =>
    ({ id: "t", projectId: "p", title: "Build it", intent: "", acceptance: ["x"], status: "running", scopeHint: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0, ...over });

describe("verifyAttrs", () => {
    it("builds data-verify-* keys, stringifies values, drops null/undefined", () => {
        expect(verifyAttrs({ unit: "X", total: 3, consistent: true, missing: null, gone: undefined })).toEqual({
            "data-verify-unit": "X", "data-verify-total": "3", "data-verify-consistent": "true",
        });
    });
    it("emits nothing in production (zero prod footprint)", () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try { expect(verifyAttrs({ unit: "X" })).toEqual({}); }
        finally { process.env.NODE_ENV = prev; }
    });
});

describe("TokenReadout data-verify contract", () => {
    it("stamps the totals and consistent=true when the displayed total equals the sum of iterations", () => {
        const iterations = [iv(0, 5), iv(1, 7)];
        const totals: TokenTotals = { input: 0, output: 12, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
        const html = renderToStaticMarkup(<TokenReadout totals={totals} iterations={iterations} />);
        expect(html).toContain('data-verify-unit="TokenReadout"');
        expect(html).toContain('data-verify-output="12"');
        expect(html).toContain('data-verify-consistent="true"');
    });

    it("PROBE: a displayed total that disagrees with the sum surfaces data-verify-consistent=\"false\"", () => {
        const iterations = [iv(0, 5), iv(1, 7)];
        const totals: TokenTotals = { input: 0, output: 999, cacheRead: 0, cacheCreation: 0, costUsd: 0 }; // wrong on purpose
        const html = renderToStaticMarkup(<TokenReadout totals={totals} iterations={iterations} />);
        expect(html).toContain('data-verify-consistent="false"');
    });
});

describe("ActivityFeed / IterationHistory / BoardCard contracts", () => {
    it("ActivityFeed stamps its entry count", () => {
        const feed: ActivityEntry[] = [{ iterationIndex: 0, kind: "assistant", text: "a" }, { iterationIndex: 0, kind: "tool-use", text: "Bash" }];
        const html = renderToStaticMarkup(<ActivityFeed feed={feed} />);
        expect(html).toContain('data-verify-unit="ActivityFeed"');
        expect(html).toContain('data-verify-count="2"');
    });
    it("IterationHistory stamps its iteration count", () => {
        const html = renderToStaticMarkup(<IterationHistory iterations={[iv(0, 1), iv(1, 2), iv(2, 3)]} />);
        expect(html).toContain('data-verify-count="3"');
    });
    it("BoardCard stamps the task status and shows the live one-liner only while running", () => {
        const html = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} liveActivity="editing foo.ts" />);
        expect(html).toContain('data-verify-status="running"');
        expect(html).toContain("editing foo.ts");
        const merged = renderToStaticMarkup(<BoardCard task={task({ status: "merged" })} liveActivity="should-not-show" />);
        expect(merged).not.toContain("should-not-show");
    });
});

describe("ProgressPanel contract", () => {
    it("renders the four sections when the progress parses (structured)", () => {
        const md = "## Current focus\nwiring\n\n## Done\n- a\n\n## Remaining\n- b\n\n## Tried & ruled out\n- c\n";
        const html = renderToStaticMarkup(<ProgressPanel progress={parseProgress(md)} />);
        expect(html).toContain('data-verify-unit="ProgressPanel"');
        expect(html).toContain('data-verify-structured="true"');
        expect(html).toContain("wiring");
    });
    it("falls back to raw markdown for off-schema input", () => {
        const html = renderToStaticMarkup(<ProgressPanel progress={parseProgress("freeform, no headings")} />);
        expect(html).toContain('data-verify-structured="false"');
        expect(html).toContain("freeform");
    });
    it("reports unavailable when there is no progress file", () => {
        const html = renderToStaticMarkup(<ProgressPanel progress={null} />);
        expect(html).toContain('data-verify-available="false"');
    });
});
