// src/main/engine/runTask.ts
import type { Project, Task, TaskStatus, IterationVerdict, SnapshotEvent, TokenTotals } from "../../shared/types";
import type { LoopConfig } from "./loopConfig";
import type { MergeStageResult } from "./mergeStage";
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
    // deniedCommands is OPTIONAL (absent = []): the structured permission_denials keys off the result event.
    // Optional keeps every existing spawn fake (which omits it) valid; only the deny fail-fast breaker reads it.
    spawnAgent: (worktreePath: string, prompt: string, opts: { model?: string; idleTimeoutMs?: number; iterationIndex?: number; onEvent?: (e: SnapshotEvent) => void; signal?: AbortSignal }) => Promise<{ ok: boolean; output: string; sessionId: string | null; stalled: boolean; usage: TokenTotals; durationMs: number | null; deniedCommands?: string[] }>;
    commitAll: (repo: string, message: string) => Promise<void>;
    headSha: (repo: string) => Promise<string>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    runAcceptance: (worktreePath: string, commands: string[], timeoutMs: number) => Promise<{ ok: boolean; failedCommand?: string; output: string }>;
    squashMergeInto: (repo: string, taskBranch: string, target: string) => Promise<{ merged: boolean; conflict: boolean }>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    // M4: landing is delegated to the isolated, serialized merge stage (throwaway worktree + rebase-on-
    // tip re-check). The real wiring (ipc.ts) wraps this in the project's merge mutex; the loop is
    // mutex-agnostic. squashMergeInto/diffStat stay available as merge-stage building blocks.
    mergeStage: (project: Project, task: Task, taskBranch: string) => Promise<MergeStageResult>;
    setStatus: (taskId: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string | null }) => void;
    addIteration: (taskId: string, index: number) => { id: string };
    finishIteration: (id: string, patch: { gateVerdict: "green" | "failed" | "hang"; outputTail: string; commitSha?: string | null; sessionId?: string | null; inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null; costUsd?: number | null; durationMs?: number | null }) => void;
    emit?: (e: SnapshotEvent) => void; // feeds the live EngineSnapshot; absent → no-op (e.g. the M2 slice)
    // M5 drop-in: an AbortSignal owned by the per-task AbortController registry (ipc.ts). On abort, the
    // in-flight claude is hard-killed (threaded into spawnAgent) and the loop bails to handed-off.
    signal?: AbortSignal;
    log: (msg: string) => void;
}

export interface IterationOutcome {
    verdict: IterationVerdict;
    gateOutput: string;   // failing layer's output tail (empty on green) — the full detail
    gateSummary: string;  // one-line "why the gate failed" (empty on green) — folded into the terminal reason
    commitSha: string;    // worktree HEAD after this iteration's commit
    sessionId: string | null;
    usage: TokenTotals;   // this iteration's token totals (from spawn's result event)
    durationMs: number | null;
    // M12 deny fail-fast: the normalized permission_denials keys this iteration's spawn reported (absent = []).
    // The loop streaks these across CONSECUTIVE iterations to escalate a hard wall to needs-human early.
    deniedCommands?: string[];
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
        signal: d.signal, // M5: a drop-in hard-kills this session via the existing killTree
    });
    const base = { usage: agent.usage, durationMs: agent.durationMs, sessionId: agent.sessionId, deniedCommands: agent.deniedCommands ?? [] };
    await d.commitAll(ctx.worktreePath, `ralph: iter ${ctx.index} — ${task.title}`);
    const commitSha = await d.headSha(ctx.worktreePath);

    if (!agent.ok) {
        // A killed (drop-in) or stalled turn never completed, so claude never wrote a resumable
        // <sessionId>.jsonl to disk. Record sessionId=null (NOT the agent's pre-generated id) so drop-in's
        // latestSessionId only ever targets a session that actually exists — otherwise `claude --resume`
        // dies "No conversation found". "a recorded sessionId ⇔ a resumable session" is the invariant the
        // Drop-in button reads to enable/disable itself; Start fresh is always available to grab the agent.
        const summary = agent.stalled ? "agent stalled (stream idle timeout)" : "agent run exited non-zero";
        return { verdict: agent.stalled ? "hang" : "failed", gateOutput: tail(agent.output), gateSummary: summary, commitSha, ...base, sessionId: null };
    }
    // The engine's authoritative gates — emit a gate event around each so the cockpit shows the phase.
    const check = await d.runCheck(ctx.worktreePath, project.checkCommand, config.checkTimeoutMs);
    d.emit?.({ type: "gate", index: ctx.index, label: check.green ? "check: passed" : `check: ${check.timedOut ? "hang" : "failed"}` });
    if (!check.green) {
        return { verdict: check.timedOut ? "hang" : "failed", gateOutput: tail(check.output), gateSummary: check.timedOut ? "project check timed out" : "project check failed", commitSha, ...base };
    }
    const acc = await d.runAcceptance(ctx.worktreePath, task.acceptance, config.checkTimeoutMs);
    d.emit?.({ type: "gate", index: ctx.index, label: acc.ok ? "acceptance: passed" : "acceptance: failed" });
    if (!acc.ok) {
        return { verdict: "failed", gateOutput: tail(`acceptance command failed: ${acc.failedCommand}\n${acc.output}`), gateSummary: `acceptance failed: ${acc.failedCommand ?? "(command)"}`, commitSha, ...base };
    }
    return { verdict: "green", gateOutput: "", gateSummary: "", commitSha, ...base };
}

// Resume re-enters an existing handed-off worktree (Task 4). worktreePath != null is the discriminator
// the ipc layer uses to route a re-enqueued handed-off task back into the loop without re-cloning.
export interface ResumeContext { worktreePath: string; branch: string; startIndex: number }

// The orchestrator: create the worktree once (or reuse it on resume), seed .ralph, loop runIteration
// under the bounds, squash-merge on the first green, clean up on any terminal outcome.
export async function runTaskLoop(project: Project, task: Task, config: LoopConfig, d: RunTaskDeps, resume?: ResumeContext): Promise<TaskStatus> {
    const branch = resume ? resume.branch : `${project.branchPrefix}/task-${task.id}`;

    // Integration must exist, but the engine NEVER checks it out in the main working tree anymore
    // (M4): the merge moved into an isolated throwaway worktree, so two parallel loops can't collide
    // on a shared checkout. Integration is checked out nowhere; mergeStage advances it as a ref.
    //
    // These git calls run BEFORE the task flips to "running". A failure here (e.g. a malformed
    // repoPath → `git -C " C:\…"` → "cannot change to …: Invalid argument") can't be fixed by the
    // agent and MUST NOT throw: an unhandled rejection would leave the task "queued" and the
    // scheduler would re-select the doomed task forever. Land it in needs-human (visible) instead.
    //
    // Resume (M5) SKIPS the clone: the handed-off worktree already has the branch, the .ralph files,
    // the human's commits, and installed deps — re-cloning would throw away the human's steering.
    let worktreePath: string;
    if (resume) {
        worktreePath = resume.worktreePath;
    } else {
        try {
            await d.ensureBranch(project.repoPath, project.integrationBranch, project.targetBranch);
            worktreePath = await d.createWorktree(project.repoPath, project.integrationBranch, branch, project.worktreeDir);
        } catch (e) {
            const reason = `worktree setup failed: ${e instanceof Error ? e.message : String(e)}`;
            d.setStatus(task.id, "needs-human", { failureReason: reason });
            d.emit?.({ type: "status", status: "needs-human", terminalReason: reason });
            d.log(`task ${task.id} needs-human: ${reason}`);
            return "needs-human";
        }
    }
    d.setStatus(task.id, "running", { branchName: branch, worktreePath });

    // The loop's single exit. M5 worktree lifecycle (spec §12): RETAIN the worktree for needs-human and
    // handed-off (it's in use for drop-in — reaped later by Abandon or a green Verify-&-merge); REMOVE it
    // (and delete its branch) for merged/abandoned. Deriving removal from the status keeps the retention
    // rule in one place; keepBranch only matters on the removal path.
    const terminate = async (status: TaskStatus, reason: string | undefined, keepBranch: boolean, diffstat?: string): Promise<TaskStatus> => {
        const extra: { diffstat?: string; failureReason?: string | null } = {};
        if (diffstat !== undefined) extra.diffstat = diffstat;
        if (reason !== undefined) extra.failureReason = reason;
        // Clear any stale failureReason on a terminal SUCCESS: a task that was needs-human (reason set),
        // then resumed to a green merge (or was abandoned), must not keep its old red reason on the card.
        // DB-authoritative — the merged card reflects the final DB row, not a leftover.
        if (status === "merged" || status === "abandoned") extra.failureReason = null;
        d.setStatus(task.id, status, extra);
        d.emit?.({ type: "status", status, terminalReason: reason });
        if (status === "merged" || status === "abandoned") {
            await d.removeWorktree(project.repoPath, worktreePath, branch, keepBranch);
        }
        d.log(`task ${task.id} ${status}${reason ? `: ${reason}` : ""}`);
        return status;
    };

    // Layer B is mandatory; an empty acceptance list can never prove "done".
    if (task.acceptance.length === 0) {
        return terminate("needs-human", "no acceptance commands (Layer B is mandatory)", true);
    }

    // Fresh start only: seed .ralph and install deps. On resume the worktree already has the .ralph
    // files, installed deps, and the human's commits — re-seeding would clobber the progress file and
    // re-running setup is wasted work (and could fail on a half-edited tree).
    if (!resume) {
        d.ensureRalphExcluded(project.repoPath);
        d.writeRalphFiles(worktreePath, { instructions: buildInstructions(), progress: seedProgress(task) });

        // Install deps into the fresh worktree once, before any iteration. A broken setup is a config
        // error the agent can't fix, so fail fast (no spawn) — the same early-terminal shape as the
        // empty-acceptance guard. NULL setupCommand → skip.
        if (project.setupCommand) {
            const setup = await d.runSetup(worktreePath, project.setupCommand, config.checkTimeoutMs);
            if (!setup.ok) return terminate("needs-human", `setup command failed:\n${tail(setup.output)}`, true);
        }
    }

    let priorFailure: string | undefined;
    let lastGateSummary = ""; // one-liner from the most recent failing gate — folded into the terminal reason
    let prevSha = await d.headSha(worktreePath); // baseSha — the worktree tip before any iteration
    let noProgress = 0;
    // M12 deny fail-fast: per-key streak of CONSECUTIVE iterations whose spawn reported that permissions.deny
    // key. Reaching denyWallK escalates a hard wall to needs-human early (before burning the full cap).
    const denyStreak = new Map<string, number>();

    // The drop-in checkpoint: commit the (already-committed) partial work and hand off. commitAll
    // no-ops on a clean tree, so this is free when runIteration already committed the killed session.
    const handOff = async (): Promise<TaskStatus> => {
        await d.commitAll(worktreePath, "ralph: drop-in checkpoint");
        return terminate("handed-off", undefined, true);
    };

    // Split counter (M5): a LOCAL bounds counter i (0..cap) drives a FRESH budget every run; the DB index
    // continues from startIndex. On a fresh start startIndex = 0 → dbIndex === i → byte-identical to pre-M5.
    // Resume gets startIndex = the prior iteration count (history keeps climbing) AND a fresh cap of i
    // (the human resumed *because* the budget was exhausted; a cap-reached task would otherwise re-terminate
    // at zero iterations). prevSha above is the worktree's current HEAD — the human's committed state.
    const startIndex = resume ? resume.startIndex : 0;

    // M12 cost cap: this RUN's accumulated USD spend (sum of each iteration's usage.costUsd; null/absent → 0).
    // Like the split iteration counter above, it is a LOCAL that re-inits to 0 every runTaskLoop call, so a
    // resume gets a FRESH cost budget (the human resumed *because* the budget was exhausted). The cap gates
    // SPAWNS only — checked at the top of the loop before spawning; a green iteration that crosses the cap
    // still merges below.
    let spend = 0;

    for (let i = 0; i < config.iterationCap; i++) {
        // Top-of-loop guard: a drop-in that lands between iterations bails before spawning the next one.
        if (d.signal?.aborted) return handOff();
        // Cost-cap breaker: once this run's spend reaches the ceiling, stop spawning (BEFORE addIteration/spawn).
        // A 0 cap is honored — spend (0) >= cap (0) on the first pass, so a 0-cap project spawns nothing at all.
        if (spend >= config.costCapUsd) {
            return terminate("needs-human", `cost cap reached ($${spend.toFixed(2)} of $${config.costCapUsd} cap)`, true);
        }
        const dbIndex = startIndex + i;
        d.emit?.({ type: "iteration-start", index: dbIndex });
        const iter = d.addIteration(task.id, dbIndex);
        const o = await runIteration(project, task, { index: dbIndex, worktreePath, branch, priorFailure }, config, d);
        d.finishIteration(iter.id, {
            gateVerdict: o.verdict, outputTail: o.gateOutput, commitSha: o.commitSha, sessionId: o.sessionId,
            inputTokens: o.usage.input, outputTokens: o.usage.output,
            cacheReadTokens: o.usage.cacheRead, cacheCreationTokens: o.usage.cacheCreation,
            costUsd: o.usage.costUsd, durationMs: o.durationMs,
        });
        // Accumulate this iteration's spend for the next top-of-loop cost-cap check (null/absent → 0).
        spend += o.usage.costUsd ?? 0;
        d.emit?.({ type: "iteration-end", index: dbIndex, verdict: o.verdict, commitSha: o.commitSha });

        // Post-iteration guard: a drop-in killed the in-flight session DURING this iteration. runIteration
        // recorded sessionId=null for that killed turn (it never persisted), so drop-in resumes the freshest
        // PERSISTED session — or none, leaving Drop-in disabled and Start fresh as the way to grab it.
        if (d.signal?.aborted) return handOff();

        if (o.verdict === "green") {
            // Hand landing to the isolated merge stage: it rebases on the fresh integration tip and
            // re-checks in a throwaway worktree, advancing integration only on a green re-check. A
            // failed re-check (or conflict) loses the race → needs-human (worktree kept for drop-in).
            const r = await d.mergeStage(project, task, branch);
            if (r.outcome === "merged") return terminate("merged", undefined, false, r.diffstat);
            return terminate("needs-human", r.reason, true);
        }

        priorFailure = o.gateOutput;
        lastGateSummary = o.gateSummary;

        // M12 deny fail-fast: update the per-key consecutive-iteration deny streak. A key NOT reported this
        // (non-green) iteration resets (the agent adapted around the wall); a key reported increments. At
        // denyWallK consecutive hits, escalate to needs-human — checked BEFORE the no-progress breaker so the
        // specific deny reason wins when both would fire this iteration. Commit activity does NOT suppress it
        // (an agent committing junk around a wall is still walled).
        const denied = o.deniedCommands ?? [];
        const deniedSet = new Set(denied);
        for (const key of [...denyStreak.keys()]) if (!deniedSet.has(key)) denyStreak.delete(key);
        for (const key of denied) {
            const n = (denyStreak.get(key) ?? 0) + 1;
            denyStreak.set(key, n);
            if (n >= config.denyWallK) {
                return terminate("needs-human", `deny wall: "${key}" denied on ${n} consecutive iterations`, true);
            }
        }

        noProgress = o.commitSha === prevSha ? noProgress + 1 : 0;
        prevSha = o.commitSha;
        if (noProgress >= config.noProgressK) {
            // Courtesy: if the latest iteration was also blocked by a wall (that just hadn't reached denyWallK
            // yet), fold the denied command(s) into the no-progress reason so the card names the real blocker.
            const denyNote = denied.length ? ` — denied: ${denied.join(", ")}` : "";
            return terminate("needs-human", `no progress for ${config.noProgressK} iterations${lastGateSummary ? ` — last gate: ${lastGateSummary}` : ""}${denyNote}`, true);
        }
    }
    return terminate("needs-human", `iteration cap reached (${config.iterationCap})${lastGateSummary ? ` — last gate: ${lastGateSummary}` : ""}`, true);
}
