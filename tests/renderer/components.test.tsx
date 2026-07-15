// tests/renderer/components.test.tsx
// The renderer verify slice, ported to the M14 cockpit. The presentational units are pure
// and prop-driven, so we drive them with fixture snapshots and read the data-verify-*
// contract straight out of the static markup (react-dom/server — no jsdom). Every unit
// keeps at least one PROBE (a deliberately-wrong fixture that must surface the failing
// state); the old scaffold's invariants carry over onto their new homes:
//   TokenReadout consistency  → Inspector       ·  BoardCard             → TaskCard/VerbBar
//   SchedulerBar within-cap   → StatusBar       ·  HandbackActions trio  → VerbBar (handed-off)
//   PromoteResultPanel        → PromoteOutcome  ·  PlanRail/PlanDetail   → Planner units/PlansTab
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { verifyAttrs } from "../../src/renderer/components/verifyAttrs";
import { TerminalPane } from "../../src/renderer/components/TerminalPane";
import { ActionCtx, Heatmap, verbsFor, VerbBar, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import { TaskCard } from "../../src/renderer/views/Board";
import { FeedView, Inspector, IterationsTable, ProgressView } from "../../src/renderer/views/TaskDetail";
import { StatusBar, Titlebar } from "../../src/renderer/views/shell";
import { PromoteOutcome } from "../../src/renderer/views/dialogs";
import { ConductorLaunch, ConductorTab, PreflightReportPanel, RestartControl, StageRail, unackedWarns } from "../../src/renderer/views/Conductor";
import { PlansTab } from "../../src/renderer/views/Plans";
import { TerminalsView } from "../../src/renderer/views/Terminals";
import type { EngineSnapshot, PlanRailState, PreflightReport, Project, PromoteResponse, PtySession, PtySessionInfo, SchedulerState } from "../../src/shared/types";

/* ---------- fixtures ---------- */
const noop = () => { /* render-only */ };
const STUB_ACTIONS: CockpitActions = {
    openTask: noop, openPlan: noop, startNow: noop, dropIn: noop, startFresh: noop,
    resume: noop, verifyMerge: noop, abandon: noop, clearDeps: noop, openShell: noop,
};
const render = (el: ReactElement): string =>
    renderToStaticMarkup(<ActionCtx.Provider value={STUB_ACTIONS}>{el}</ActionCtx.Provider>);

const tokens = (output = 0, costUsd = 0) => ({ input: 0, output, cacheRead: 0, cacheCreation: 0, costUsd });
const snap = (over: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
    taskId: "t", status: "running", currentIteration: null, iterations: [],
    totals: tokens(), feed: [], feedEventsConsumed: 0, terminalReason: null, ...over,
});
const iv = (index: number, output: number, over: Partial<EngineSnapshot["iterations"][number]> = {}) => ({
    index, verdict: "green" as const, tokens: tokens(output), durationMs: 100, sessionId: "s", commitSha: "c", outputTail: null, ...over,
});
const vm = (over: Partial<TaskVM> = {}): TaskVM => ({
    id: "t", projectId: "p", title: "Build it", intent: "Do the thing", acceptance: ["npm test"],
    status: "running", scopeHint: null, dependsOn: [], planId: null, branchName: null,
    worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
    resumable: false, blocked: false, waitingOn: [], snap: null, validating: false, ...over,
});
const project = (over: Partial<Project> = {}): Project => ({
    id: "p", name: "alpha", repoPath: "C:\\repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null,
    model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null,
    promotionMode: "pr", jailImage: null, conductorSessionId: null, ...over,
});

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

describe("Inspector contract (the token-accounting invariant's new home)", () => {
    const withTotals = (totalsOut: number) =>
        vm({ snap: snap({ iterations: [iv(0, 5), iv(1, 7)], totals: tokens(totalsOut) }) });
    it("stamps consistent=true when the displayed totals equal the sum of iterations", () => {
        const html = render(<Inspector task={withTotals(12)} project={project()} tasksById={{}} plans={[]} />);
        expect(html).toContain('data-verify-unit="Inspector"');
        expect(html).toContain('data-verify-output="12"');
        expect(html).toContain('data-verify-consistent="true"');
    });
    it("PROBE: a displayed total that disagrees with the sum surfaces data-verify-consistent=\"false\"", () => {
        const html = render(<Inspector task={withTotals(999)} project={project()} tasksById={{}} plans={[]} />);
        expect(html).toContain('data-verify-consistent="false"');
    });
    it("shows intent, acceptance commands, and the engine bounds", () => {
        const html = render(<Inspector task={vm()} project={project()} tasksById={{}} plans={[]} />);
        expect(html).toContain("Do the thing");
        expect(html).toContain("npm test");
        expect(html).toContain("cli default"); // model fallback
    });
});

describe("FeedView / IterationsTable contracts", () => {
    it("FeedView stamps its entry count", () => {
        const t = vm({ snap: snap({ feed: [{ iterationIndex: 0, kind: "assistant", text: "a" }, { iterationIndex: 0, kind: "tool-use", text: "Bash" }], feedEventsConsumed: 2 }) });
        const html = render(<FeedView task={t} />);
        expect(html).toContain('data-verify-unit="FeedView"');
        expect(html).toContain('data-verify-count="2"');
    });
    it("IterationsTable stamps the SETTLED count and renders the live in-flight row separately", () => {
        const t = vm({
            snap: snap({
                iterations: [iv(0, 1), iv(1, 2), { ...iv(2, 0), verdict: null }],
                currentIteration: { index: 2, phase: "working", latestActivity: "editing foo.ts" },
            }),
        });
        const html = render(<IterationsTable task={t} />);
        expect(html).toContain('data-verify-count="2"'); // the in-flight iteration is NOT history
        expect(html).toContain('data-verify-live="true"');
        expect(html).toContain("agent working");
    });
    it("PROBE: an unfinished iteration (no verdict, no live row) never counts as history", () => {
        const t = vm({ snap: snap({ iterations: [{ ...iv(0, 0), verdict: null }] }) });
        const html = render(<IterationsTable task={t} />);
        expect(html).toContain("No iterations yet");
    });
    it("an iteration with an evidence tail is expandable; a resumeless turn is called out", () => {
        const t = vm({ snap: snap({ iterations: [iv(0, 1, { verdict: "failed", outputTail: "check exploded", sessionId: null })] }) });
        const html = render(<IterationsTable task={t} />);
        expect(html).toContain("expandable");
    });
});

describe("TaskCard contract", () => {
    it("stamps the task status and shows the live one-liner only while running", () => {
        const live = snap({ currentIteration: { index: 0, phase: "working", latestActivity: "editing foo.ts" } });
        const html = render(<TaskCard task={vm({ status: "running", snap: live })} project={project()} />);
        expect(html).toContain('data-verify-unit="TaskCard"');
        expect(html).toContain('data-verify-status="running"');
        expect(html).toContain("editing foo.ts");
        const merged = render(<TaskCard task={vm({ status: "merged", snap: live })} project={project()} />);
        expect(merged).not.toContain("editing foo.ts");
    });

    it("offers Start now on an unblocked queued card; a blocked one waits instead", () => {
        const queued = render(<TaskCard task={vm({ status: "queued" })} project={project()} />);
        expect(queued).toContain(">Start now<");
        const blocked = render(<TaskCard task={vm({ status: "queued", blocked: true, waitingOn: [{ id: "x", title: "parent", status: "running" }] })} project={project()} />);
        expect(blocked).not.toContain(">Start now<");
        expect(blocked).toContain("waiting on");
        expect(blocked).toContain("parent");
    });

    it("renders the waiting-on line on a queued+blocked card — waiting vs STUCK (Clear dependencies)", () => {
        const stuck = render(<TaskCard task={vm({ status: "queued", blocked: true, waitingOn: [{ id: "x", title: "dead parent", status: "needs-human" }] })} project={project()} />);
        expect(stuck).toContain("stuck — a parent needs a human");
        expect(stuck).toContain(">Clear dependencies<");
        expect(stuck).toContain('data-verify-stuck="true"');
    });

    it("PROBE: an unblocked queued card has NO waiting-on line (data-verify-blocked=\"false\")", () => {
        const html = render(<TaskCard task={vm({ status: "queued" })} project={project()} />);
        expect(html).toContain('data-verify-blocked="false"');
        expect(html).not.toContain("waiting on");
    });

    it("Drop in appears only once a session is resumable; Start fresh is always available (§8.4)", () => {
        const notYet = render(<TaskCard task={vm({ status: "running" })} project={project()} />);
        expect(notYet).toContain('data-verify-resumable="false"');
        expect(notYet).not.toContain(">Drop in<");
        expect(notYet).toContain(">Start fresh<");
        const ready = render(<TaskCard task={vm({ status: "running", resumable: true })} project={project()} />);
        expect(ready).toContain('data-verify-resumable="true"');
        expect(ready).toContain(">Drop in<");
    });

    it("PROBE: a merged card surfaces NO verbs at all (terminal states are history)", () => {
        const html = render(<TaskCard task={vm({ status: "merged", resumable: true })} project={project()} />);
        expect(html).not.toContain(">Drop in<");
        expect(html).not.toContain(">Start now<");
        expect(html).not.toContain(">Abandon<");
    });

    it("stamps data-verify-jail + the jail meta on a jailed project's card; host-mode carries neither", () => {
        const jailed = render(<TaskCard task={vm()} project={project({ jailImage: "helm-jail:latest" })} />);
        expect(jailed).toContain('data-verify-jail="true"');
        expect(jailed).toContain("jail");
        const host = render(<TaskCard task={vm()} project={project()} />);
        expect(host).not.toContain("data-verify-jail");
    });

    it("stamps the plan id when the task was born from a plan; hand-made cards carry none", () => {
        expect(render(<TaskCard task={vm({ planId: "pl1" })} project={project()} />)).toContain('data-verify-plan="pl1"');
        expect(render(<TaskCard task={vm()} project={project()} />)).not.toContain("data-verify-plan");
    });

    it("a needs-human card quotes its failure reason verbatim", () => {
        const html = render(<TaskCard task={vm({ status: "needs-human", failureReason: "iteration cap reached (8) — last gate: check failed" })} project={project()} />);
        expect(html).toContain("iteration cap reached (8)");
    });
});

describe("VerbBar contract (the operator verb list — §5.2)", () => {
    it("handed-off offers the hand-back trio (+ Open shell with a retained worktree)", () => {
        const t = vm({ status: "handed-off", worktreePath: "C:\\wt" });
        expect(verbsFor(t).map((v) => v.id)).toEqual(["resume", "verifyMerge", "openShell", "abandon"]);
        const html = render(<VerbBar task={t} />);
        expect(html).toContain(">Resume<");
        expect(html).toContain(">Verify &amp; merge<");
        expect(html).toContain(">Abandon<");
        expect(html).toContain(">Open shell<");
    });
    it("needs-human offers Start fresh / Open shell / Abandon (+ Drop in only when resumable)", () => {
        expect(verbsFor(vm({ status: "needs-human", worktreePath: "C:\\wt" })).map((v) => v.id)).toEqual(["startFresh", "openShell", "abandon"]);
        expect(verbsFor(vm({ status: "needs-human", worktreePath: "C:\\wt", resumable: true })).map((v) => v.id)).toEqual(["dropIn", "startFresh", "openShell", "abandon"]);
    });
    it("PROBE: a running task does NOT surface the hand-back trio", () => {
        const ids = verbsFor(vm({ status: "running", resumable: true })).map((v) => v.id);
        expect(ids).not.toContain("resume");
        expect(ids).not.toContain("verifyMerge");
        expect(ids).not.toContain("abandon");
    });
    it("verify & merge shows its in-flight state while validating", () => {
        const html = render(<VerbBar task={vm({ status: "handed-off", validating: true })} />);
        expect(html).toContain("Validating…");
    });
});

describe("Titlebar / StatusBar contracts (fleet telemetry)", () => {
    const sched = (over: Partial<SchedulerState> = {}): SchedulerState =>
        ({ paused: false, perProject: [{ projectId: "p", running: 2, cap: 3 }], ...over });
    const counts = { running: 2, needsHuman: 1, merged: 5 };

    it("Titlebar mirrors the tray tooltip counts and the pause state", () => {
        const html = render(<Titlebar counts={counts} paused={false} onTogglePause={noop} />);
        expect(html).toContain("2 running · 1 needs-human · 5 merged");
        expect(html).toContain('data-verify-paused="false"');
        const paused = render(<Titlebar counts={counts} paused onTogglePause={noop} />);
        expect(paused).toContain('data-verify-paused="true"');
        expect(paused).toContain("scheduler paused");
    });

    it("StatusBar stamps paused + within-cap=true when every project's running ≤ cap, and shows the slot line", () => {
        const html = render(<StatusBar counts={counts} projects={[project()]} sched={sched()} paused={false} spend={4.2} />);
        expect(html).toContain('data-verify-unit="StatusBar"');
        expect(html).toContain('data-verify-within-cap="true"');
        expect(html).toContain("alpha 2/3");
        expect(html).toContain("$4.20");
    });

    it("PROBE: a project with running > cap surfaces data-verify-within-cap=\"false\"", () => {
        const html = render(<StatusBar counts={counts} projects={[project()]} sched={sched({ perProject: [{ projectId: "p", running: 4, cap: 3 }] })} paused={false} spend={0} />);
        expect(html).toContain('data-verify-within-cap="false"');
    });
});

describe("PromoteOutcome contract (the result surface — never-push is load-bearing)", () => {
    const p = project();
    const ready = {
        outcome: "ready" as const, validatedSha: "abcdef1234567890", diffstat: "3 files changed", promoteBranch: "helm/promote-x",
    };
    it("direct advanced: stamps advanced=true and shows the target was advanced on the click", () => {
        const r: PromoteResponse = { ...ready, pushedRefs: [], commands: ["git push origin abcdef1234567890:refs/heads/main"], advancedTarget: true, advancedTo: "abcdef1234567890", note: "advanced main" };
        const html = render(<PromoteOutcome project={p} result={r} />);
        expect(html).toContain('data-verify-outcome="ready"');
        expect(html).toContain('data-verify-advanced="true"');
        expect(html).toContain("advanced main →");
        expect(html).toContain("audit trail");
    });
    it("pr ready: advanced=false, integration pushed, the gh command handed to run", () => {
        const r: PromoteResponse = { ...ready, pushedRefs: ["integration/ralph"], commands: ["gh pr create --base main --head integration/ralph --fill"], advancedTarget: false, note: "pushed integration/ralph" };
        const html = render(<PromoteOutcome project={p} result={r} />);
        expect(html).toContain('data-verify-advanced="false"');
        expect(html).toContain("integration/ralph");
        expect(html).toContain("gh pr create");
        expect(html).toContain("your move");
    });
    it("direct advance failed: shows the error and hands the retry command", () => {
        const r: PromoteResponse = { ...ready, pushedRefs: [], commands: ["git push origin abcdef1234567890:refs/heads/main"], advancedTarget: false, note: "could not advance", error: "non-fast-forward" };
        const html = render(<PromoteOutcome project={p} result={r} />);
        expect(html).toContain("non-fast-forward");
        expect(html).toContain("retry command");
    });
    it("PROBE: recheck-failed surfaces the failure output and hands NO commands", () => {
        const html = render(<PromoteOutcome project={p} result={{ outcome: "recheck-failed", output: "tsc exploded" }} />);
        expect(html).toContain('data-verify-outcome="recheck-failed"');
        expect(html).toContain('data-verify-commands="0"');
        expect(html).toContain("tsc exploded");
        expect(html).not.toContain("your move");
    });
    it("nothing-to-promote / conflict: a plain note, no commands", () => {
        expect(render(<PromoteOutcome project={p} result={{ outcome: "nothing-to-promote" }} />)).toContain("Nothing to promote");
        expect(render(<PromoteOutcome project={p} result={{ outcome: "conflict" }} />)).toContain("Nothing was pushed");
    });
});

describe("TerminalPane contract (shell only — xterm is the vendor edge)", () => {
    const session: PtySession = { id: "s1", kind: "dropin", title: "fix the bug", cwd: "C:\\wt" };
    it("stamps the session id + kind on the shell root without mounting xterm", () => {
        const html = renderToStaticMarkup(<TerminalPane session={session} />);
        expect(html).toContain('data-verify-unit="TerminalPane"');
        expect(html).toContain('data-verify-session="s1"');
        expect(html).toContain('data-verify-kind="dropin"');
    });
    it("reflects a different session's kind (planner) — the same reusable pane", () => {
        const html = renderToStaticMarkup(<TerminalPane session={{ ...session, id: "s2", kind: "planner" }} />);
        expect(html).toContain('data-verify-kind="planner"');
    });
});

describe("TerminalsView contract (closing = killing, dead tabs grey out — §8.5)", () => {
    const sess = (over: Partial<PtySessionInfo> = {}): PtySessionInfo =>
        ({ id: "s1", kind: "free", title: "alpha — shell", cwd: "C:\\repo", alive: true, ...over });
    const props = { onSelect: noop, onKill: noop, onNewShell: noop, projects: [project()], tasksById: {} };
    it("stamps session/live counts + the active tab, with a kill control per tab", () => {
        const html = render(<TerminalsView sessions={[sess(), sess({ id: "s2", title: "beta", alive: false })]} activeId="s1" {...props} />);
        expect(html).toContain('data-verify-unit="TerminalsView"');
        expect(html).toContain('data-verify-count="2"');
        expect(html).toContain('data-verify-live="1"');
        expect(html).toContain('data-verify-active="s1"');
        expect(html).toContain("· exited"); // the dead session stays listed, greyed
        expect((html.match(/aria-label="Kill session"/g) ?? []).length).toBe(2);
    });
    it("PROBE: no sessions → the empty state, no pane", () => {
        const html = render(<TerminalsView sessions={[]} activeId={null} {...props} />);
        expect(html).toContain("No sessions");
        expect(html).not.toContain("data-verify-unit=\"TerminalPane\"");
    });
});

describe("ProgressView contract", () => {
    const structured = "## Current focus\nShip it\n\n## Done\n- a\n\n## Remaining\n- b\n\n## Tried & ruled out\n- c\n";
    it("renders the four sections when the progress parses (structured)", () => {
        const html = render(<ProgressView md={structured} />);
        expect(html).toContain('data-verify-ok="true"');
        expect(html).toContain("Current focus");
        expect(html).toContain("Tried &amp; ruled out");
    });
    it("PROBE: falls back to raw markdown for off-schema input", () => {
        const html = render(<ProgressView md={"# freeform\nnot the schema"} />);
        expect(html).toContain('data-verify-ok="false"');
        expect(html).toContain("freeform");
    });
    it("reports unavailable when there is no progress file", () => {
        expect(render(<ProgressView md={null} />)).toContain("No progress file");
    });
});

describe("Conductor units (M10 rail + M11 two-phase approval, absorbed into the M16 conductor)", () => {
    const session: PtySession = { id: "pl", kind: "planner", title: "alpha — conductor", cwd: "C:\\repo" };
    const rail = (over: Partial<PlanRailState> = {}): PlanRailState =>
        ({ stage: "tasks", prdText: "# PRD", parse: null, verdicts: [], ...over });
    const draft = {
        planTitle: "Plan A",
        tasks: [{ slug: "t1", title: "First", intent: "do it", acceptance: ["npm run x"], scopeHint: null, dependsOn: [] }],
    };
    const conductorProps = { project: project(), session, resumable: false, onHydrate: noop, onLaunch: noop, onRestart: noop, onApproved: noop };
    // The static markup of the button that contains `text` (renderToStaticMarkup emits `disabled=""`).
    const buttonTagFor = (html: string, text: string): string => {
        const at = html.indexOf(text);
        expect(at).toBeGreaterThan(-1);
        return html.slice(html.lastIndexOf("<button", at), at);
    };

    it("StageRail stamps the stage and renders the three steps", () => {
        const html = render(<StageRail stage="prd" />);
        expect(html).toContain('data-verify-stage="prd"');
        expect(html).toContain("conversing");
        expect(html).toContain("tasks drafted");
    });

    it("a valid draft renders its cards + the static ⚠ with did-you-mean, and offers Run pre-flight", () => {
        const html = render(<ConductorTab {...conductorProps} rail={rail({
            parse: { ok: true, draft },
            verdicts: [{ taskSlug: "t1", command: "npm run x", level: "warn", reason: 'no npm script "x"', suggestion: "check" }],
        })} />);
        expect(html).toContain('data-verify-parse-ok="true"');
        expect(html).toContain("First");
        expect(html).toContain("did you mean");
        expect(html).toContain("npm run check");
        expect(html).toContain(">Run pre-flight<");
    });

    it("PROBE: a parse-invalid draft lists the errors verbatim and offers NO approval path", () => {
        const html = render(<ConductorTab {...conductorProps} rail={rail({ parse: { ok: false, errors: ["tasks[0].acceptance must be non-empty"] } })} />);
        expect(html).toContain('data-verify-parse-ok="false"');
        expect(html).toContain("tasks[0].acceptance must be non-empty");
        expect(html).not.toContain(">Run pre-flight<");
        expect(html).not.toContain("Confirm &amp; queue");
    });

    // ── M16 launch panel: the resume-guard's cockpit face ─────────────────────────────────────────
    it("without a session, the tab renders the launch panel with Resume + Fresh (never the pane)", () => {
        const html = render(<ConductorTab {...conductorProps} session={null} rail={undefined} />);
        expect(html).toContain('data-verify-unit="ConductorLaunch"');
        expect(html).toContain("Resume conductor");
        expect(html).toContain("Fresh session");
    });

    it("a resumable recorded session enables Resume (and stamps the contract)", () => {
        const html = render(<ConductorLaunch project={project()} resumable={true} onLaunch={noop} />);
        expect(html).toContain('data-verify-resumable="true"');
        expect(buttonTagFor(html, "Resume conductor")).not.toContain("disabled");
        expect(buttonTagFor(html, "Fresh session")).not.toContain("disabled");
    });

    it("PROBE: no resumable session → Resume is DISABLED (the guard's face: a dead id must not offer --resume), Fresh stays available", () => {
        const html = render(<ConductorLaunch project={project()} resumable={false} onLaunch={noop} />);
        expect(html).toContain('data-verify-resumable="false"');
        expect(buttonTagFor(html, "Resume conductor")).toContain("disabled");
        expect(buttonTagFor(html, "Fresh session")).not.toContain("disabled");
    });

    // ── issue #1: the always-on in-pane restart (the dead-session wedge escape) ────────────────────
    it("the live pane always carries an in-pane RestartControl (Resume + Fresh), so a dead claude is never a wedge", () => {
        const html = render(<ConductorTab {...conductorProps} resumable={true} rail={rail()} />);
        expect(html).toContain('data-verify-unit="RestartControl"');
        expect(html).toContain("Resume conductor");
        expect(html).toContain("Fresh session");
    });

    it("PROBE: Restart's Resume is DISABLED when nothing is resumable (the guard's face), Fresh stays available", () => {
        const html = render(<RestartControl resumable={false} onRestart={noop} />);
        expect(html).toContain('data-verify-resumable="false"');
        expect(buttonTagFor(html, "Resume conductor")).toContain("disabled");
        expect(buttonTagFor(html, "Fresh session")).not.toContain("disabled");
    });
});

describe("PreflightReportPanel contract (the ack gate — §8.7)", () => {
    const report: PreflightReport = {
        ran: true, warnCount: 2, verdicts: [
            { command: "npm run a", taskSlugs: ["t1"], level: "ok-red", exitCode: 1, tail: "1 failed" },
            { command: "npm run b", taskSlugs: ["t1", "t2"], level: "warn-already-green", exitCode: 0, tail: "all passed" },
            { command: "npm run c", taskSlugs: ["t2"], level: "warn-missing", exitCode: null, tail: "", reason: 'no npm script "c"', suggestion: "check" },
        ],
    };
    it("stamps warn/unacked counts and renders all three verdict flavors", () => {
        const html = render(<PreflightReportPanel report={report} acks={[]} onAck={noop} />);
        expect(html).toContain('data-verify-unit="PreflightReport"');
        expect(html).toContain('data-verify-warns="2"');
        expect(html).toContain('data-verify-unacked="2"');
        expect(html).toContain("expected red");
        expect(html).toContain("already green");
        expect(html).toContain("could not run");
        expect(html).toContain("exit —"); // a never-spawned command has no exit code
    });
    it("PROBE: unackedWarns hits zero only when EVERY warn is acknowledged", () => {
        expect(unackedWarns(report, [])).toBe(2);
        expect(unackedWarns(report, ["npm run b"])).toBe(1);
        expect(unackedWarns(report, ["npm run b", "npm run c"])).toBe(0);
        expect(unackedWarns(report, ["npm run a"])).toBe(2); // acking an ok-red changes nothing
    });
});

describe("PlansTab contract (M11 plan views)", () => {
    const plan = { id: "pl1", projectId: "p", title: "Plan A", prdText: "# PRD body", createdAt: 1 };
    it("stamps plan/member/merged counts and lists member tasks with their statuses", () => {
        const members = [vm({ id: "a", planId: "pl1", status: "merged", diffstat: "2 files changed, 10 insertions(+), 2 deletions(-)" }), vm({ id: "b", planId: "pl1", status: "queued" })];
        const html = render(<PlansTab project={project()} plans={[plan]} tasks={members} onFilterBoard={noop} />);
        expect(html).toContain('data-verify-unit="PlansTab"');
        expect(html).toContain('data-verify-members="2"');
        expect(html).toContain('data-verify-merged="1"');
        expect(html).toContain("# PRD body");
        expect(html).toContain("+10 −2");
    });
    it("PROBE: zero merged members stamps merged=0 (not a happy-path replay)", () => {
        const html = render(<PlansTab project={project()} plans={[plan]} tasks={[vm({ id: "a", planId: "pl1", status: "queued" })]} onFilterBoard={noop} />);
        expect(html).toContain('data-verify-merged="0"');
    });
});

describe("Heatmap contract (real merge timestamps)", () => {
    it("stamps the merged count it was fed", () => {
        const html = render(<Heatmap mergedAt={[Date.now(), Date.now() - 86_400_000]} />);
        expect(html).toContain('data-verify-unit="Heatmap"');
        expect(html).toContain('data-verify-merged="2"');
    });
    it("PROBE: an empty history stamps merged=0 and paints no cells", () => {
        const html = render(<Heatmap mergedAt={[]} />);
        expect(html).toContain('data-verify-merged="0"');
        expect(html).not.toContain("1 merged");
    });
});
