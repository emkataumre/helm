// tests/verify/jail/surface.ts
// The M13 Docker-jail verify SURFACE. Drives the REAL units three ways and distils one flat JailRecording
// the invariants read (the guards-slice pattern):
//   • buildJailPlan (the pure planner) → the plan's mounts/argv/env-file lines (origin-unreachable + exchange-only-mount)
//   • runTaskLoop in JAIL mode with recording deps → the cwd every gate ran with (gates-run-host-side)
//   • spawnAgent in HOST mode with a fake exec → the (command, args) the chokepoint launches (jail-opt-in-host-default)
// No real docker ever runs — spawnAgent is faked inside the loop, and the standalone spawn uses a fake exec.
import { buildJailPlan, allowedMountTargets, type JailSpec, type JailClaudeArgs } from "../../../src/main/engine/jail";
import { spawnAgent } from "../../../src/main/engine/spawn";
import { runTaskLoop, type RunTaskDeps } from "../../../src/main/engine/runTask";
import type { ExecFn } from "../../../src/main/engine/exec";
import type { LoopConfig } from "../../../src/main/engine/loopConfig";
import type { Project, Task, TokenTotals } from "../../../src/shared/types";

const ZERO: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };

// The one flat recording. Each producer populates only the fields it observes; an invariant whose fields are
// absent simply holds (N/A), exactly like the guards slice — a probe then populates the field with a lie.
export interface JailRecording {
    unit: "jail";
    plan?: { mounts: string[]; argv: string[]; envFileLines: string[]; allowedTargets: string[] };
    gateCwds?: string[];        // the cwd runCheck + runAcceptance ran with (must be the HOST worktree)
    hostWorktree?: string;      // what createWorktree returned — the host worktree the gates must use
    hostSpawn?: { command: string; args: string[] }; // the host-mode chokepoint launch (must be `claude`, no docker)
}

// ── #1 origin-unreachable + #3 exchange-only-mount: the REAL buildJailPlan ────────────────────────────────
const mkSpec = (over: Partial<JailSpec> = {}): JailSpec => ({
    image: "helm-jail:latest", taskId: "t1", taskBranch: "ralph/task-t1",
    exchangeHostPath: "C:/Users/x/AppData/Roaming/helm/jail-exchange/t1.git",
    setupCommand: "npm ci",
    ralph: { instructions: "# ritual\n", task: "# task\nDo it.\n", progress: "# progress\n" },
    envFilePath: "C:/Users/x/AppData/Roaming/helm/jail-exchange/t1.env",
    ...over,
});
const mkClaude = (over: Partial<JailClaudeArgs> = {}): JailClaudeArgs => ({
    prompt: "/goal make the check green", sessionId: "sess-1",
    settings: '{"permissions":{"deny":["Bash(git push:*)","Bash(git remote set-url:*)"]}}',
    ...over,
});
export function realPlanRecording(): JailRecording {
    const plan = buildJailPlan(mkSpec(), mkClaude());
    return { unit: "jail", plan: { mounts: plan.mounts, argv: plan.argv, envFileLines: plan.envFileLines, allowedTargets: allowedMountTargets() } };
}

// ── #2 gates-run-host-side: the REAL loop in JAIL mode, capturing every gate's cwd ────────────────────────
const HOST_WT = "/repo/.helm/worktrees/ralph-task-t1";
const mkProject = (): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm run check", worktreeDir: ".helm/worktrees", setupCommand: null,
    iterationCap: null, noProgressK: null, stallTimeoutMin: null, costCapUsd: null, model: null, concurrencyCap: null,
    terminalCommand: null, autoModeEnvironment: null, promotionMode: "pr", jailImage: "helm-jail:latest",
});
const mkTask = (): Task => ({
    id: "t1", projectId: "p1", title: "T", intent: "do", acceptance: ["run the proof"], status: "queued", scopeHint: null,
    dependsOn: [], planId: null, branchName: null, worktreePath: null, diffstat: null, failureReason: null, createdAt: 0, updatedAt: 0,
});
const TEST_CONFIG: LoopConfig = { iterationCap: 8, noProgressK: 2, denyWallK: 3, costCapUsd: 1000, stallTimeoutMs: 1000, checkTimeoutMs: 1000 };

export async function realLoopGateRecording(): Promise<JailRecording> {
    const gateCwds: string[] = [];
    const deps: RunTaskDeps = {
        ensureBranch: async () => {}, checkoutBranch: async () => {},
        createWorktree: async () => HOST_WT, removeWorktree: async () => {},
        ensureRalphExcluded: () => {}, writeRalphFiles: () => {},
        runSetup: async () => ({ ok: true, output: "" }),
        // Faked spawn — the edge would inject opts.jail here in prod, but the loop is agnostic; no docker runs.
        spawnAgent: async () => ({ ok: true, output: "did work", sessionId: "s", stalled: false, usage: ZERO, durationMs: null, deniedCommands: [] }),
        commitAll: async () => {}, headSha: async () => "sha1",
        // The GATES record their cwd — the invariant asserts it is the HOST worktree, never a container path.
        runCheck: async (wt) => { gateCwds.push(wt); return { green: true, timedOut: false, output: "" }; },
        runAcceptance: async (wt) => { gateCwds.push(wt); return { ok: true, output: "" }; },
        squashMergeInto: async () => ({ merged: true, conflict: false }), diffStat: async () => "+1 -0",
        mergeStage: async () => ({ outcome: "merged", diffstat: "+1 -0" }),
        setStatus: () => {}, addIteration: () => ({ id: "it" }), finishIteration: () => {},
        // JAIL mode: the exchange sync is present (a real run would push/fetch the host worktree ↔ exchange).
        jailSync: { prepare: async () => {}, syncIn: async () => {}, syncOut: async () => {} },
        reapJail: async () => {},
        log: () => {},
    };
    await runTaskLoop(mkProject(), mkTask(), TEST_CONFIG, deps);
    return { unit: "jail", gateCwds, hostWorktree: HOST_WT };
}

// ── #4 jail-opt-in-host-default: the REAL host-mode spawn (opts.jail ABSENT) → the launched (command, args) ─
export async function realHostSpawnRecording(): Promise<JailRecording> {
    let command = ""; let args: string[] = [];
    const exec: ExecFn = async (cmd, a = []) => { command = cmd; args = a; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
    await spawnAgent("/wt", "/goal x", { settings: '{"permissions":{"deny":["Bash(git push:*)"]}}' }, exec); // NO jail → host mode
    return { unit: "jail", hostSpawn: { command, args } };
}
