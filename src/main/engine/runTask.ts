// src/main/engine/runTask.ts
import type { Project, Task, TaskStatus, IterationVerdict, SnapshotEvent, TokenTotals, FailureKind, FailureNote } from "../../shared/types";
import type { LoopConfig } from "./loopConfig";
import type { MergeStageResult } from "./mergeStage";
import { buildGoalPrompt, buildInstructions, buildReviewPrompt, buildTaskDirective, seedProgress, type PriorFailure } from "./prompt";
import { billableTokens } from "./verifyState";

// Re-export so the reducer, the loop, and the M2 verify slice (which imports it from here) share
// the single definition now living in shared/types.ts.
export type { IterationVerdict };

export interface RunTaskDeps {
    ensureBranch: (repo: string, name: string, from: string) => Promise<void>;
    checkoutBranch: (repo: string, name: string) => Promise<void>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    ensureRalphExcluded: (repo: string) => void;
    writeRalphFiles: (worktreePath: string, files: { instructions: string; progress: string; task: string }) => void;
    runSetup: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
    // deniedCommands is OPTIONAL (absent = []): the structured permission_denials keys off the result event.
    // Optional keeps every existing spawn fake (which omits it) valid; only the deny fail-fast breaker reads it.
    // reviewFinding is OPTIONAL and read ONLY off a post-green REVIEW spawn: a non-empty string means the review
    // judged the now-green work NOT good (the text is its finding), which re-opens the task into work drawing the
    // remaining iterationCap; absent/empty/null ⇒ the review found nothing (clean). Work spawns leave it absent,
    // and a production spawnAgent that never sets it keeps reviews confirm-only (byte-identical to pre-M20) until
    // a follow-up wires the verdict out of the review transcript — the same incremental seam as jailSync/recordRecycled.
    spawnAgent: (worktreePath: string, prompt: string, opts: { model?: string; idleTimeoutMs?: number; iterationIndex?: number; onEvent?: (e: SnapshotEvent) => void; signal?: AbortSignal }) => Promise<{ ok: boolean; output: string; sessionId: string | null; stalled: boolean; usage: TokenTotals; durationMs: number | null; deniedCommands?: string[]; reviewFinding?: string | null }>;
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
    // M17: a needs-human write carries `failure` — the structured {kind, iterationIndex} note the DB
    // chokepoint appends to the durable failure ledger (absent → the chokepoint records kind 'unknown').
    setStatus: (taskId: string, status: TaskStatus, extra?: { branchName?: string; worktreePath?: string; diffstat?: string; failureReason?: string | null; failure?: FailureNote }) => void;
    addIteration: (taskId: string, index: number) => { id: string };
    finishIteration: (id: string, patch: { gateVerdict: "green" | "failed" | "hang"; outputTail: string; commitSha?: string | null; sessionId?: string | null; inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null; cacheCreationTokens?: number | null; costUsd?: number | null; durationMs?: number | null }) => void;
    emit?: (e: SnapshotEvent) => void; // feeds the live EngineSnapshot; absent → no-op (e.g. the M2 slice)
    // M5 drop-in: an AbortSignal owned by the per-task AbortController registry (ipc.ts). On abort, the
    // in-flight claude is hard-killed (threaded into spawnAgent) and the loop bails to handed-off.
    signal?: AbortSignal;
    // M13 jail mode: the git-exchange sync around each in-container spawn ("git as the wall"). ALL absent ⇒
    // host mode (no sync — byte-identical to today). The edge wires these bound to the per-task exchange only
    // when project.jailImage is set. prepare = ensureExchange (once, idempotent); syncIn = host→exchange
    // (force) BEFORE the container runs (host authoritative in); syncOut = exchange→host (fetch+hard-reset)
    // AFTER (container authoritative out). The GATES are untouched — check ∧ acceptance still run on the HOST
    // worktree these sync into/out of (invariant gates-run-host-side).
    jailSync?: {
        prepare: () => Promise<void>;
        syncIn: (worktreePath: string, branch: string) => Promise<void>;
        syncOut: (worktreePath: string, branch: string) => Promise<void>;
    };
    // M13 jail reap: remove the per-task container + volume + bare exchange on a TERMINAL teardown
    // (merged/abandoned — where the worktree is also removed). Absent ⇒ host mode / nothing to reap.
    reapJail?: (taskId: string) => Promise<void>;
    // M18: an in-place merge-loss recycle never writes needs-human, so the DB chokepoint's ledger
    // capture can't see it — this hook keeps recycled losses ledger-visible (the edge wires it to a
    // pre-stamped 'recycled' insert). OPTIONAL: absent (existing fakes, M2 slice) ⇒ no-op.
    recordRecycled?: (taskId: string, reason: string, note: FailureNote) => void;
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
    ctx: { index: number; worktreePath: string; branch: string; priorFailure?: PriorFailure },
    config: LoopConfig, d: RunTaskDeps,
): Promise<IterationOutcome> {
    const prompt = buildGoalPrompt(project, task, ctx.priorFailure);
    // M13 jail mode: push the host worktree's authoritative pre-iteration state into the bare exchange BEFORE
    // the agent runs (the container clones the exchange). Host mode → no-op.
    if (d.jailSync) await d.jailSync.syncIn(ctx.worktreePath, ctx.branch);
    // Forward spawn's translated stream events (assistant/tool-use/usage) into the live snapshot,
    // stamped with this iteration's index. project.model NULL → undefined (the CLI default). In jail mode the
    // edge injects opts.jail into this spawn, so it runs `docker run … claude …` (the loop stays agnostic).
    const agent = await d.spawnAgent(ctx.worktreePath, prompt, {
        model: project.model ?? undefined,
        idleTimeoutMs: config.stallTimeoutMs,
        iterationIndex: ctx.index,
        onEvent: (e) => d.emit?.(e),
        signal: d.signal, // M5: a drop-in hard-kills this session via the existing killTree
    });
    // M13 jail mode: fetch the container's commit back into the host worktree (hard-reset). Host mode → no-op.
    // After this, commitAll no-ops (clean tree) and headSha reads the CONTAINER's commit; the gates below run
    // on the host worktree — unchanged.
    if (d.jailSync) await d.jailSync.syncOut(ctx.worktreePath, ctx.branch);
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
            d.setStatus(task.id, "needs-human", { failureReason: reason, failure: { kind: "worktree-setup", iterationIndex: null } });
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
    // M17: the most recent COMPLETED iteration's DB index (null before any) — the locus terminate stamps
    // into each ledger entry. On resume the prior run's last iteration is startIndex - 1; walls that fire
    // between iterations (cost cap, iteration cap) thereby name the last iteration that actually ran.
    let lastIndex: number | null = resume && resume.startIndex > 0 ? resume.startIndex - 1 : null;

    const terminate = async (status: TaskStatus, reason: string | undefined, keepBranch: boolean, opts?: { diffstat?: string; kind?: FailureKind }): Promise<TaskStatus> => {
        const extra: { diffstat?: string; failureReason?: string | null; failure?: FailureNote } = {};
        if (opts?.diffstat !== undefined) extra.diffstat = opts.diffstat;
        if (reason !== undefined) extra.failureReason = reason;
        // Clear any stale failureReason on a terminal SUCCESS: a task that was needs-human (reason set),
        // then resumed to a green merge (or was abandoned), must not keep its old red reason on the card.
        // DB-authoritative — the merged card reflects the final DB row, not a leftover.
        if (status === "merged" || status === "abandoned") extra.failureReason = null;
        // M17: every needs-human exit carries its structured kind into the ledger ('unknown' if a future
        // call site forgets — the index still lands either way).
        if (status === "needs-human") extra.failure = { kind: opts?.kind ?? "unknown", iterationIndex: lastIndex };
        d.setStatus(task.id, status, extra);
        d.emit?.({ type: "status", status, terminalReason: reason });
        if (status === "merged" || status === "abandoned") {
            await d.removeWorktree(project.repoPath, worktreePath, branch, keepBranch);
            // M13: a terminal jail task's worktree is gone → reap its container + per-task volume + exchange
            // (the volume is retained across iterations AND across needs-human/handed-off for resume, so it's
            // only reaped here, at a terminal teardown). Host mode → no-op.
            if (d.reapJail) await d.reapJail(task.id);
        }
        d.log(`task ${task.id} ${status}${reason ? `: ${reason}` : ""}`);
        return status;
    };

    // Layer B is mandatory; an empty acceptance list can never prove "done".
    if (task.acceptance.length === 0) {
        return terminate("needs-human", "no acceptance commands (Layer B is mandatory)", true, { kind: "no-acceptance" });
    }

    // Fresh start only: seed .ralph and install deps. On resume the worktree already has the .ralph
    // files, installed deps, and the human's commits — re-seeding would clobber the progress file and
    // re-running setup is wasted work (and could fail on a half-edited tree).
    if (!resume) {
        d.ensureRalphExcluded(project.repoPath);
        d.writeRalphFiles(worktreePath, { instructions: buildInstructions(), progress: seedProgress(task), task: buildTaskDirective(task) });

        // Install deps into the fresh worktree once, before any iteration. A broken setup is a config
        // error the agent can't fix, so fail fast (no spawn) — the same early-terminal shape as the
        // empty-acceptance guard. NULL setupCommand → skip.
        if (project.setupCommand) {
            const setup = await d.runSetup(worktreePath, project.setupCommand, config.checkTimeoutMs);
            if (!setup.ok) return terminate("needs-human", `setup command failed:\n${tail(setup.output)}`, true, { kind: "setup-command" });
        }
    }

    // M13 jail mode: ensure the per-task bare exchange exists before the first syncIn (idempotent — a resume
    // after a restart reuses it). Host mode → no-op.
    if (d.jailSync) await d.jailSync.prepare();

    // M18 informed resume: the parked failureReason persists through drop-in → handed-off → resume
    // (only merged/abandoned null it), so a resumed run's first iteration learns why it was parked.
    // Resume-only by construction: a fresh start ignores any stale reason; a clean drop-in (never
    // failed → reason null) seeds nothing.
    let priorFailure: PriorFailure | undefined =
        resume && task.failureReason ? { framing: "parked", body: task.failureReason } : undefined;
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

    // The spend ledger (a LOCAL, fresh on resume — the human resumed *because* the budget was exhausted):
    // this RUN's accumulated BILLABLE tokens (input + output + cacheCreation; cacheRead excluded — see
    // billableTokens). The legacy USD accumulator is GONE — costUsd still rides along per iteration as
    // display accounting, but dollars are no longer a spend signal anywhere in the loop.
    let billableSpent = 0;

    // M18: merge-stage losses recycled in-place this RUN (a local, like the split counters above — a
    // human resume grants a fresh recycle budget along with the fresh iteration/cost budgets).
    let recyclesUsed = 0;

    for (let i = 0; i < config.iterationCap; i++) {
        // Top-of-loop guard: a drop-in that lands between iterations bails before spawning the next one.
        if (d.signal?.aborted) return handOff();
        // The RETIRED $ cap's one surviving contract: an explicit costCapUsd of 0 still means "spawn
        // nothing". With no USD accumulator left, prior spend is identically $0, so the old `spend >= cap`
        // meter could only ever fire at cap ≤ 0 — this is that residue, written as exactly that. Any
        // positive $ cap is DEAD: it can never trip, no matter what a run costs.
        if (config.costCapUsd !== undefined && config.costCapUsd <= 0) {
            return terminate("needs-human", `cost cap reached ($0.00 of $${config.costCapUsd} cap)`, true, { kind: "cost-cap" });
        }
        // Token-cap breaker — the SOLE spend ceiling: spawns-only placement, denominated in BILLABLE
        // tokens. undefined ⇒ gate off (pre-tokenCap LoopConfig literals); resolveLoopConfig always supplies
        // it. An explicit 0 spawns nothing (0 billable >= 0 cap trips before the first spawn). The ledger
        // kind stays "cost-cap" — it IS the spend ceiling, now counted in tokens.
        if (config.tokenCap !== undefined && billableSpent >= config.tokenCap) {
            return terminate("needs-human", `token cap reached (${billableSpent} of ${config.tokenCap} billable tokens)`, true, { kind: "cost-cap" });
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
        // Accumulate this iteration's billable tokens for the next top-of-loop cap check. costUsd is
        // recorded above for display/history only — it feeds NO gate.
        billableSpent += billableTokens(o.usage);
        lastIndex = dbIndex; // this iteration COMPLETED — it's the locus any wall below stamps into the ledger
        d.emit?.({ type: "iteration-end", index: dbIndex, verdict: o.verdict, commitSha: o.commitSha, tail: o.gateOutput });

        // Post-iteration guard: a drop-in killed the in-flight session DURING this iteration. runIteration
        // recorded sessionId=null for that killed turn (it never persisted), so drop-in resumes the freshest
        // PERSISTED session — or none, leaving Drop-in disabled and Start fresh as the way to grab it.
        if (d.signal?.aborted) return handOff();

        if (o.verdict === "green") {
            // ── Post-green review phase (M20, re-open on finding) ───────────────────────────────────
            // Before finalizing, run review passes — each a FRESH review-framed spawn through the same
            // chokepoint that independently re-examines the now-green work. This phase draws its OWN
            // budget (K passes); it does NOT consume iterationCap, so a task green on its LAST work
            // iteration still gets reviewed. Each pass has three outcomes:
            //   • CLEAN (reviewFinding empty) → advance toward finalize; K CONSECUTIVE clean → merge.
            //   • FLAGGED (reviewFinding non-empty) → the review judged the work NOT good: RE-OPEN the
            //     task into a work iteration drawing from the REMAINING iterationCap. The clean streak
            //     resets — a re-fix is re-reviewed FROM SCRATCH (the counter is local to each green entry,
            //     so breaking back to the work loop restarts reviews at zero on the next green). With no
            //     work budget left, the flag parks the task (a real problem, no attempts left to fix it).
            //   • DID NOT COMPLETE (!ok) → park (the review couldn't confirm) rather than land unconfirmed.
            // K = 0/undefined → no reviews (byte-identical to the pre-review path). Review spawns are NOT
            // iterations — they call neither addIteration nor finishIteration, and never advance `i`.
            const reviewK = config.postGreenReviewK ?? 0;
            let reopened = false; // a flag sent us back to work — draw the next iteration from iterationCap
            for (let rev = 0; rev < reviewK; rev++) {
                // A drop-in landing between review passes bails like any between-spawn abort.
                if (d.signal?.aborted) return handOff();
                const reviewPrompt = buildReviewPrompt(project, task);
                if (d.jailSync) await d.jailSync.syncIn(worktreePath, branch);
                const review = await d.spawnAgent(worktreePath, reviewPrompt, {
                    model: project.model ?? undefined,
                    idleTimeoutMs: config.stallTimeoutMs,
                    iterationIndex: dbIndex,
                    onEvent: (e) => d.emit?.(e),
                    signal: d.signal,
                });
                if (d.jailSync) await d.jailSync.syncOut(worktreePath, branch);
                // Reviews cost real tokens — fold them into this run's billable ledger (accounting only;
                // the review phase runs to completion regardless of the token cap, which gates work spawns).
                billableSpent += billableTokens(review.usage);
                if (!review.ok) {
                    const why = review.stalled ? "stalled (stream idle timeout)" : "exited non-zero";
                    d.emit?.({ type: "gate", index: dbIndex, label: `review: pass ${rev + 1}/${reviewK} ${why}` });
                    return terminate("needs-human", `post-green review pass ${rev + 1}/${reviewK} ${why} — work left unconfirmed`, true, { kind: "recheck-failed" });
                }
                // A non-empty finding = the review judged the work NOT good → re-open into work.
                const finding = (review.reviewFinding ?? "").trim();
                if (finding) {
                    // Re-open draws from the REMAINING iterationCap: the re-fix is the next iteration of the
                    // work loop (`i + 1`). No budget left (this green turn was the last permitted iteration)
                    // → park — the review found a real problem the loop has no attempts left to fix.
                    if (i + 1 >= config.iterationCap) {
                        d.emit?.({ type: "gate", index: dbIndex, label: `review: pass ${rev + 1}/${reviewK} flagged — work budget exhausted` });
                        return terminate("needs-human", `review flagged issues, work budget exhausted (${config.iterationCap} iterations)`, true, { kind: "iteration-cap" });
                    }
                    // Feed the finding to the re-fix as its prior failure and reset the clean streak (break
                    // → the next green re-reviews from zero). lastGateSummary names the real blocker on any
                    // downstream wall (e.g. a no-progress bail after the re-fix stalls).
                    priorFailure = { framing: "gate", body: finding };
                    lastGateSummary = "post-green review flagged issues";
                    d.emit?.({ type: "gate", index: dbIndex, label: `review: pass ${rev + 1}/${reviewK} flagged — reopened` });
                    d.log(`task ${task.id} review flagged (pass ${rev + 1}/${reviewK}) — reopened, drawing remaining iterationCap`);
                    reopened = true;
                    break;
                }
                d.emit?.({ type: "gate", index: dbIndex, label: `review: pass ${rev + 1}/${reviewK} clean` });
            }
            // A flag re-opened the task: go draw the next WORK iteration from iterationCap.
            if (reopened) continue;
            // K consecutive clean reviews (the for-loop ran to completion with no flag), or K = 0 → land it.
            // Hand landing to the isolated merge stage: it rebases on the fresh integration tip and
            // re-checks in a throwaway worktree, advancing integration only on a green re-check. A
            // failed re-check (or conflict) loses the race → needs-human (worktree kept for drop-in).
            let r: MergeStageResult;
            try {
                r = await d.mergeStage(project, task, branch);
            } catch (e) {
                // A THROWN merge stage (a git failure creating/removing the throwaway worktree, etc.) must
                // never leave the task wedged in "running" — an unhandled rejection here did exactly that.
                // Land it visibly in needs-human (worktree retained for drop-in), like every other wall.
                return terminate("needs-human", `merge stage threw: ${e instanceof Error ? e.message : String(e)}`, true, { kind: "merge-error" });
            }
            if (r.outcome === "merged") return terminate("merged", undefined, false, { diffstat: r.diffstat });
            // M18: an agent-fixable loss (textual conflict, or work that no longer composes with the
            // moved tip) recycles in-place while budget remains — the next iteration gets the cause AND
            // a /goal condition extended to demonstrate the integration merge (the no-op trap). Merge-
            // setup failures (config faults) and exhausted budgets park exactly as before. The recycle
            // never writes a status: the card stays "running"; the feed event is the visibility.
            if ((r.kind === "merge-conflict" || r.kind === "recheck-failed")
                && recyclesUsed < config.mergeRecycleK && i + 1 < config.iterationCap) {
                recyclesUsed += 1;
                priorFailure = { framing: "merge-loss", kind: r.kind, body: r.reason };
                lastGateSummary = r.kind === "merge-conflict" ? "merge conflict (auto-recycled)" : "merge re-check failed (auto-recycled)";
                d.recordRecycled?.(task.id, r.reason, { kind: r.kind, iterationIndex: lastIndex });
                d.emit?.({ type: "gate", index: dbIndex, label: `merge: lost race — recycled (${r.kind})` });
                d.log(`task ${task.id} merge loss recycled (${r.kind}), ${config.mergeRecycleK - recyclesUsed} recycle(s) left`);
                continue;
            }
            return terminate("needs-human", r.reason, true, { kind: r.kind });
        }

        priorFailure = { framing: "gate", body: o.gateOutput };
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
                return terminate("needs-human", `deny wall: "${key}" denied on ${n} consecutive iterations`, true, { kind: "deny-wall" });
            }
        }

        noProgress = o.commitSha === prevSha ? noProgress + 1 : 0;
        prevSha = o.commitSha;
        if (noProgress >= config.noProgressK) {
            // Courtesy: if the latest iteration was also blocked by a wall (that just hadn't reached denyWallK
            // yet), fold the denied command(s) into the no-progress reason so the card names the real blocker.
            const denyNote = denied.length ? ` — denied: ${denied.join(", ")}` : "";
            return terminate("needs-human", `no progress for ${config.noProgressK} iterations${lastGateSummary ? ` — last gate: ${lastGateSummary}` : ""}${denyNote}`, true, { kind: "no-progress" });
        }
    }
    return terminate("needs-human", `iteration cap reached (${config.iterationCap})${lastGateSummary ? ` — last gate: ${lastGateSummary}` : ""}`, true, { kind: "iteration-cap" });
}
