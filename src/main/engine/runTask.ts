// src/main/engine/runTask.ts
import type { Project, Task, TaskStatus } from "../../shared/types";
import type { LoopConfig } from "./loopConfig";
import { buildGoalPrompt, buildInstructions, seedProgress } from "./prompt";

export interface RunTaskDeps {
    ensureBranch: (repo: string, name: string, from: string) => Promise<void>;
    checkoutBranch: (repo: string, name: string) => Promise<void>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    ensureRalphExcluded: (repo: string) => void;
    writeRalphFiles: (worktreePath: string, files: { instructions: string; progress: string }) => void;
    spawnAgent: (worktreePath: string, prompt: string, opts: { model?: string; idleTimeoutMs?: number }) => Promise<{ ok: boolean; output: string; sessionId: string | null; stalled: boolean }>;
    commitAll: (repo: string, message: string) => Promise<void>;
    headSha: (repo: string) => Promise<string>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    runAcceptance: (worktreePath: string, commands: string[], timeoutMs: number) => Promise<{ ok: boolean; failedCommand?: string; output: string }>;
    squashMergeInto: (repo: string, taskBranch: string, target: string) => Promise<{ merged: boolean; conflict: boolean }>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    setStatus: (taskId: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string }) => void;
    addIteration: (taskId: string, index: number) => { id: string };
    finishIteration: (id: string, patch: { gateVerdict: "green" | "failed" | "hang"; outputTail: string; commitSha?: string | null; sessionId?: string | null }) => void;
    log: (msg: string) => void;
}

export type IterationVerdict = "green" | "failed" | "hang";
export interface IterationOutcome {
    verdict: IterationVerdict;
    gateOutput: string;   // failing layer's output tail (empty on green)
    commitSha: string;    // worktree HEAD after this iteration's commit
    sessionId: string | null;
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
    const agent = await d.spawnAgent(ctx.worktreePath, prompt, { idleTimeoutMs: config.stallTimeoutMs });
    await d.commitAll(ctx.worktreePath, `ralph: iter ${ctx.index} — ${task.title}`);
    const commitSha = await d.headSha(ctx.worktreePath);

    if (!agent.ok) {
        return { verdict: agent.stalled ? "hang" : "failed", gateOutput: tail(agent.output), commitSha, sessionId: agent.sessionId };
    }
    const check = await d.runCheck(ctx.worktreePath, project.checkCommand, config.checkTimeoutMs);
    if (!check.green) {
        return { verdict: check.timedOut ? "hang" : "failed", gateOutput: tail(check.output), commitSha, sessionId: agent.sessionId };
    }
    const acc = await d.runAcceptance(ctx.worktreePath, task.acceptance, config.checkTimeoutMs);
    if (!acc.ok) {
        return { verdict: "failed", gateOutput: tail(`acceptance command failed: ${acc.failedCommand}\n${acc.output}`), commitSha, sessionId: agent.sessionId };
    }
    return { verdict: "green", gateOutput: "", commitSha, sessionId: agent.sessionId };
}

const CHECK_TIMEOUT_MS = 30 * 60 * 1000; // generous; the loop's real bounds arrive in M2

export async function runTaskSinglePass(project: Project, task: Task, d: RunTaskDeps): Promise<TaskStatus> {
    await d.ensureBranch(project.repoPath, project.integrationBranch, project.targetBranch);
    await d.checkoutBranch(project.repoPath, project.integrationBranch);

    const branch = `${project.branchPrefix}/task-${task.id}`;
    const path = await d.createWorktree(project.repoPath, project.integrationBranch, branch, project.worktreeDir);
    d.setStatus(task.id, "running", { branchName: branch, worktreePath: path });

    const iter = d.addIteration(task.id, 0);

    const fail = async (reason: string, verdict: "failed" | "hang", output: string): Promise<TaskStatus> => {
        d.finishIteration(iter.id, { gateVerdict: verdict, outputTail: output.slice(-1500) });
        d.setStatus(task.id, "needs-human", { failureReason: reason });
        await d.removeWorktree(project.repoPath, path, branch, true); // keep branch for inspection
        d.log(`task ${task.id} needs-human: ${reason}`);
        return "needs-human";
    };

    const agent = await d.spawnAgent(path, task.intent, {});
    await d.commitAll(path, `ralph: task ${task.id} ${task.title}`);
    if (!agent.ok) return fail("agent did not complete", "failed", agent.output);

    const check = await d.runCheck(path, project.checkCommand, CHECK_TIMEOUT_MS);
    if (!check.green) return fail(check.timedOut ? "check timed out (hang)" : "check failed", check.timedOut ? "hang" : "failed", check.output);

    const diffstat = await d.diffStat(project.repoPath, project.integrationBranch, branch);
    const merge = await d.squashMergeInto(project.repoPath, branch, project.integrationBranch);
    if (merge.conflict) return fail("merge conflict", "failed", "squash-merge conflicted");

    d.setStatus(task.id, "merged", { diffstat });
    d.finishIteration(iter.id, { gateVerdict: "green", outputTail: agent.output.slice(-1500) });
    await d.removeWorktree(project.repoPath, path, branch, false);
    d.log(`task ${task.id} merged (${diffstat})`);
    return "merged";
}
