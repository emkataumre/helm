// src/main/engine/runTask.ts
import type { Project, Task, TaskStatus, IterationVerdict, SnapshotEvent, TokenTotals } from "../../shared/types";
import type { LoopConfig } from "./loopConfig";
import { buildGoalPrompt, buildInstructions, seedProgress } from "./prompt";

// Re-export so the reducer, the loop, and the M2 verify slice (which imports it from here) share
// the single definition now living in shared/types.ts.
export type { IterationVerdict };

export interface RunTaskDeps {
    ensureBranch: (repo: string, name: string, from: string) => Promise<void>;
    checkoutBranch: (repo: string, name: string) => Promise<void>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    ensureRalphExcluded: (repo: string) => void;
    writeRalphFiles: (worktreePath: string, files: { instructions: string; progress: string }) => void;
    runSetup: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
    spawnAgent: (worktreePath: string, prompt: string, opts: { model?: string; idleTimeoutMs?: number; iterationIndex?: number; onEvent?: (e: SnapshotEvent) => void }) => Promise<{ ok: boolean; output: string; sessionId: string | null; stalled: boolean; usage: TokenTotals; durationMs: number | null }>;
    commitAll: (repo: string, message: string) => Promise<void>;
    headSha: (repo: string) => Promise<string>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    runAcceptance: (worktreePath: string, commands: string[], timeoutMs: number) => Promise<{ ok: boolean; failedCommand?: string; output: string }>;
    squashMergeInto: (repo: string, taskBranch: string, target: string) => Promise<{ merged: boolean; conflict: boolean }>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    setStatus: (taskId: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string }) => void;
    addIteration: (taskId: string, index: number) => { id: string };
    finishIteration: (id: string, patch: { gateVerdict: "green" | "failed" | "hang"; outputTail: string; commitSha?: string | null; sessionId?: string | null; inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null; costUsd?: number | null; durationMs?: number | null }) => void;
    emit?: (e: SnapshotEvent) => void; // feeds the live EngineSnapshot; absent → no-op (e.g. the M2 slice)
    log: (msg: string) => void;
}

export interface IterationOutcome {
    verdict: IterationVerdict;
    gateOutput: string;   // failing layer's output tail (empty on green)
    commitSha: string;    // worktree HEAD after this iteration's commit
    sessionId: string | null;
    usage: TokenTotals;   // this iteration's token totals (from spawn's result event)
    durationMs: number | null;
}

const TAIL = 1500;
const tail = (s: string): string => (s.length > TAIL ? `…(truncated)\n${s.slice(-TAIL)}` : s);

// One attempt: spawn the /goal session, engine-commit, then the engine independently re-runs
// Layer A (check) then Layer B (acceptance). Green requires agent-ok AND check AND acceptance.
export async function runIteration(
    project: Project, task: Task,
    ctx: { index: number; worktreePath: string; branch: string; priorFailure?: string },
    config: LoopConfig, d: RunTaskDeps,
): Promise<IterationOutcome> {
    const prompt = buildGoalPrompt(project, task, ctx.priorFailure);
    // Forward spawn's translated stream events (assistant/tool-use/usage) into the live snapshot,
    // stamped with this iteration's index. project.model NULL → undefined (the CLI default).
    const agent = await d.spawnAgent(ctx.worktreePath, prompt, {
        model: project.model ?? undefined,
        idleTimeoutMs: config.stallTimeoutMs,
        iterationIndex: ctx.index,
        onEvent: (e) => d.emit?.(e),
    });
    const base = { usage: agent.usage, durationMs: agent.durationMs, sessionId: agent.sessionId };
    await d.commitAll(ctx.worktreePath, `ralph: iter ${ctx.index} — ${task.title}`);
    const commitSha = await d.headSha(ctx.worktreePath);

    if (!agent.ok) {
        return { verdict: agent.stalled ? "hang" : "failed", gateOutput: tail(agent.output), commitSha, ...base };
    }
    // The engine's authoritative gates — emit a gate event around each so the cockpit shows the phase.
    const check = await d.runCheck(ctx.worktreePath, project.checkCommand, config.checkTimeoutMs);
    d.emit?.({ type: "gate", index: ctx.index, label: check.green ? "check: passed" : `check: ${check.timedOut ? "hang" : "failed"}` });
    if (!check.green) {
        return { verdict: check.timedOut ? "hang" : "failed", gateOutput: tail(check.output), commitSha, ...base };
    }
    const acc = await d.runAcceptance(ctx.worktreePath, task.acceptance, config.checkTimeoutMs);
    d.emit?.({ type: "gate", index: ctx.index, label: acc.ok ? "acceptance: passed" : "acceptance: failed" });
    if (!acc.ok) {
        return { verdict: "failed", gateOutput: tail(`acceptance command failed: ${acc.failedCommand}\n${acc.output}`), commitSha, ...base };
    }
    return { verdict: "green", gateOutput: "", commitSha, ...base };
}

// The orchestrator: create the worktree once, seed .ralph, loop runIteration under the bounds,
// squash-merge on the first green, clean up on any terminal outcome.
export async function runTaskLoop(project: Project, task: Task, config: LoopConfig, d: RunTaskDeps): Promise<TaskStatus> {
    await d.ensureBranch(project.repoPath, project.integrationBranch, project.targetBranch);
    await d.checkoutBranch(project.repoPath, project.integrationBranch);

    const branch = `${project.branchPrefix}/task-${task.id}`;
    const worktreePath = await d.createWorktree(project.repoPath, project.integrationBranch, branch, project.worktreeDir);
    d.setStatus(task.id, "running", { branchName: branch, worktreePath });

    const terminate = async (status: TaskStatus, reason: string | undefined, keepBranch: boolean, diffstat?: string): Promise<TaskStatus> => {
        const extra: { diffstat?: string; failureReason?: string } = {};
        if (diffstat !== undefined) extra.diffstat = diffstat;
        if (reason !== undefined) extra.failureReason = reason;
        d.setStatus(task.id, status, extra);
        d.emit?.({ type: "status", status, terminalReason: reason });
        await d.removeWorktree(project.repoPath, worktreePath, branch, keepBranch);
        d.log(`task ${task.id} ${status}${reason ? `: ${reason}` : ""}`);
        return status;
    };

    // Layer B is mandatory; an empty acceptance list can never prove "done".
    if (task.acceptance.length === 0) {
        return terminate("needs-human", "no acceptance commands (Layer B is mandatory)", true);
    }

    d.ensureRalphExcluded(project.repoPath);
    d.writeRalphFiles(worktreePath, { instructions: buildInstructions(), progress: seedProgress(task) });

    // Install deps into the fresh worktree once, before any iteration. A broken setup is a config
    // error the agent can't fix, so fail fast (no spawn) — the same early-terminal shape as the
    // empty-acceptance guard. NULL setupCommand → skip.
    if (project.setupCommand) {
        const setup = await d.runSetup(worktreePath, project.setupCommand, config.checkTimeoutMs);
        if (!setup.ok) return terminate("needs-human", `setup command failed:\n${tail(setup.output)}`, true);
    }

    let priorFailure: string | undefined;
    let prevSha = await d.headSha(worktreePath); // baseSha — the worktree tip before any iteration
    let noProgress = 0;

    for (let index = 0; index < config.iterationCap; index++) {
        d.emit?.({ type: "iteration-start", index });
        const iter = d.addIteration(task.id, index);
        const o = await runIteration(project, task, { index, worktreePath, branch, priorFailure }, config, d);
        d.finishIteration(iter.id, {
            gateVerdict: o.verdict, outputTail: o.gateOutput, commitSha: o.commitSha, sessionId: o.sessionId,
            inputTokens: o.usage.input, outputTokens: o.usage.output,
            cacheReadTokens: o.usage.cacheRead, cacheCreationTokens: o.usage.cacheCreation,
            costUsd: o.usage.costUsd, durationMs: o.durationMs,
        });
        d.emit?.({ type: "iteration-end", index, verdict: o.verdict, commitSha: o.commitSha });

        if (o.verdict === "green") {
            const diffstat = await d.diffStat(project.repoPath, project.integrationBranch, branch);
            const merge = await d.squashMergeInto(project.repoPath, branch, project.integrationBranch);
            if (merge.conflict) return terminate("needs-human", "merge conflict", true);
            return terminate("merged", undefined, false, diffstat);
        }

        priorFailure = o.gateOutput;
        noProgress = o.commitSha === prevSha ? noProgress + 1 : 0;
        prevSha = o.commitSha;
        if (noProgress >= config.noProgressK) {
            return terminate("needs-human", `no progress for ${config.noProgressK} iterations`, true);
        }
    }
    return terminate("needs-human", `iteration cap reached (${config.iterationCap})`, true);
}
