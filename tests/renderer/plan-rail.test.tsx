// tests/renderer/plan-rail.test.tsx
// The multi-draft side rail's proof (plan-queue slice — "Side rail lists N drafts, each Approvable").
// PlanQueueRail renders the SAME rail contract once per draft, in set order (loose root first, then
// <slug>/ drafts sorted): one card per draft with ITS OWN static pre-flight verdicts and ITS OWN Approve
// (the authority), plus [Approve all (in set order)] as a convenience over the per-draft approvals.
// Back-compat is load-bearing: a single anonymous loose-root draft — the only shape main pushes
// pre-queue — must render EXACTLY as today (no per-draft chrome, no Approve-all), so shipping the seam
// changes nothing live. Same regime as components.test.tsx: renderToStaticMarkup + the data-verify-*
// contract, no jsdom.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConductorTab, PlanQueueRail, queueApproveOrder, type NamedPlanRailState } from "../../src/renderer/views/Conductor";
import type { PlanDraftTask, PreflightVerdict, Project, PtySession } from "../../src/shared/types";

/* ---------- fixtures ---------- */
const noop = () => { /* render-only */ };

const task = (slug: string, over: Partial<PlanDraftTask> = {}): PlanDraftTask =>
    ({ slug, title: `Task ${slug}`, intent: `do ${slug}`, acceptance: [`npm run ${slug}`], scopeHint: null, dependsOn: [], ...over });
const warn = (slug: string, reason: string, suggestion?: string): PreflightVerdict =>
    ({ taskSlug: slug, command: `npm run ${slug}`, level: "warn", reason, suggestion });
const okDraft = (name: string | null, planTitle: string, tasks: PlanDraftTask[], verdicts: PreflightVerdict[] = []): NamedPlanRailState =>
    ({ name, stage: "tasks", prdText: "# prd", parse: { ok: true, draft: { planTitle, tasks } }, verdicts });
const badDraft = (name: string | null, errors: string[]): NamedPlanRailState =>
    ({ name, stage: "tasks", prdText: null, parse: { ok: false, errors }, verdicts: [] });

const rail = (drafts: NamedPlanRailState[], approving = false): string =>
    renderToStaticMarkup(<PlanQueueRail drafts={drafts} approving={approving} onApprove={noop} />);

// The slice of markup belonging to ONE draft card (from its name stamp to the next card), so "its own"
// verdicts/Approve are asserted per card, not just somewhere in the rail.
const cardOf = (html: string, name: string): string => {
    const marker = `data-verify-name="${name}"`;
    const at = html.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const next = html.indexOf('data-verify-unit="QueuedDraftCard"', at + marker.length);
    return next === -1 ? html.slice(at) : html.slice(at, next);
};

describe("PlanQueueRail — N drafts, one card each, per-card verdicts + Approve", () => {
    const three = [
        okDraft(null, "Root plan", [task("r1")], [warn("r1", 'no npm script "r1"', "check")]),
        okDraft("alpha", "Alpha plan", [task("a1"), task("a2")]),
        okDraft("beta", "Beta plan", [task("b1")], [warn("b1", 'no npm script "b1"', "test")]),
    ];

    it("renders one card per draft, stamped with the set size and each draft's name", () => {
        const html = rail(three);
        expect(html).toContain('data-verify-unit="PlanQueueRail"');
        expect(html).toContain('data-verify-drafts="3"');
        expect(html).toContain('data-verify-single="false"');
        expect((html.match(/data-verify-unit="QueuedDraftCard"/g) ?? []).length).toBe(3);
        expect(html).toContain('data-verify-name="(root)"');
        expect(html).toContain('data-verify-name="alpha"');
        expect(html).toContain('data-verify-name="beta"');
    });

    it("each card carries ITS OWN static verdicts — a sibling's warn never bleeds across", () => {
        const html = rail(three);
        const root = cardOf(html, "(root)");
        expect(root).toContain("no npm script &quot;r1&quot;");
        expect(root).toContain("npm run check"); // the did-you-mean
        expect(root).not.toContain("no npm script &quot;b1&quot;");
        expect(root).toContain('data-verify-warns="1"');
        const alpha = cardOf(html, "alpha");
        expect(alpha).toContain('data-verify-warns="0"');
        expect(alpha).not.toContain("did you mean");
        expect(cardOf(html, "beta")).toContain("no npm script &quot;b1&quot;");
    });

    it("each card has its own Approve button sized to its task count", () => {
        const html = rail(three);
        expect((html.match(/Approve — queue/g) ?? []).length).toBe(3);
        expect(cardOf(html, "(root)")).toContain("Approve — queue 1 task<");
        expect(cardOf(html, "alpha")).toContain("Approve — queue 2 tasks");
    });

    it("offers [Approve all (in set order)], and the order is the set order: root first, then sorted names", () => {
        const html = rail(three);
        expect(html).toContain("Approve all (in set order)");
        expect(html).toContain('data-verify-order="(root)¦alpha¦beta"');
        expect(queueApproveOrder(three)).toEqual([null, "alpha", "beta"]);
    });

    it("PROBE: a parse-failed draft shows its errors verbatim in ITS card, offers NO Approve, and Approve-all skips it", () => {
        const drafts = [three[0], badDraft("broken", ["tasks[0].acceptance must be non-empty"])];
        const html = rail(drafts);
        const broken = cardOf(html, "broken");
        expect(broken).toContain('data-verify-parse-ok="false"');
        expect(broken).toContain("tasks[0].acceptance must be non-empty");
        expect(broken).not.toContain("Approve — queue");
        expect(html).toContain('data-verify-approvable="1"');
        expect(html).toContain('data-verify-order="(root)"');
        expect(queueApproveOrder(drafts)).toEqual([null]);
        // a bad draft never poisons a sibling: the root card still approves
        expect(cardOf(html, "(root)")).toContain("Approve — queue 1 task<");
    });

    it("PROBE: a bad draft in the MIDDLE is skipped without reordering its siblings", () => {
        expect(queueApproveOrder([three[0], badDraft("alpha", ["boom"]), okDraft("beta", "B", [task("b1")])])).toEqual([null, "beta"]);
    });
});

describe("PlanQueueRail — the single loose-root face (N=1 back-compat)", () => {
    it("a single anonymous draft renders exactly as today: the draft-tasks overline + task cards, no per-draft chrome", () => {
        const html = rail([okDraft(null, "Root plan", [task("r1"), task("r2")], [warn("r1", 'no npm script "r1"', "check")])]);
        expect(html).toContain('data-verify-single="true"');
        expect(html).toContain("draft tasks — 2 · fix problems in the session, not here");
        expect(html).toContain("Task r1");
        expect(html).toContain("did you mean");
        expect(html).toContain("npm run check");
        expect(html).not.toContain("Approve all");
        expect(html).not.toContain("QueuedDraftCard");
        expect(html).not.toContain("Approve — queue");
    });

    it("a single anonymous parse-failed draft renders today's error face — errors verbatim, no approval path", () => {
        const html = rail([badDraft(null, ["tasks[0].acceptance must be non-empty"])]);
        expect(html).toContain('data-verify-unit="DraftErrors"');
        expect(html).toContain("tasks.json has 1 problem — fix it in the session:");
        expect(html).toContain("tasks[0].acceptance must be non-empty");
        expect(html).not.toContain("Approve");
    });

    it("PROBE: a single NAMED draft is queue-world, not the loose-root face (its card approves; no Approve-all for a stack of one)", () => {
        const html = rail([okDraft("alpha", "Alpha plan", [task("a1")])]);
        expect(html).toContain('data-verify-single="false"');
        expect(html).toContain('data-verify-name="alpha"');
        expect(html).toContain("Approve — queue 1 task<");
        expect(html).not.toContain("Approve all");
    });

    it("PROBE: no drafts at all renders nothing (the rail stays stage/PRD only)", () => {
        expect(rail([])).toBe("");
    });
});

describe("ConductorTab wires the seam (the side rail IS the queue rail)", () => {
    const project: Project = {
        id: "p", name: "alpha", repoPath: "C:\\repo", integrationBranch: "integration/ralph",
        targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
        setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null,
        model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null,
        promotionMode: "pr", jailImage: null, conductorSessionId: null,
    };
    const session: PtySession = { id: "pl", kind: "planner", title: "alpha — conductor", cwd: "C:\\repo" };

    it("the live rail renders through PlanQueueRail's single face, keeping today's two-phase approval box", () => {
        const html = renderToStaticMarkup(<ConductorTab project={project} session={session} resumable={false}
            rail={{ stage: "tasks", prdText: "# PRD", parse: { ok: true, draft: { planTitle: "Plan A", tasks: [task("t1")] } }, verdicts: [] }}
            onHydrate={noop} onLaunch={noop} onRestart={noop} onApproved={noop} />);
        expect(html).toContain('data-verify-unit="PlanQueueRail"');
        expect(html).toContain('data-verify-single="true"');
        expect(html).toContain("Task t1");
        expect(html).toContain(">Run pre-flight<"); // the root draft's authority stays the approval box
        expect(html).not.toContain("Approve all");
        expect(html).not.toContain("Approve — queue");
    });
});
