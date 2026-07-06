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
import { SchedulerBar } from "../../src/renderer/components/SchedulerBar";
import { HandbackActions } from "../../src/renderer/components/HandbackActions";
import { PromoteResultPanel } from "../../src/renderer/components/PromoteResultPanel";
import { TerminalPane } from "../../src/renderer/components/TerminalPane";
import { TerminalTabs } from "../../src/renderer/components/TerminalTabs";
import { PlanRail, PlanStageTracker, PlanDraftCards } from "../../src/renderer/components/PlanRail";
import { parseProgress } from "../../src/renderer/progress";
import type { IterationView, TokenTotals, ActivityEntry, Task, SchedulerState, PromoteResponse, PtySession, PtySessionInfo, PlanRailState } from "../../src/shared/types";

const schedState = (over: Partial<SchedulerState> = {}): SchedulerState =>
    ({ paused: false, perProject: [{ projectId: "p1", running: 2, cap: 3 }], ...over });

const iv = (index: number, output: number, costUsd = 0): IterationView =>
    ({ index, verdict: "green", tokens: { input: 0, output, cacheRead: 0, cacheCreation: 0, costUsd }, durationMs: 100, sessionId: "s", commitSha: "c" });

const task = (over: Partial<Task> = {}): Task =>
    ({ id: "t", projectId: "p", title: "Build it", intent: "", acceptance: ["x"], status: "running", scopeHint: null, dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0, ...over });

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

    it("BoardCard shows the Run button on a queued card ONLY when paused (manual mode)", () => {
        const queuedPaused = renderToStaticMarkup(<BoardCard task={task({ status: "queued" })} paused onRun={() => {}} />);
        expect(queuedPaused).toContain(">Run<");
        const queuedAuto = renderToStaticMarkup(<BoardCard task={task({ status: "queued" })} paused={false} onRun={() => {}} />);
        expect(queuedAuto).not.toContain(">Run<"); // auto-fleet → scheduler starts it, no manual button
        const runningPaused = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} paused onRun={() => {}} />);
        expect(runningPaused).not.toContain(">Run<"); // only queued cards get a Run button
    });

    // M5: Drop in / Start fresh on a running OR needs-human card; Abandon also on needs-human.
    it("BoardCard surfaces Drop in + Start fresh on running and needs-human cards (Abandon on needs-human)", () => {
        const running = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} onDropIn={() => {}} onStartFresh={() => {}} onAbandon={() => {}} />);
        expect(running).toContain(">Drop in<");
        expect(running).toContain(">Start fresh<");
        expect(running).not.toContain(">Abandon<");           // Abandon is offered from needs-human, not running
        expect(running).toContain('data-verify-dropin="true"');

        const nh = renderToStaticMarkup(<BoardCard task={task({ status: "needs-human" })} onDropIn={() => {}} onStartFresh={() => {}} onAbandon={() => {}} />);
        expect(nh).toContain(">Drop in<");
        expect(nh).toContain(">Abandon<");
        expect(nh).toContain('data-verify-dropin="true"');
    });

    // M5 resume-guard: Drop in --resumes the latest session, so it's DISABLED until one is persisted
    // (`resumable`). Start fresh is always available, so a disabled Drop in strands no one.
    it("BoardCard DISABLES Drop in until a session is resumable; Start fresh stays available", () => {
        const notYet = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} onDropIn={() => {}} onStartFresh={() => {}} />);
        expect(notYet).toContain('data-verify-resumable="false"'); // the machine-readable guard state
        expect(notYet).toContain('disabled=""');                   // the (only) disabled button is Drop in
        expect(notYet).toContain("No resumable session yet");      // its explanatory title
        expect(notYet).toContain(">Start fresh<");                 // always available to grab the agent

        const ready = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} resumable onDropIn={() => {}} onStartFresh={() => {}} />);
        expect(ready).toContain('data-verify-resumable="true"');
        expect(ready).not.toContain('disabled=""');                // a persisted session → Drop in enabled
    });

    // M8: a retained worktree (needs-human / handed-off with a worktreePath) offers a free [+ terminal].
    it("BoardCard offers [+ terminal] on a retained-worktree card (needs-human / handed-off), not otherwise", () => {
        const nh = renderToStaticMarkup(<BoardCard task={task({ status: "needs-human", worktreePath: "/wt/t" })} onNewTerminal={() => {}} onDropIn={() => {}} onStartFresh={() => {}} onAbandon={() => {}} />);
        expect(nh).toContain("+ terminal");
        const ho = renderToStaticMarkup(<BoardCard task={task({ status: "handed-off", worktreePath: "/wt/t" })} onNewTerminal={() => {}} />);
        expect(ho).toContain("+ terminal"); // handed-off has no drop-in row, but still gets the free shell
        // a running task has no retained worktree yet → no [+ terminal]
        const running = renderToStaticMarkup(<BoardCard task={task({ status: "running" })} onNewTerminal={() => {}} onDropIn={() => {}} onStartFresh={() => {}} />);
        expect(running).not.toContain("+ terminal");
        // needs-human WITHOUT a worktree (pre-retention / already reaped) → no [+ terminal]
        const noWt = renderToStaticMarkup(<BoardCard task={task({ status: "needs-human", worktreePath: null })} onNewTerminal={() => {}} onDropIn={() => {}} onStartFresh={() => {}} onAbandon={() => {}} />);
        expect(noWt).not.toContain("+ terminal");
    });

    it("PROBE: a queued or merged card does NOT surface Drop in (data-verify-dropin=\"false\")", () => {
        const queued = renderToStaticMarkup(<BoardCard task={task({ status: "queued" })} onDropIn={() => {}} onStartFresh={() => {}} />);
        expect(queued).not.toContain(">Drop in<");
        expect(queued).toContain('data-verify-dropin="false"');
        const merged = renderToStaticMarkup(<BoardCard task={task({ status: "merged" })} onDropIn={() => {}} />);
        expect(merged).not.toContain(">Drop in<");
        expect(merged).toContain('data-verify-dropin="false"');
    });

    // M9: a queued + blocked card shows a waiting-on line and distinguishes WAITING (parent in flight) from
    // STUCK (parent needs-human/abandoned), which also offers Clear dependencies. The manual Run is hidden
    // while blocked (startNow is gated — a Run click would be a no-op).
    it("BoardCard renders the waiting-on line on a queued+blocked card — waiting vs stuck", () => {
        const waiting = renderToStaticMarkup(
            <BoardCard task={task({ status: "queued" })} blocked waitingOn={[{ id: "p1", title: "Parent A", status: "running" }]} paused onRun={() => {}} onClearDeps={() => {}} />,
        );
        expect(waiting).toContain('data-verify-blocked="true"');
        expect(waiting).toContain('data-verify-waiting-on="Parent A"');
        expect(waiting).toContain("waiting on");
        expect(waiting).toContain("Parent A");
        expect(waiting).not.toContain("Clear dependencies"); // an in-flight parent → just wait
        expect(waiting).not.toContain(">Run<");               // gated → no misleading manual Run

        const stuck = renderToStaticMarkup(
            <BoardCard task={task({ status: "queued" })} blocked waitingOn={[{ id: "p1", title: "Wedged Parent", status: "needs-human" }]} onClearDeps={() => {}} />,
        );
        expect(stuck).toContain("Wedged Parent");
        expect(stuck).toContain("Clear dependencies");        // stuck → offer the unblock affordance
    });

    it("PROBE: an unblocked queued card has NO waiting-on line (data-verify-blocked=\"false\") and keeps its Run", () => {
        const html = renderToStaticMarkup(<BoardCard task={task({ status: "queued" })} paused onRun={() => {}} />);
        expect(html).toContain('data-verify-blocked="false"');
        expect(html).not.toContain("waiting on");
        expect(html).toContain(">Run<"); // eligible → the manual Run stays
    });
});

describe("HandbackActions contract (the handed-off trio)", () => {
    it("renders Resume loop / Verify & merge / Abandon ONLY when handed-off", () => {
        const ho = renderToStaticMarkup(<HandbackActions status="handed-off" onResume={() => {}} onVerifyAndMerge={() => {}} onAbandon={() => {}} />);
        expect(ho).toContain(">Resume loop<");
        expect(ho).toContain("Verify"); // "Verify & merge" (& renders escaped)
        expect(ho).toContain(">Abandon<");
        expect(ho).toContain('data-verify-unit="HandbackActions"');
        expect(ho).toContain('data-verify-handback="true"');
    });

    it("PROBE: a running task does NOT surface the trio (the renderer-side negative control)", () => {
        const run = renderToStaticMarkup(<HandbackActions status="running" onResume={() => {}} onVerifyAndMerge={() => {}} onAbandon={() => {}} />);
        expect(run).not.toContain(">Resume loop<");
        expect(run).toContain('data-verify-handback="false"');
    });

    it("shows the terminal-launch error when one was surfaced", () => {
        const html = renderToStaticMarkup(<HandbackActions status="handed-off" launchError="terminal launch failed: wt.exe not found" />);
        expect(html).toContain("terminal launch failed");
    });
});

describe("SchedulerBar contract", () => {
    it("stamps paused + within-cap=true when every project's running ≤ cap", () => {
        const html = renderToStaticMarkup(
            <SchedulerBar state={schedState({ perProject: [{ projectId: "p1", running: 2, cap: 3 }, { projectId: "p2", running: 1, cap: 2 }] })} onSetPaused={() => {}} />,
        );
        expect(html).toContain('data-verify-unit="SchedulerBar"');
        expect(html).toContain('data-verify-paused="false"');
        expect(html).toContain('data-verify-within-cap="true"');
    });

    it("PROBE: a project with running > cap surfaces data-verify-within-cap=\"false\"", () => {
        const html = renderToStaticMarkup(<SchedulerBar state={schedState({ perProject: [{ projectId: "p1", running: 4, cap: 3 }] })} onSetPaused={() => {}} />);
        expect(html).toContain('data-verify-within-cap="false"');
    });

    it("shows running/cap and a queued count per project", () => {
        const html = renderToStaticMarkup(
            <SchedulerBar state={schedState({ perProject: [{ projectId: "p1", running: 2, cap: 3 }] })} queuedByProject={{ p1: 5 }} names={{ p1: "MyProj" }} onSetPaused={() => {}} />,
        );
        expect(html).toContain("MyProj");
        expect(html).toContain("2/3");
        expect(html).toContain("5 queued");
    });

    it("reflects paused state in the toggle: Pause when running, Resume when paused", () => {
        const running = renderToStaticMarkup(<SchedulerBar state={schedState({ paused: false })} onSetPaused={() => {}} />);
        expect(running).toContain("Pause");
        const paused = renderToStaticMarkup(<SchedulerBar state={schedState({ paused: true })} onSetPaused={() => {}} />);
        expect(paused).toContain("Resume");
        expect(paused).toContain('data-verify-paused="true"');
    });
});

describe("PromoteResultPanel contract (the result surface)", () => {
    const directAdvanced: PromoteResponse = {
        outcome: "ready", validatedSha: "abcdef0123456789", diffstat: "+5 -2",
        promoteBranch: "helm/promote-p1-abcdef012345",
        pushedRefs: [], advancedTarget: true, advancedTo: "abcdef0123456789",
        note: "advanced main → abcdef012345 (the exact re-checked commit)",
        commands: ["git push origin abcdef0123456789:refs/heads/main"],
    };

    it("direct advanced: stamps advanced=true and shows the target was advanced on the click", () => {
        const html = renderToStaticMarkup(<PromoteResultPanel projectName="MyProj" result={directAdvanced} />);
        expect(html).toContain('data-verify-unit="PromoteResultPanel"');
        expect(html).toContain('data-verify-outcome="ready"');
        expect(html).toContain('data-verify-ready="true"');
        expect(html).toContain('data-verify-advanced="true"');
        expect(html).toContain('data-verify-pushed="0"'); // no helper push — the advance IS the push
        expect(html).toContain("+5 -2");
        expect(html).toContain("advanced main"); // the headline note
    });

    it("pr ready: advanced=false, integration pushed, the gh command shown to run", () => {
        const pr: PromoteResponse = {
            outcome: "ready", validatedSha: "abcdef0123456789", diffstat: "+5 -2", promoteBranch: "helm/promote-p1-abcdef012345",
            pushedRefs: ["integration/ralph"], advancedTarget: false, note: "pushed integration/ralph — open the PR to graduate it into main",
            commands: ["gh pr create --base main --head integration/ralph --fill"],
        };
        const html = renderToStaticMarkup(<PromoteResultPanel projectName="MyProj" result={pr} />);
        expect(html).toContain('data-verify-advanced="false"');
        expect(html).toContain('data-verify-pushed="1"');
        expect(html).toContain("gh pr create"); // the human still opens the PR
    });

    it("direct advance failed: shows the error and hands the retry command", () => {
        const failed: PromoteResponse = {
            outcome: "ready", validatedSha: "abcdef0123456789", diffstat: "+5 -2", promoteBranch: "helm/promote-p1-abcdef012345",
            pushedRefs: [], advancedTarget: false, note: "could not advance main — it may have moved; re-run Promote",
            error: "! [rejected] (non-fast-forward)", commands: ["git push origin abcdef0123456789:refs/heads/main"],
        };
        const html = renderToStaticMarkup(<PromoteResultPanel projectName="MyProj" result={failed} />);
        expect(html).toContain('data-verify-advanced="false"');
        expect(html).toContain("non-fast-forward");
        expect(html).toContain("git push origin abcdef0123456789:refs/heads/main"); // retry
    });

    it("recheck-failed: surfaces the outcome, the failure output, and NO commands", () => {
        const html = renderToStaticMarkup(<PromoteResultPanel projectName="MyProj" result={{ outcome: "recheck-failed", output: "tests failed on the fresh tip" }} />);
        expect(html).toContain('data-verify-outcome="recheck-failed"');
        expect(html).toContain('data-verify-ready="false"');
        expect(html).toContain('data-verify-advanced="false"');
        expect(html).toContain('data-verify-commands="0"');
        expect(html).toContain("tests failed on the fresh tip");
    });

    it("nothing-to-promote / conflict: a ready=false note, no commands", () => {
        const nothing = renderToStaticMarkup(<PromoteResultPanel projectName="P" result={{ outcome: "nothing-to-promote" }} />);
        expect(nothing).toContain('data-verify-outcome="nothing-to-promote"');
        expect(nothing).toContain('data-verify-ready="false"');
        const conflict = renderToStaticMarkup(<PromoteResultPanel projectName="P" result={{ outcome: "conflict" }} />);
        expect(conflict).toContain('data-verify-outcome="conflict"');
        expect(conflict).toContain("Resolve the conflict");
    });

    it("loading: stamps outcome=loading and shows the in-flight note", () => {
        const html = renderToStaticMarkup(<PromoteResultPanel projectName="P" result="loading" />);
        expect(html).toContain('data-verify-outcome="loading"');
        expect(html).toContain("validating integration on a fresh origin tip");
    });
});

describe("TerminalPane contract (shell only — xterm is the vendor edge)", () => {
    const sess = (over: Partial<PtySession> = {}): PtySession =>
        ({ id: "sess-123", kind: "dropin", title: "task-42 drop-in", cwd: "/wt/task-42", taskId: "t42", ...over });

    // react-dom/server does NOT run useEffect, so xterm never loads (node env, no DOM) — the shell renders
    // alone. This asserts the machine-readable contract a verifier/agent reads to find a mounted terminal.
    it("stamps the session id + kind on the shell root without mounting xterm", () => {
        const html = renderToStaticMarkup(<TerminalPane session={sess()} />);
        expect(html).toContain('data-verify-unit="TerminalPane"');
        expect(html).toContain('data-verify-session="sess-123"');
        expect(html).toContain('data-verify-kind="dropin"');
    });

    it("reflects a different session's kind (planner) — the same reusable pane", () => {
        const html = renderToStaticMarkup(<TerminalPane session={sess({ id: "p1", kind: "planner" })} />);
        expect(html).toContain('data-verify-session="p1"');
        expect(html).toContain('data-verify-kind="planner"');
    });
});

describe("TerminalTabs contract (M8 tab strip — the terminal host)", () => {
    const info = (id: string, over: Partial<PtySessionInfo> = {}): PtySessionInfo =>
        ({ id, kind: "free", title: id, cwd: `/wt/${id}`, alive: true, ...over });

    it("stamps the tab count and marks exactly the active tab", () => {
        const html = renderToStaticMarkup(<TerminalTabs sessions={[info("a", { kind: "dropin" }), info("b")]} activeId="a" onFocus={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-verify-unit="TerminalTabs"');
        expect(html).toContain('data-verify-count="2"');
        expect(html).toContain('data-verify-active="a"'); // the strip's active id
        // per-tab kind + which one is active
        expect(html).toContain('data-verify-session="a"');
        expect(html).toContain('data-verify-kind="dropin"');
        expect(html).toContain('data-verify-kind="free"');
        // the active tab reads active=true, the other active=false (machine-readable focus)
        expect(html).toMatch(/data-verify-session="a"[^>]*data-verify-kind="dropin"[^>]*data-verify-active="true"/);
        expect(html).toMatch(/data-verify-session="b"[^>]*data-verify-active="false"/);
    });

    it("renders a close (×) control per tab (the only renderer-initiated kill)", () => {
        const html = renderToStaticMarkup(<TerminalTabs sessions={[info("a")]} activeId="a" onFocus={() => {}} onClose={() => {}} />);
        expect(html).toContain("×");
    });

    it("greys out a dead session (alive=false) until its exit event prunes it", () => {
        const html = renderToStaticMarkup(<TerminalTabs sessions={[info("a", { alive: false })]} activeId="a" onFocus={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-verify-alive="false"');
    });

    it("an empty strip stamps count=0 and no active tab", () => {
        const html = renderToStaticMarkup(<TerminalTabs sessions={[]} activeId={null} onFocus={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-verify-count="0"');
        expect(html).not.toContain('data-verify-active='); // null active → attribute dropped
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

describe("PlanRail contract (M10 planner side rail)", () => {
    const validParse: PlanRailState["parse"] = { ok: true, draft: { planTitle: "p", tasks: [
        { slug: "t1", title: "Foundation", intent: "build the thing", acceptance: ["npm run check", "npm run verify:trays"], scopeHint: null, dependsOn: [] },
        { slug: "t2", title: "Rail", intent: "render it", acceptance: ["npm run check"], scopeHint: null, dependsOn: ["t1"] },
    ] } };
    const verdicts: PlanRailState["verdicts"] = [
        { taskSlug: "t1", command: "npm run check", level: "ok" },
        { taskSlug: "t1", command: "npm run verify:trays", level: "warn", reason: "no npm script \"verify:trays\"", suggestion: "verify:tray" },
        { taskSlug: "t2", command: "npm run check", level: "ok" },
    ];
    const validRail: PlanRailState = { stage: "tasks", prdText: "# PRD\nbody", parse: validParse, verdicts };
    const invalidRail: PlanRailState = { stage: "tasks", prdText: null, parse: { ok: false, errors: ["planTitle must be a non-empty string"] }, verdicts: [] };

    it("PlanStageTracker stamps the stage and marks exactly the active step (◂ now)", () => {
        const html = renderToStaticMarkup(<PlanStageTracker stage="prd" />);
        expect(html).toContain('data-verify-unit="PlanStageTracker"');
        expect(html).toContain('data-verify-stage="prd"');
        expect(html).toContain("PRD drafted ◂ now"); // the active step, readable off the DOM
        expect(html).not.toContain("Tasks drafted ◂ now"); // a later, inactive step is not marked
    });

    it("PlanDraftCards (valid) stamps task + warn counts and shows the ⚠ + did-you-mean", () => {
        const html = renderToStaticMarkup(<PlanDraftCards parse={validParse} verdicts={verdicts} />);
        expect(html).toContain('data-verify-unit="PlanDraftCards"');
        expect(html).toContain('data-verify-state="valid"');
        expect(html).toContain('data-verify-tasks="2"');
        expect(html).toContain('data-verify-warns="1"');
        expect(html).toContain("⚠");
        expect(html).toContain("did you mean");
        expect(html).toContain("verify:tray");        // the suggested script
        expect(html).toContain("depends on: t1");      // the edge by slug
    });

    it("PlanDraftCards (invalid) stamps state=invalid + error count and lists the errors verbatim", () => {
        const html = renderToStaticMarkup(<PlanDraftCards parse={invalidRail.parse} verdicts={[]} />);
        expect(html).toContain('data-verify-state="invalid"');
        expect(html).toContain('data-verify-errors="1"');
        expect(html).toContain("planTitle must be a non-empty string");
    });

    it("PlanRail ENABLES Approve for a valid non-empty draft (can-approve=true)", () => {
        const html = renderToStaticMarkup(<PlanRail state={validRail} onApprove={() => {}} />);
        expect(html).toContain('data-verify-unit="PlanRail"');
        expect(html).toContain('data-verify-can-approve="true"');
        expect(html).toContain('data-verify-tasks="2"');
        expect(html).toContain("Approve"); // the button; not disabled
        expect(html).not.toContain('disabled=""');
    });

    it("PROBE: PlanRail DISABLES Approve while the draft is parse-invalid (can-approve=false)", () => {
        const html = renderToStaticMarkup(<PlanRail state={invalidRail} onApprove={() => {}} />);
        expect(html).toContain('data-verify-can-approve="false"');
        expect(html).toContain('disabled=""'); // approve blocked while invalid
    });
});
