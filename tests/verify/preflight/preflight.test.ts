// tests/verify/preflight/preflight.test.ts
// M11 Task 1 — the verdict CLASSIFICATION TABLE, driven test-first over the REAL runPreflight with recording
// fake deps (the promote-slice idiom: the "real unit" is runPreflight; the fakes only stand in for git/exec so
// the scenario controls each command's outcome). Task 4 EXTENDS this file with the full CI matrix + the four
// declared invariants and their must-FAIL probes. Runs headless under `npm run check`, zero prod footprint.
import { describe, it, expect } from "vitest";
import { runPreflight, approvalPermitted, unackedWarnCommands, type PreflightDeps } from "../../../src/main/engine/preflight";
import type { Project, PlanDraft, PlanDraftTask, PreflightVerdict, PreflightReport } from "../../../src/shared/types";

const INTEGRATION_SHA = "abcdef0123456789abcdef0123456789abcdef01";

const mkProject = (over: Partial<Project> = {}): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, ...over,
});

const task = (slug: string, acceptance: string[]): PlanDraftTask => ({ slug, title: slug, intent: "i", acceptance, scopeHint: null, dependsOn: [] });
const draftOf = (...tasks: PlanDraftTask[]): PlanDraft => ({ planTitle: "d", tasks });

// A scripted command outcome (what the fake runCommand returns for a given command) and, optionally, a throw.
interface CmdScript { code: number; timedOut?: boolean; output?: string; throws?: boolean }

interface Recorder {
    ops: string[];                 // ordered op log: ensure-branch / create-worktree / setup / run:<cmd> / remove-worktree
    ensuredBranch: string | null;
    ensuredFrom: string | null;
    createdBranch: string | null;
    createdFrom: string | null;
    removedKeepBranch: boolean | null;
    deps: PreflightDeps;
}

// Build recording fake deps. `scripts` maps a command → its scripted outcome; `setupOk` controls runSetup.
// The fake repo is FRESH (integration branch absent — the M10-acceptance reality): revParse throws unless
// ensureBranch ran first, so every test here structurally proves the ensure-before-read ordering.
function recorder(scripts: Record<string, CmdScript>, opts: { setupOk?: boolean } = {}): Recorder {
    const rec: Recorder = { ops: [], ensuredBranch: null, ensuredFrom: null, createdBranch: null, createdFrom: null, removedKeepBranch: null, deps: null as unknown as PreflightDeps };
    rec.deps = {
        ensureBranch: async (_repo, branch, from) => { rec.ops.push("ensure-branch"); rec.ensuredBranch = branch; rec.ensuredFrom = from; },
        revParse: async () => {
            if (rec.ensuredBranch == null) throw new Error("fatal: integration branch does not exist (fresh repo)");
            return INTEGRATION_SHA;
        },
        createWorktree: async (_repo, from, branch) => { rec.ops.push("create-worktree"); rec.createdFrom = from; rec.createdBranch = branch; return "/repo/.helm/worktrees/preflight"; },
        runSetup: async () => { rec.ops.push("setup"); return { ok: opts.setupOk !== false, output: opts.setupOk === false ? "setup boom" : "" }; },
        runCommand: async (_wt, command) => {
            rec.ops.push(`run:${command}`);
            const s = scripts[command] ?? { code: 1, output: "no script for this command" };
            if (s.throws) throw new Error(`exec blew up on ${command}`);
            return { code: s.code, timedOut: s.timedOut ?? false, output: s.output ?? "" };
        },
        removeWorktree: async (_repo, _path, _branch, keepBranch) => { rec.ops.push("remove-worktree"); rec.removedKeepBranch = keepBranch; },
        checkTimeoutMs: 1000,
    };
    return rec;
}

const green = (): CmdScript => ({ code: 0, output: "all good" });
const red = (): CmdScript => ({ code: 1, output: "1 test failed\nexpected true got false" });
const missing = (): CmdScript => ({ code: 1, output: 'npm error Missing script: "verify:nope"' });

const levelOf = (report: PreflightReport, command: string) => report.verdicts.find((v) => v.command === command)?.level;

describe("verify/preflight Task 1: the verdict classification table (REAL runPreflight)", () => {
    it("a non-zero exit with real output on a STATIC-OK command → ok-red (the expected TDD-red gate)", async () => {
        const project = mkProject();
        const draft = draftOf(task("t1", ["npm run verify:content"]));
        const staticV: PreflightVerdict[] = [{ taskSlug: "t1", command: "npm run verify:content", level: "ok" }];
        const rec = recorder({ "npm run verify:content": red() });

        const report = await runPreflight(project, draft, staticV, rec.deps);

        expect(report.ran).toBe(true);
        expect(levelOf(report, "npm run verify:content")).toBe("ok-red");
        const v = report.verdicts[0];
        expect(v.exitCode).toBe(1);
        expect(v.tail).toContain("expected true got false"); // the failure tail is captured as evidence
        expect(report.warnCount).toBe(0);                     // ok-red never needs an ack
    });

    it("builds the throwaway worktree OFF THE INTEGRATION TIP and always removes it (branch, not kept)", async () => {
        const rec = recorder({ "npm run check": green() });
        await runPreflight(mkProject(), draftOf(task("t1", ["npm run check"])), [{ taskSlug: "t1", command: "npm run check", level: "ok" }], rec.deps);

        expect(rec.createdFrom).toBe("integration/ralph");
        expect(rec.createdBranch).toMatch(/^helm\/preflight-p1-/);
        expect(rec.removedKeepBranch).toBe(false);            // the temp branch is deleted on cleanup
        expect(rec.ops).toEqual(["ensure-branch", "create-worktree", "run:npm run check", "remove-worktree"]);
    });

    it("on a FRESH project (no integration branch yet) it creates it off the TARGET before reading its tip", async () => {
        // The M10-acceptance regression: revParse on a never-ran project threw and the rail hung on "loading".
        // The recorder's revParse throws unless ensureBranch ran first, so resolving AT ALL proves the ordering.
        const rec = recorder({ "npm run verify:content": red() });
        const report = await runPreflight(mkProject(), draftOf(task("t1", ["npm run verify:content"])), [{ taskSlug: "t1", command: "npm run verify:content", level: "ok" }], rec.deps);
        expect(report.ran).toBe(true);
        expect(rec.ensuredBranch).toBe("integration/ralph");
        expect(rec.ensuredFrom).toBe("main");                 // created off exactly the tip the first task will branch from
        expect(rec.ops[0]).toBe("ensure-branch");
    });

    it("PreflightDeps is structurally never-advance — it exposes no advanceBranch / pushBranch seam", () => {
        // A compile-time + shape guard mirroring promote's never-push: the surface the engine hands runPreflight
        // simply cannot advance or push a ref. (If someone adds such a fn to PreflightDeps, this fails loudly.)
        // ensureBranch is deliberately present: create-if-absent only, it cannot move an existing ref.
        const rec = recorder({});
        expect(Object.keys(rec.deps).sort()).toEqual(
            ["checkTimeoutMs", "createWorktree", "ensureBranch", "removeWorktree", "revParse", "runCommand", "runSetup"],
        );
    });

    it("exit 0 (already passes before any work) → warn-already-green, and it counts as a warn", async () => {
        const rec = recorder({ "npm run check": green() });
        const report = await runPreflight(mkProject(), draftOf(task("t1", ["npm run check"])), [{ taskSlug: "t1", command: "npm run check", level: "ok" }], rec.deps);
        expect(levelOf(report, "npm run check")).toBe("warn-already-green");
        expect(report.warnCount).toBe(1);
        expect(report.verdicts[0].tail).toContain("all good"); // carries its evidence
    });

    it("a missing npm script (non-zero, but STATIC-WARN) → warn-missing, carrying the static did-you-mean", async () => {
        const cmd = "npm run verify:nope";
        const rec = recorder({ [cmd]: missing() });
        const staticV: PreflightVerdict[] = [{ taskSlug: "t1", command: cmd, level: "warn", reason: 'no npm script "verify:nope" in package.json', suggestion: "verify:content" }];
        const report = await runPreflight(mkProject(), draftOf(task("t1", [cmd])), staticV, rec.deps);
        expect(levelOf(report, cmd)).toBe("warn-missing");
        expect(report.verdicts[0].suggestion).toBe("verify:content"); // cross-checked from the static verdict
        expect(report.warnCount).toBe(1);
    });

    it("dedupes a command shared across tasks: ONE run, verdict fanned back to every referencing slug", async () => {
        const rec = recorder({ "npm run check": red(), "npm run build": green() });
        const staticV: PreflightVerdict[] = [
            { taskSlug: "t1", command: "npm run check", level: "ok" },
            { taskSlug: "t2", command: "npm run check", level: "ok" },
            { taskSlug: "t2", command: "npm run build", level: "ok" },
        ];
        const draft = draftOf(task("t1", ["npm run check"]), task("t2", ["npm run check", "npm run build"]));
        const report = await runPreflight(mkProject(), draft, staticV, rec.deps);

        // `npm run check` ran exactly once despite two tasks referencing it.
        expect(rec.ops.filter((o) => o === "run:npm run check")).toHaveLength(1);
        const check = report.verdicts.find((v) => v.command === "npm run check")!;
        expect(check.taskSlugs).toEqual(["t1", "t2"]); // fanned to both
        expect(report.verdicts).toHaveLength(2);        // one verdict per DISTINCT command
    });

    it("cleans up the throwaway worktree even when a command THROWS mid-run", async () => {
        const rec = recorder({ "npm run boom": { code: 0, throws: true } });
        await expect(runPreflight(mkProject(), draftOf(task("t1", ["npm run boom"])), [], rec.deps)).rejects.toThrow();
        expect(rec.ops).toContain("remove-worktree"); // finally-cleanup fired despite the throw
        expect(rec.removedKeepBranch).toBe(false);
    });

    it("a project setupCommand that FAILS → every command is unverifiable (warn-missing), no command spawned", async () => {
        const rec = recorder({ "npm run check": green() }, { setupOk: false });
        const report = await runPreflight(mkProject({ setupCommand: "npm ci" }), draftOf(task("t1", ["npm run check"])), [{ taskSlug: "t1", command: "npm run check", level: "ok" }], rec.deps);
        expect(levelOf(report, "npm run check")).toBe("warn-missing");
        expect(report.verdicts[0].exitCode).toBeNull();
        expect(rec.ops).not.toContain("run:npm run check"); // never ran the command in a broken env
        expect(rec.ops).toContain("remove-worktree");
    });
});

describe("verify/preflight Task 1: the pure approve-decision core (acks by command)", () => {
    const reportWith = (verdicts: PreflightReport["verdicts"]): PreflightReport => ({ ran: true, verdicts, warnCount: verdicts.filter((v) => v.level !== "ok-red").length });
    const warn = (command: string): PreflightReport["verdicts"][number] => ({ command, taskSlugs: ["t"], level: "warn-already-green", exitCode: 0, tail: "" });
    const okRed = (command: string): PreflightReport["verdicts"][number] => ({ command, taskSlugs: ["t"], level: "ok-red", exitCode: 1, tail: "" });

    it("an unacked warn blocks approval; acking every warn permits it", () => {
        const report = reportWith([okRed("a"), warn("b"), warn("c")]);
        expect(approvalPermitted(report, [])).toBe(false);
        expect(unackedWarnCommands(report, [])).toEqual(["b", "c"]);
        expect(approvalPermitted(report, ["b"])).toBe(false);
        expect(approvalPermitted(report, ["b", "c"])).toBe(true);
        expect(unackedWarnCommands(report, ["b", "c"])).toEqual([]);
    });

    it("a report with no warns permits approval with no acks (ok-red alone never blocks)", () => {
        expect(approvalPermitted(reportWith([okRed("a")]), [])).toBe(true);
    });
});

// ── Task 4: the full verify slice (surface / invariants / fixtures / runner) — the CI matrix ────────────
import { runPreflightFixture, runAll, type Verdict } from "./runner";
import { PREFLIGHT_INVARIANTS, runPreflightInvariants } from "./invariants";
import { PREFLIGHT_FIXTURES } from "./fixtures";
import { runScenario, mixedAllAcked, throwsMidRun, type PreflightRecording } from "./surface";

const failed = (r: PreflightRecording) => runPreflightInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/preflight: the CI matrix over every fixture", () => {
    it.each(PREFLIGHT_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runPreflightFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(PREFLIGHT_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("declares a must-FAIL probe for EACH declared invariant", () => {
        const probed = new Set(PREFLIGHT_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...probed].sort()).toEqual(PREFLIGHT_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(PREFLIGHT_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runScenario(mixedAllAcked());
        expect(runPreflightInvariants(rec).map((r) => r.name).sort()).toEqual(PREFLIGHT_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/preflight: the recording is the REAL stage's behaviour", () => {
    it("mixed run (all warns acked): faithful verdicts, worktree cleaned, approval permitted, no ref touched", async () => {
        const rec = await runScenario(mixedAllAcked());
        expect(rec.ops).toEqual(["ensure-branch", "rev-parse", "create-worktree", "run:npm run verify:x", "run:npm run check", "run:npm run verify:nope", "remove-worktree"]);
        expect(rec.verdicts.map((v) => v.level)).toEqual(["ok-red", "warn-already-green", "warn-missing"]);
        expect(rec.worktreeCreated && rec.worktreeRemoved).toBe(true);
        expect(rec.approved).toBe(true);
        expect(failed(rec)).toEqual([]);
    });

    it("a scripted mid-run throw still cleans up the throwaway (created ∧ removed), invariants hold", async () => {
        const rec = await runScenario(throwsMidRun());
        expect(rec.threw).toBe(true);
        expect(rec.worktreeCreated && rec.worktreeRemoved).toBe(true);
        expect(failed(rec)).toEqual([]);
    });
});

describe("verify/preflight: negative controls — each broken recording FAILS its named invariant", () => {
    it("a ref-advancing op FAILS preflight-never-advances-refs", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "advances-a-ref");
        expect(fx?.probe && failed(fx.recording)).toContain("preflight-never-advances-refs");
    });
    it("an exit-0 classified ok-red FAILS verdict-classification-faithful", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "green-classified-red");
        expect(fx?.probe && failed(fx.recording)).toContain("verdict-classification-faithful");
    });
    it("a missing-script classified ok-red FAILS verdict-classification-faithful", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "missing-classified-red");
        expect(fx?.probe && failed(fx.recording)).toContain("verdict-classification-faithful");
    });
    it("approving with an unacked warn FAILS approve-requires-acks", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "approved-with-unacked-warn");
        expect(fx?.probe && failed(fx.recording)).toContain("approve-requires-acks");
    });
    it("a leaked worktree FAILS worktree-always-cleaned", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "leaked-worktree");
        expect(fx?.probe && failed(fx.recording)).toContain("worktree-always-cleaned");
    });
    it("reading the tip without ensuring the branch FAILS integration-ensured-before-read", () => {
        const fx = PREFLIGHT_FIXTURES.find((f) => f.id === "reads-tip-without-ensuring");
        expect(fx?.probe && failed(fx.recording)).toContain("integration-ensured-before-read");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as PreflightRecording; // property access throws inside predicates
        const results = runPreflightInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
