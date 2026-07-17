// tests/verify/preflight/surface.ts
// The M11 verify SURFACE. Drives the REAL runPreflight (over recording fake deps that stand in for git/exec) +
// the REAL approvalPermitted, and distils a flat PreflightRecording the invariants read. The "real unit" is the
// pre-flight stage + its approve-decision core; the fakes only script each command's outcome deterministically.
// Complementary to, and separate from, the untouched M2–M10 slices.
//
// Non-circularity: each scenario DECLARES its ground truth (each command's scripted exit + static level; which
// warns the human acked) independently of the stage. The invariants then compare the stage's ACTUAL behaviour —
// the recorded git ops, the classified verdicts, the worktree lifecycle, and the real approve decision — against
// that declared truth. A lie (a misclassification, a leaked worktree, an approval past an unacked warn) is caught.
import { runPreflight, approvalPermitted, type PreflightDeps } from "../../../src/main/engine/preflight";
import type { Project, PlanDraft, PlanDraftTask, PreflightVerdict, PreflightReport, PreflightLevel } from "../../../src/shared/types";

const INTEGRATION_SHA = "abcdef0123456789abcdef0123456789abcdef01"; // short = abcdef012345

export const mkProject = (over: Partial<Project> = {}): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: null, conductorSessionId: null, ...over,
});

// One command the scenario controls: its scripted exit, its static level (the missing-script cross-check),
// its declared ROLE (the 2026-07-14 vocabulary — null/absent = untagged legacy), and whether the exec throws
// (to prove cleanup-on-throw). `ack` marks it as acknowledged by the human.
export interface CmdSpec {
    command: string;
    code: number;
    timedOut?: boolean;
    output?: string;
    staticLevel?: "ok" | "warn"; // M10 static verdict for this command (default ok)
    suggestion?: string;
    role?: "proof" | "regression"; // declared role (absent = untagged/legacy)
    throws?: boolean;
    ack?: boolean;
}
export interface Scenario { commands: CmdSpec[]; setupCommand?: string | null; setupOk?: boolean }

// One recorded verdict — the classified level plus the ground truth it must be faithful to.
export interface VerdictRecord { command: string; level: PreflightLevel; code: number; timedOut: boolean; staticWarn: boolean; role: "proof" | "regression" | null }

// The flat recording the invariants read.
export interface PreflightRecording {
    unit: "preflight";
    ops: string[];               // ordered git/exec surface: ensure-branch / rev-parse / create-worktree / setup / run:<cmd> / remove-worktree
    worktreeCreated: boolean;
    worktreeRemoved: boolean;
    threw: boolean;              // runPreflight rejected mid-run (a scripted throw)
    blocked: boolean;            // setup failed → the report is BLOCKED (no verdicts, nothing observed)
    rolesDeclared: boolean;      // ground truth: the scenario declared a role somewhere (legacy drafts: false)
    taskHasProof: boolean;       // ground truth: the (single) task declared at least one proof command
    noProofWarned: boolean;      // the report contains the synthetic warn-no-proof for the task
    verdicts: VerdictRecord[];   // real command verdicts only (synthetic no-proof lines are recorded above)
    acks: string[];
    approved: boolean;           // the REAL approvalPermitted(report, acks)
}

// Drive the REAL stage over a scenario, run the REAL approve decision, and distil the recording.
export async function runScenario(scenario: Scenario): Promise<PreflightRecording> {
    const specs = scenario.commands;
    const draftTasks: PlanDraftTask[] = [{
        slug: "t1", title: "T1", intent: "i",
        acceptance: specs.map((s) => s.command),
        acceptanceRoles: specs.map((s) => s.role ?? null),
        scopeHint: null, dependsOn: [],
    }];
    const draft: PlanDraft = { planTitle: "d", tasks: draftTasks };
    const staticVerdicts: PreflightVerdict[] = specs.map((s) => ({
        taskSlug: "t1", command: s.command, level: (s.staticLevel ?? "ok"),
        ...(s.suggestion ? { suggestion: s.suggestion } : {}),
    }));

    const ops: string[] = [];
    let worktreeCreated = false, worktreeRemoved = false;
    // The fake repo starts FRESH (no integration branch — the M10-acceptance reality): revParse throws unless
    // ensureBranch ran first, so every positive scenario structurally proves the ensure-before-read ordering.
    let integrationEnsured = false;
    const deps: PreflightDeps = {
        ensureBranch: async () => { ops.push("ensure-branch"); integrationEnsured = true; },
        revParse: async () => {
            if (!integrationEnsured) throw new Error("fatal: integration branch does not exist (fresh repo)");
            ops.push("rev-parse"); return INTEGRATION_SHA;
        },
        createWorktree: async () => { ops.push("create-worktree"); worktreeCreated = true; return "/repo/.helm/worktrees/preflight"; },
        runSetup: async () => { ops.push("setup"); return { ok: scenario.setupOk !== false, output: scenario.setupOk === false ? "setup boom" : "" }; },
        runCommand: async (_wt, command) => {
            ops.push(`run:${command}`);
            const s = specs.find((x) => x.command === command)!;
            if (s.throws) throw new Error(`exec blew up on ${command}`);
            return { code: s.code, timedOut: s.timedOut ?? false, output: s.output ?? "" };
        },
        removeWorktree: async () => { ops.push("remove-worktree"); worktreeRemoved = true; },
        checkTimeoutMs: 1000,
    };

    const project = mkProject(scenario.setupCommand !== undefined ? { setupCommand: scenario.setupCommand } : {});
    let report: PreflightReport = { ran: false, verdicts: [], warnCount: 0 };
    let threw = false;
    try {
        report = await runPreflight(project, draft, staticVerdicts, deps);
    } catch { threw = true; }

    const acks = specs.filter((s) => s.ack).map((s) => s.command);
    // Real command verdicts map back to their spec (the ground truth); the synthetic per-task no-proof
    // line is recorded as a flag (it has no spec — it's a draft-shape judgement, not a command run).
    const verdicts: VerdictRecord[] = report.verdicts.filter((v) => v.level !== "warn-no-proof").map((v) => {
        const spec = specs.find((s) => s.command === v.command)!;
        return { command: v.command, level: v.level, code: v.exitCode ?? spec.code, timedOut: spec.timedOut ?? false, staticWarn: spec.staticLevel === "warn", role: spec.role ?? null };
    });
    const approved = approvalPermitted(report, acks);

    return {
        unit: "preflight", ops, worktreeCreated, worktreeRemoved, threw,
        blocked: report.blocked != null,
        rolesDeclared: specs.some((s) => s.role != null),
        taskHasProof: specs.some((s) => s.role === "proof"),
        noProofWarned: report.verdicts.some((v) => v.level === "warn-no-proof"),
        verdicts, acks, approved,
    };
}

// ── Scenarios ───────────────────────────────────────────────────────────────────────────────────────
const red = (command: string): CmdSpec => ({ command, code: 1, output: "1 failing\nexpected true got false", staticLevel: "ok" });
const green = (command: string): CmdSpec => ({ command, code: 0, output: "all green", staticLevel: "ok" });
const missing = (command: string, suggestion?: string): CmdSpec => ({ command, code: 1, output: 'npm error Missing script', staticLevel: "warn", suggestion });

// Every command is a legit TDD-red (ok-red) — no warns, approval is free.
export const allRed = (): Scenario => ({ commands: [red("npm run verify:a"), red("npm run verify:b")] });
// A mix of the three legacy flavours; the two warns are ACKED → approval permitted.
export const mixedAllAcked = (): Scenario => ({ commands: [red("npm run verify:x"), { ...green("npm run check"), ack: true }, { ...missing("npm run verify:nope", "verify:x"), ack: true }] });
// Same mix, but the human acked NOTHING → approval must be refused.
export const mixedNoneAcked = (): Scenario => ({ commands: [red("npm run verify:x"), green("npm run check"), missing("npm run verify:nope", "verify:x")] });
// A command throws mid-run → the stage rejects, but the worktree is still cleaned up.
export const throwsMidRun = (): Scenario => ({ commands: [{ command: "npm run boom", code: 0, throws: true, staticLevel: "ok" }] });

// ── Role-aware scenarios (the 2026-07-14 vocabulary) ────────────────────────────────────────────────
// The equilibrium fix in miniature: a green REGRESSION suite + a missing PROOF + a red PROOF — zero warns,
// approval free with zero acks (the noise-collapse cure; pre-overhaul this draft was 100% ackable warns).
export const rolesHappy = (): Scenario => ({ commands: [
    { command: "npm run check", code: 0, output: "all green", staticLevel: "ok", role: "regression" },
    { command: "npm run verify:new", code: 1, output: "npm error Missing script", staticLevel: "warn", role: "proof" },
    { command: "npm run verify:red", code: 1, output: "1 failing", staticLevel: "ok", role: "proof" },
] });
// A PROOF that's green pre-work — the ONE real fake-green warn; acked here → approval permitted.
export const proofFakeGreenAcked = (): Scenario => ({ commands: [
    { command: "npm run verify:x", code: 0, output: "all green", staticLevel: "ok", role: "proof", ack: true },
] });
// A REGRESSION suite red on the tip (warn-tip-red), unacked → approval refused.
export const regressionTipRed = (): Scenario => ({ commands: [
    { command: "npm run check", code: 1, output: "2 failing", staticLevel: "ok", role: "regression" },
] });
// Roles declared but the task has NO proof command → the synthetic warn-no-proof fires (unacked → refused).
export const noProofTask = (): Scenario => ({ commands: [
    { command: "npm run check", code: 0, output: "all green", staticLevel: "ok", role: "regression", ack: true },
] });
// setup fails → the report is BLOCKED: no verdicts, nothing observed, approval impossible.
export const blockedSetup = (): Scenario => ({ setupCommand: "npm ci", setupOk: false, commands: [green("npm run check")] });
