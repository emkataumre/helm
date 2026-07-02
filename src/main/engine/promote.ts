// src/main/engine/promote.ts
// The project-level batch Promote — a SIBLING of runMergeStage (mergeStage.ts), NOT an overload of it.
// Where the merge stage lands ONE green task onto integration, Promote graduates the WHOLE integration
// branch to the human's hands: it validates that integration composes with a FRESH origin/<targetBranch>
// tip inside a throwaway worktree (re-run check ∧ acceptance THERE), then hands mode-specific push +
// printed commands. It shares mergeStage's skeleton — throwaway worktree, setup, re-check, always-cleanup
// — but differs in base (origin/<target>), merge flavour (--no-ff of integration), and OUTCOME: it
// advances NO ref. The one command that advances the target is PRINTED for the human to run.
//
// THE non-negotiable invariant (spec §13, roadmap): the tool NEVER pushes to or merges <targetBranch>
// itself. It pushes only NON-PROTECTED helper branches (integration for `pr`, the validated promote
// branch for `direct`; `strict` pushes nothing). finalizePromotion NEVER calls pushBranch with the
// target branch as its remoteRef — the verify slice inspects the injected pushBranch to prove it.
//
// Pure DI — no Electron, no direct git — so it unit-tests with fake deps. ipc.ts wires the real engine
// fns behind the per-project merge mutex (Task 4).
import type { Project } from "../../shared/types";

export type PromoteResult =
    | { outcome: "nothing-to-promote" }
    | { outcome: "conflict" }
    | { outcome: "recheck-failed"; output: string }
    | PromoteReady;

// The green outcome, split out so finalizePromotion can take it as a precise argument.
export interface PromoteReady {
    outcome: "ready";
    validatedSha: string;   // the exact commit the re-check passed on — the raw sha the human's push advances the target to
    diffstat: string;       // origin/<target>..promoteBranch, sized before anything is pushed
    promoteBranch: string;  // helm/promote-<projectId>-<integration short sha> — the disposable artifact carrying validatedSha
}

export interface PromoteStageDeps {
    fetchRemote: (repo: string, remote: string, branch: string) => Promise<void>;
    countCommitsBeyond: (repo: string, base: string, tip: string) => Promise<number>;
    revParse: (repo: string, ref: string) => Promise<string>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    mergeNoFf: (worktreePath: string, ref: string) => Promise<{ merged: boolean; conflict: boolean }>;
    runSetup: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
    runCheck: (worktreePath: string, checkCommand: string, timeoutMs: number) => Promise<{ green: boolean; timedOut: boolean; output: string }>;
    runAcceptance: (worktreePath: string, commands: string[], timeoutMs: number) => Promise<{ ok: boolean; failedCommand?: string; output: string }>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    headSha: (repoOrWorktree: string) => Promise<string>;
    diffStat: (repo: string, base: string, branch: string) => Promise<string>;
    checkTimeoutMs: number;
}

export interface FinalizeDeps {
    // THE only push the finalizer may perform. The verify slice injects a recording fake and asserts it
    // is never called with <targetBranch> as its remoteRef (nor as a target-named local ref).
    pushBranch: (repo: string, remote: string, localRef: string, remoteRef?: string) => Promise<void>;
}

const TAIL = 2000;
const tail = (s: string): string => (s.length > TAIL ? `…(truncated)\n${s.slice(-TAIL)}` : s);
const SHORT = 12; // integration short-sha length in the promote branch name

// Prepare + validate — PUSHES NOTHING, ADVANCES NOTHING. Fetch the target, check integration actually has
// something beyond it, then compose + re-check the merge on a fresh tip in a throwaway worktree. Returns a
// `ready` carrying the exact validated commit; the throwaway worktree is removed on EVERY exit (the branch
// is KEPT — direct mode pushes it after cleanup; stale ones are reaped by slice ①'s reconcile).
export async function runPromoteStage(project: Project, d: PromoteStageDeps): Promise<PromoteResult> {
    const repo = project.repoPath;
    const remoteTarget = `origin/${project.targetBranch}`;

    // 1) Refresh origin/<target> so the whole re-check runs against a FRESH tip (not a stale local copy).
    await d.fetchRemote(repo, "origin", project.targetBranch);

    // 2) Nothing beyond the target ⇒ nothing to promote. Bail BEFORE building any worktree.
    const beyond = await d.countCommitsBeyond(repo, remoteTarget, project.integrationBranch);
    if (beyond === 0) return { outcome: "nothing-to-promote" };

    // 3) A UNIQUE throwaway branch off the fresh remote target tip. Unique (integration short sha) so a
    //    second promotion of a different tip can't collide on the name.
    const integrationSha = await d.revParse(repo, project.integrationBranch);
    const promoteBranch = `helm/promote-${project.id}-${integrationSha.slice(0, SHORT)}`;

    let worktreePath: string | null = null;
    try {
        worktreePath = await d.createWorktree(repo, remoteTarget, promoteBranch, project.worktreeDir);

        // 4) --no-ff --no-edit merge of integration onto the fresh target tip. Conflict → bail (no advance).
        const merge = await d.mergeNoFf(worktreePath, project.integrationBranch);
        if (merge.conflict) return { outcome: "conflict" };

        // 5) The fresh worktree has no gitignored deps — install them, or the re-check spuriously fails.
        //    A setup failure means we couldn't validate → recheck-failed (there is no separate outcome).
        if (project.setupCommand) {
            const setup = await d.runSetup(worktreePath, project.setupCommand, d.checkTimeoutMs);
            if (!setup.ok) return { outcome: "recheck-failed", output: `promote setup failed:\n${tail(setup.output)}` };
        }

        // The authoritative re-check against the fresh tip — check ∧ acceptance, mirroring mergeStage's
        // green definition. Project-level promote has no per-task acceptance list, so acceptance runs with
        // no commands (trivially green); the real gate is the project checkCommand on the composed tip.
        const check = await d.runCheck(worktreePath, project.checkCommand, d.checkTimeoutMs);
        if (!check.green) return { outcome: "recheck-failed", output: `promote re-check failed (check):\n${tail(check.output)}` };
        const acc = await d.runAcceptance(worktreePath, [], d.checkTimeoutMs);
        if (!acc.ok) return { outcome: "recheck-failed", output: `promote re-check failed (acceptance${acc.failedCommand ? ` — ${acc.failedCommand}` : ""}):\n${tail(acc.output)}` };

        // 6) Green ⇒ capture the exact validated commit + the landing diff, sized BEFORE anything is pushed.
        const validatedSha = await d.headSha(worktreePath);
        const diffstat = await d.diffStat(repo, remoteTarget, promoteBranch);
        return { outcome: "ready", validatedSha, diffstat, promoteBranch };
    } finally {
        // 7) Always remove the throwaway worktree; KEEP the branch (direct mode pushes it after cleanup —
        //    the worktree is disposable, the branch is the artifact carrying validatedSha).
        if (worktreePath) await d.removeWorktree(repo, worktreePath, promoteBranch, true);
    }
}

// Mode-specific push of a NON-PROTECTED helper branch + the printed commands the human runs to advance the
// target. NEVER pushes/merges the target itself — the target-advancing step is always a PRINTED command.
export async function finalizePromotion(
    project: Project, ready: PromoteReady, d: FinalizeDeps,
): Promise<{ pushedRefs: string[]; commands: string[] }> {
    const { integrationBranch, targetBranch } = project;
    switch (project.promotionMode) {
        case "pr": {
            // Push integration (a non-protected helper), then hand a gh command to open the PR. If the user
            // has no `gh`, the command simply won't run — the tool still did the safe part (pushed integration).
            await d.pushBranch(project.repoPath, "origin", integrationBranch);
            return {
                pushedRefs: [integrationBranch],
                commands: [`gh pr create --base ${targetBranch} --head ${integrationBranch} --fill`],
            };
        }
        case "direct": {
            // Push the validated promote branch (puts validatedSha on origin under a helper name), then hand a
            // RAW-SHA push that advances the target to EXACTLY the re-checked commit — robust to the local
            // promote branch being reaped later, and it never routes through pushBranch's target arg.
            await d.pushBranch(project.repoPath, "origin", ready.promoteBranch);
            return {
                pushedRefs: [ready.promoteBranch],
                commands: [`git push origin ${ready.validatedSha}:refs/heads/${targetBranch}`],
            };
        }
        case "strict": {
            // Push NOTHING. Hand the full local sequence the human runs by hand.
            return {
                pushedRefs: [],
                commands: [
                    `git fetch origin ${targetBranch}`,
                    `git switch -c promote origin/${targetBranch}`,
                    `git merge --no-ff --no-edit ${integrationBranch}`,
                    project.checkCommand,
                    `git push origin promote:${targetBranch}`,
                ],
            };
        }
    }
}
