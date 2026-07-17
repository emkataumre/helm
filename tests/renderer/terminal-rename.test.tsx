// tests/renderer/terminal-rename.test.tsx
// Session auto-naming + manual override. A task-bound terminal defaults its Helm-side label
// to the task title; a manual rename overrides it; the underlying claude session id is the
// stable resume key and is NEVER touched by either. Labels are pure presentation resolved
// in the renderer (sessionLabel) — same static-markup harness as components.test.tsx.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ActionCtx, type CockpitActions, type TaskVM } from "../../src/renderer/views/helpers";
import { sessionLabel, TerminalsView } from "../../src/renderer/views/Terminals";
import type { Project, PtySessionInfo } from "../../src/shared/types";

const noop = () => { /* render-only */ };
const STUB_ACTIONS: CockpitActions = {
    openTask: noop, openPlan: noop, startNow: noop, dropIn: noop, startFresh: noop,
    resume: noop, verifyMerge: noop, abandon: noop, clearDeps: noop, openShell: noop,
};
const render = (el: ReactElement): string =>
    renderToStaticMarkup(<ActionCtx.Provider value={STUB_ACTIONS}>{el}</ActionCtx.Provider>);

const vm = (over: Partial<TaskVM> = {}): TaskVM => ({
    id: "t1", projectId: "p", title: "Ship the auto-namer", intent: "Do it", acceptance: ["npm test"],
    status: "running", scopeHint: null, dependsOn: [], planId: null, branchName: null,
    worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
    resumable: false, blocked: false, waitingOn: [], snap: null, validating: false, ...over,
});
const project = (over: Partial<Project> = {}): Project => ({
    id: "p", name: "alpha", repoPath: "C:\\repo", integrationBranch: "integration/ralph",
    targetBranch: "main", branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null,
    model: null, concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null,
    promotionMode: "pr", jailImage: null, conductorSessionId: null, ...over,
});

// the raw PTY title is deliberately unlike the task title, so any leak of it into a
// task-bound tab label is visible in the markup assertions below
const taskSession = (over: Partial<PtySessionInfo> = {}): PtySessionInfo =>
    ({ id: "sess-abc", kind: "dropin", title: "pty-raw-title", cwd: "C:\\wt", taskId: "t1", alive: true, ...over });
const freeSession = (over: Partial<PtySessionInfo> = {}): PtySessionInfo =>
    ({ id: "sess-free", kind: "free", title: "alpha — shell", cwd: "C:\\repo", alive: true, ...over });

const tasksById = { t1: vm() };
const props = { activeId: "sess-abc", onSelect: noop, onKill: noop, onNewShell: noop, projects: [project()], tasksById };

describe("sessionLabel (the renderer-side label resolver)", () => {
    it("defaults a task-bound session's label to the task title", () => {
        expect(sessionLabel(taskSession(), tasksById)).toBe("Ship the auto-namer");
    });
    it("PROBE: an un-overridden task-bound label NOT matching the task title MUST FAIL", () => {
        // the default label IS the task title — the raw pty title must not win
        const label = sessionLabel(taskSession(), tasksById, {});
        expect(label).toBe(tasksById.t1.title);
        expect(label).not.toBe(taskSession().title);
    });
    it("a manual override wins over the task title", () => {
        expect(sessionLabel(taskSession(), tasksById, { "sess-abc": "my pet name" })).toBe("my pet name");
    });
    it("a free session keeps its own sensible default and is still renamable", () => {
        expect(sessionLabel(freeSession(), tasksById)).toBe("alpha — shell");
        expect(sessionLabel(freeSession(), tasksById, { "sess-free": "scratch" })).toBe("scratch");
    });
    it("a blank/whitespace override falls back to the default (clearing the field = un-rename)", () => {
        expect(sessionLabel(taskSession(), tasksById, { "sess-abc": "   " })).toBe("Ship the auto-namer");
    });
    it("an unknown taskId falls back to the pty title (never crashes, never blank)", () => {
        expect(sessionLabel(taskSession({ taskId: "gone" }), tasksById)).toBe("pty-raw-title");
    });
});

describe("TerminalsView label contract (auto-name + manual override, id untouched)", () => {
    it("a task-bound terminal renders the task title as its tab label and stamps it", () => {
        const html = render(<TerminalsView sessions={[taskSession()]} {...props} />);
        expect(html).toContain('data-verify-label="Ship the auto-namer"');
        expect(html).toContain('data-verify-overridden="false"');
        expect(html).toContain("Ship the auto-namer");
        // the session ID stays the stable resume key — stamped, unrenamed
        expect(html).toContain('data-verify-active="sess-abc"');
        expect(html).toContain('data-verify-session="sess-abc"');
    });
    it("PROBE: the raw pty title must NOT be the task-bound label — it survives only as the hover tooltip", () => {
        const html = render(<TerminalsView sessions={[taskSession()]} {...props} />);
        expect(html).not.toContain('data-verify-label="pty-raw-title"');   // the view's label stamp is the task title
        expect(html).not.toContain('data-verify-title="pty-raw-title"');   // the pane's display name is the label too
        expect(html).toContain('title="pty-raw-title"');                   // discoverable on hover — not the label
    });
    it("a manual override renders the overridden name — and the session id is unaffected", () => {
        const html = render(<TerminalsView sessions={[taskSession()]} {...props} renames={{ "sess-abc": "my pet name" }} />);
        expect(html).toContain('data-verify-label="my pet name"');
        expect(html).toContain('data-verify-overridden="true"');
        expect(html).toContain("my pet name");
        expect(html).not.toContain("data-verify-label=\"Ship the auto-namer\"");
        // rename is Helm-side presentation only: the id under the pane is still the resume key
        expect(html).toContain('data-verify-active="sess-abc"');
        expect(html).toContain('data-verify-session="sess-abc"');
    });
    it("the active session exposes an editable rename field pre-filled with its label", () => {
        const html = render(<TerminalsView sessions={[taskSession()]} {...props} />);
        expect(html).toContain('aria-label="Rename session"');
        expect(html).toMatch(/<input[^>]*value="Ship the auto-namer"/);
        const overridden = render(<TerminalsView sessions={[taskSession()]} {...props} renames={{ "sess-abc": "my pet name" }} />);
        expect(overridden).toMatch(/<input[^>]*value="my pet name"/);
    });
    it("a free terminal keeps its default label and the rename field", () => {
        const html = render(<TerminalsView sessions={[freeSession()]} {...props} activeId="sess-free" />);
        expect(html).toContain('data-verify-label="alpha — shell"');
        expect(html).toContain('aria-label="Rename session"');
    });
});
