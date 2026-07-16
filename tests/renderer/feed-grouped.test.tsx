// tests/renderer/feed-grouped.test.tsx
// The grouped activity feed (UI-only). groupFeed splits the chronological feed into
// consecutive iteration runs; FeedView renders one section per run with gate verdicts
// (check ✓/✗, acceptance, merge) as always-visible dominant FeedGateLine elements and
// assistant/tool-use chatter dimmed behind a collapsed <details> (drill-in). The
// load-bearing PROBE: the flat, ungrouped render (the pre-grouping FeedView shape)
// MUST FAIL every grouping assertion — no group stamps, no gate treatment, no <details>.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedView, groupFeed } from "../../src/renderer/views/TaskDetail";
import { FeedLine, gateToneOf, type TaskVM } from "../../src/renderer/views/helpers";
import type { ActivityEntry, EngineSnapshot, TaskStatus } from "../../src/shared/types";

/* ---------- fixtures (the components.test.tsx shapes) ---------- */
const a = (it: number, text: string): ActivityEntry => ({ iterationIndex: it, kind: "assistant", text });
const t = (it: number, text: string): ActivityEntry => ({ iterationIndex: it, kind: "tool-use", text });
const g = (it: number, text: string): ActivityEntry => ({ iterationIndex: it, kind: "gate", text });

const tokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 });
const snap = (feed: ActivityEntry[]): EngineSnapshot => ({
    taskId: "t", status: "running", currentIteration: null, iterations: [],
    totals: tokens(), feed, feedEventsConsumed: feed.length, terminalReason: null,
});
const vm = (feed: ActivityEntry[], status: TaskStatus = "running"): TaskVM => ({
    id: "t", projectId: "p", title: "Build it", intent: "Do the thing", acceptance: ["npm test"],
    status, scopeHint: null, dependsOn: [], planId: null, branchName: null,
    worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
    resumable: false, blocked: false, waitingOn: [], snap: snap(feed), validating: false,
});

// A realistic mixed feed: two worked iterations (chatter + verdicts) and a merge stage.
const MIXED: ActivityEntry[] = [
    a(0, "reading the failing test"), t(0, "Read"), t(0, "Edit"), g(0, "check: failed"),
    a(1, "fixing the assertion"), t(1, "Bash"), g(1, "check: passed"), g(1, "acceptance: passed"),
    g(2, "merge: waiting"), g(2, "merge: merging"), g(2, "merge: merged"),
];

const detailsBlocks = (html: string): string[] => html.match(/<details[\s\S]*?<\/details>/g) ?? [];
const sectionTags = (html: string): string[] => html.match(/<section[^>]*>/g) ?? [];
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("groupFeed (chronological feed → consecutive iteration runs)", () => {
    it("splits the mixed feed into one run per iteration, order and sizes intact", () => {
        const groups = groupFeed(MIXED);
        expect(groups.map((gr) => gr.iteration)).toEqual([0, 1, 2]);
        expect(groups.map((gr) => gr.entries.length)).toEqual([4, 4, 3]);
    });
    it("a reappearing index starts a NEW run — the order is never rewritten", () => {
        const groups = groupFeed([a(0, "x"), a(1, "y"), a(0, "z")]);
        expect(groups.map((gr) => gr.iteration)).toEqual([0, 1, 0]);
    });
    it("an empty feed yields no groups", () => {
        expect(groupFeed([])).toEqual([]);
    });
});

describe("gateToneOf (verdict tone — fail wins over pass)", () => {
    it("maps engine gate labels to their tone", () => {
        expect(gateToneOf("check: passed")).toBe("pass");
        expect(gateToneOf("acceptance: passed")).toBe("pass");
        expect(gateToneOf("merge: merged")).toBe("pass");
        expect(gateToneOf("check: failed")).toBe("fail");
        expect(gateToneOf("stopping: iteration cap reached")).toBe("fail");
        expect(gateToneOf("merge: waiting")).toBe("info");
        expect(gateToneOf("merge: merging")).toBe("info");
        expect(gateToneOf("merge re-check: running")).toBe("info");
    });
    it("PROBE: a lost merge race reads as a failure, not a merge success", () => {
        expect(gateToneOf("merge: lost race — recycled (merge-conflict)")).toBe("fail");
    });
});

describe("FeedView renders grouped by iteration", () => {
    const html = renderToStaticMarkup(<FeedView task={vm(MIXED)} />);

    it("stamps the root contract: entry count + group count", () => {
        expect(html).toContain('data-verify-unit="FeedView"');
        expect(html).toContain('data-verify-count="11"');
        expect(html).toContain('data-verify-groups="3"');
    });
    it("renders one FeedGroup section per iteration, headed and in order", () => {
        expect(count(html, 'data-verify-unit="FeedGroup"')).toBe(3);
        const h0 = html.indexOf("iteration 0"), h1 = html.indexOf("iteration 1"), h2 = html.indexOf("iteration 2");
        expect(h0).toBeGreaterThan(-1);
        expect(h1).toBeGreaterThan(h0);
        expect(h2).toBeGreaterThan(h1);
    });
    it("each group stamps its iteration and its gate/chatter split", () => {
        const [s0, s1, s2] = sectionTags(html);
        expect(s0).toContain('data-verify-iteration="0"');
        expect(s0).toContain('data-verify-gates="1"');
        expect(s0).toContain('data-verify-chatter="3"');
        expect(s1).toContain('data-verify-iteration="1"');
        expect(s1).toContain('data-verify-gates="2"');
        expect(s2).toContain('data-verify-iteration="2"');
        expect(s2).toContain('data-verify-chatter="0"');
    });
});

describe("gate verdicts are the dominant elements", () => {
    const html = renderToStaticMarkup(<FeedView task={vm(MIXED)} />);

    it("every gate renders as a FeedGateLine with its tone stamped", () => {
        expect(count(html, 'data-verify-unit="FeedGateLine"')).toBe(6);
        expect(count(html, 'data-verify-tone="fail"')).toBe(1);  // check: failed
        expect(count(html, 'data-verify-tone="pass"')).toBe(3);  // check/acceptance passed, merged
        expect(count(html, 'data-verify-tone="info"')).toBe(2);  // merge: waiting / merging
    });
    it("gate lines are NEVER buried inside the collapsed chatter", () => {
        const blocks = detailsBlocks(html);
        expect(blocks.length).toBe(2); // the it-0 and it-1 chatter runs
        for (const block of blocks) expect(block).not.toContain('data-verify-unit="FeedGateLine"');
    });
});

describe("chatter is dimmed and collapsible (drill-in)", () => {
    it("settled chatter runs render collapsed <details>, stamped dimmed", () => {
        const html = renderToStaticMarkup(<FeedView task={vm(MIXED)} />);
        const blocks = detailsBlocks(html);
        expect(blocks.length).toBe(2);
        for (const block of blocks) {
            expect(block).toContain('data-verify-unit="FeedChatter"');
            expect(block).toContain('data-verify-collapsed="true"');
            expect(block).toContain('data-verify-dimmed="true"');
        }
        expect(html).not.toContain('open=""'); // the feed ends in a verdict — nothing stays open
    });
    it("the live tail of a running task starts open (the operator keeps the live view)", () => {
        const live = [g(0, "check: failed"), a(1, "adjusting the fix"), t(1, "Bash")];
        const html = renderToStaticMarkup(<FeedView task={vm(live, "running")} />);
        expect(html).toContain('open=""');
        expect(html).toContain('data-verify-collapsed="false"');
    });
    it("PROBE: the same tail on a settled task is collapsed like everything else", () => {
        const tail = [g(0, "check: failed"), a(1, "adjusting the fix"), t(1, "Bash")];
        const html = renderToStaticMarkup(<FeedView task={vm(tail, "needs-human")} />);
        expect(html).not.toContain('open=""');
        expect(html).not.toContain('data-verify-collapsed="false"');
    });
});

describe("PROBES: renders that must FAIL the grouping assertions", () => {
    it("a flat, ungrouped render (the pre-grouping shape) carries NO grouping contract", () => {
        const flat = renderToStaticMarkup(
            <div className="helm-feed">{MIXED.map((e, i) => <FeedLine key={i} entry={e} />)}</div>,
        );
        expect(flat).toContain("check: failed");                          // the same entries render…
        expect(flat).not.toContain('data-verify-unit="FeedGroup"');       // …but nothing is grouped
        expect(flat).not.toContain('data-verify-unit="FeedGateLine"');    // no dominant gate treatment
        expect(flat).not.toContain("<details");                           // no collapsible chatter
    });
    it("an empty feed renders the empty state, never an empty group", () => {
        const html = renderToStaticMarkup(<FeedView task={vm([])} />);
        expect(html).not.toContain('data-verify-unit="FeedGroup"');
        expect(html).toContain("Feed is filling");
    });
});
