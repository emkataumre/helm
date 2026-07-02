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
import { parseProgress } from "../../src/renderer/progress";
import type { IterationView, TokenTotals, ActivityEntry, Task, SchedulerState, PromoteResponse } from "../../src/shared/types";

const schedState = (over: Partial<SchedulerState> = {}): SchedulerState =>
    ({ paused: false, perProject: [{ projectId: "p1", running: 2, cap: 3 }], ...over });

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

    it("PROBE: a queued or merged card does NOT surface Drop in (data-verify-dropin=\"false\")", () => {
        const queued = renderToStaticMarkup(<BoardCard task={task({ status: "queued" })} onDropIn={() => {}} onStartFresh={() => {}} />);
        expect(queued).not.toContain(">Drop in<");
        expect(queued).toContain('data-verify-dropin="false"');
        const merged = renderToStaticMarkup(<BoardCard task={task({ status: "merged" })} onDropIn={() => {}} />);
        expect(merged).not.toContain(">Drop in<");
        expect(merged).toContain('data-verify-dropin="false"');
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
