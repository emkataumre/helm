// src/main/engine/preflight.ts
// M11 dynamic pre-flight — the throwaway-worktree SIBLING of runMergeStage / runPromoteStage. Static pre-flight
// (M10) only reads names; this EXECUTES each acceptance command once, in a throwaway worktree off the integration
// tip, and classifies the outcome so approve can be informed consent. It shares the promote skeleton — throwaway
// worktree, setup, always-cleanup — but its OUTCOME is a read-only report: it advances NO ref and pushes nothing.
//
// The non-negotiable, STRUCTURAL never-advance (the promote-mirrored safety property): PreflightDeps simply has
// no advanceBranch/pushBranch seam, so the stage physically cannot move a ref. The verify slice inspects the
// injected deps + recorded ops to prove it. Pure DI — no Electron, no direct git — so it unit-tests with fakes.
import type { Project, PlanDraft, PreflightVerdict, PreflightReport, PreflightCommandVerdict, PreflightLevel, PreflightProgress, PreflightRole } from "../../shared/types";
import { isWarnLevel } from "../../shared/types";
export type { PreflightReport, PreflightCommandVerdict, PreflightLevel };

// Optional live-run hooks (the overhaul's cancel + progress seam). Deliberately NOT part of PreflightDeps —
// the deps surface is pinned by the never-advance verify slice, and these are observers, not capabilities.
// The signal is only CHECKED between commands here; the ipc's runCommand wrapper closes over the same signal
// so an in-flight command is killed too (exec.ts already supports it).
export interface PreflightRunHooks { signal?: AbortSignal; onProgress?: (p: PreflightProgress) => void }

// The injected surface: reads + the throwaway-worktree lifecycle + a single-command runner. NO advanceBranch /
// pushBranch — advancing a ref is structurally impossible here (the never-advance invariant, promote-style).
// ensureBranch is create-if-absent only (it never moves an existing ref), needed because pre-flight can run on a
// FRESH project whose integration branch doesn't exist yet — the engine only creates it when the first task runs.
export interface PreflightDeps {
    ensureBranch: (repo: string, branch: string, createFrom: string) => Promise<void>;
    revParse: (repo: string, ref: string) => Promise<string>;
    createWorktree: (repo: string, from: string, branch: string, worktreeDir: string) => Promise<string>;
    runSetup: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ ok: boolean; output: string }>;
    runCommand: (worktreePath: string, command: string, timeoutMs: number) => Promise<{ code: number; timedOut: boolean; output: string }>;
    removeWorktree: (repo: string, path: string, branch: string, keepBranch: boolean) => Promise<void>;
    checkTimeoutMs: number;
}

const TAIL = 1200;
const tail = (s: string): string => { const t = s.trim(); return t.length > TAIL ? `…(truncated)\n${t.slice(-TAIL)}` : t; };
const SHORT = 12; // integration short-sha length in the throwaway branch name (unique per tip, like promote)

export const isWarn = isWarnLevel; // re-export under the engine's historical name (one warn rule, shared)

// Classify ONE command's outcome, ROLE-AWARE (the 2026-07-14 vocabulary overhaul — the matrix in the design
// doc). `missing` = the shell couldn't spawn it (code < 0) or the static verdict says the name doesn't exist.
//  · regression: green is EXPECTED (ok-pass); red means the integration tip itself is broken (warn-tip-red);
//    missing means the suite is misdeclared (warn-missing).
//  · proof: missing is EXPECTED (ok-planned — this task creates it); green is the REAL fake-green
//    (warn-already-green); red is the TDD ideal (ok-red).
//  · untagged (legacy): the original one-size semantics, unchanged — old drafts never get weaker gating.
function classify(r: { code: number; timedOut: boolean }, staticWarn: boolean, role: PreflightRole | null): PreflightLevel {
    const green = r.code === 0 && !r.timedOut;
    const missing = r.code < 0 || staticWarn;
    if (role === "regression") {
        if (green) return "ok-pass";
        if (missing) return "warn-missing";
        return "warn-tip-red";
    }
    if (role === "proof") {
        if (missing) return "ok-planned";
        if (green) return "warn-already-green";
        return "ok-red";
    }
    if (green) return "warn-already-green";
    if (missing) return "warn-missing";
    return "ok-red";
}

// Execute a draft's acceptance commands against reality and classify each. `staticVerdicts` are M10's static
// judgements for the SAME draft (the missing-script cross-check). Advances/pushes nothing; always cleans up.
export async function runPreflight(project: Project, draft: PlanDraft, staticVerdicts: PreflightVerdict[], deps: PreflightDeps, hooks: PreflightRunHooks = {}): Promise<PreflightReport> {
    const repo = project.repoPath;

    // Static verdict per command (first wins; the static judge is a pure fn of command+ctx, so duplicates agree).
    const staticByCommand = new Map<string, PreflightVerdict>();
    for (const v of staticVerdicts) if (!staticByCommand.has(v.command)) staticByCommand.set(v.command, v);

    // Dedupe commands across tasks (first-seen order), fanning each command's slugs — one run, one verdict.
    // Roles merge with PROOF WINNING a conflict (same command declared proof by one task, regression by
    // another → the stricter reading: it must be able to prove, so green warns).
    const order: string[] = [];
    const slugsByCommand = new Map<string, string[]>();
    const roleByCommand = new Map<string, PreflightRole | null>();
    for (const t of draft.tasks) for (const [j, command] of t.acceptance.entries()) {
        let slugs = slugsByCommand.get(command);
        if (!slugs) { slugs = []; slugsByCommand.set(command, slugs); order.push(command); }
        if (!slugs.includes(t.slug)) slugs.push(t.slug);
        const role = t.acceptanceRoles?.[j] ?? null;
        const prev = roleByCommand.get(command) ?? null;
        roleByCommand.set(command, prev === "proof" || role === "proof" ? "proof" : prev ?? role);
    }
    // Role-tagged drafts get the per-task no-proof consent warn; legacy (fully untagged) drafts are exempt —
    // they're already warn-noisy by definition, and the rule would double-tax them.
    const rolesDeclared = draft.tasks.some((t) => (t.acceptanceRoles ?? []).some((r) => r != null));

    // A fresh project's integration branch doesn't exist until the first task runs (the M10-acceptance finding:
    // revParse threw here and the UI hung on "loading"). Create-if-absent off the target tip — exactly the tip
    // the first task will branch from — so pre-flight validates against the same reality. Never moves an
    // existing ref (the never-advance invariant holds; ensureBranch is create-only).
    await deps.ensureBranch(repo, project.integrationBranch, project.targetBranch);

    // A UNIQUE throwaway branch off the integration TIP (unique short-sha so a re-run of a moved tip can't
    // collide). The branch is temp — cleanup deletes it (keepBranch false), unlike promote which keeps its branch.
    const integrationSha = await deps.revParse(repo, project.integrationBranch);
    const branch = `helm/preflight-${project.id}-${integrationSha.slice(0, SHORT)}`;

    let worktreePath: string | null = null;
    try {
        worktreePath = await deps.createWorktree(repo, project.integrationBranch, branch, project.worktreeDir);

        // A fresh worktree has no gitignored deps — install them (the M4 lesson). If setup FAILS, nothing can
        // be observed in a broken env → the report is BLOCKED (2026-07-14): no verdicts, no ack path, Confirm
        // hard-blocks (BLOCKED is never a pass). Pre-overhaul this dressed up as ackable warn-missing — a
        // human could ack straight through a broken environment.
        if (project.setupCommand) {
            const s = await deps.runSetup(worktreePath, project.setupCommand, deps.checkTimeoutMs);
            if (!s.ok) return { ran: true, integrationSha, blocked: { setupTail: tail(s.output) }, verdicts: [], warnCount: 0 };
        }

        const verdicts: PreflightCommandVerdict[] = [];
        for (const [i, command] of order.entries()) {
            const slugs = slugsByCommand.get(command)!;
            const stat = staticByCommand.get(command);
            // A cancel between commands aborts the whole run (the finally still reaps the worktree); a cancel
            // DURING a command is the ipc wrapper's job (same signal, exec kills the child, we throw here next).
            if (hooks.signal?.aborted) throw new Error("pre-flight cancelled");
            hooks.onProgress?.({ index: i, total: order.length, command });
            const r = await deps.runCommand(worktreePath, command, deps.checkTimeoutMs);
            if (hooks.signal?.aborted) throw new Error("pre-flight cancelled");
            const level = classify(r, stat?.level === "warn", roleByCommand.get(command) ?? null);
            verdicts.push({
                command, taskSlugs: slugs, level, exitCode: r.code, timedOut: r.timedOut, tail: tail(r.output),
                ...(level === "warn-missing" && stat?.reason ? { reason: stat.reason } : {}),
                ...(level === "warn-missing" && stat?.suggestion ? { suggestion: stat.suggestion } : {}),
            });
        }

        // The per-task consent warn (role-tagged drafts only): a task with NO proof command cannot be told
        // apart from not-started by the gate — the $29 duplicate-plan lesson made an explicit, ackable line.
        // Synthetic verdict, ack key `no-proof:<slug>` (never collides with a real command string).
        if (rolesDeclared) {
            for (const t of draft.tasks) {
                const hasProof = t.acceptance.some((_, j) => (t.acceptanceRoles?.[j] ?? null) === "proof");
                if (!hasProof) {
                    verdicts.push({
                        command: `no-proof:${t.slug}`, taskSlugs: [t.slug], level: "warn-no-proof", exitCode: null, tail: "",
                        reason: "no command can prove this task — done and not-started look identical to the gate",
                    });
                }
            }
        }
        return { ran: true, integrationSha, verdicts, warnCount: verdicts.filter((v) => isWarn(v.level)).length };
    } finally {
        // Always remove the throwaway worktree AND its temp branch — on every path, including a mid-run throw.
        if (worktreePath) await deps.removeWorktree(repo, worktreePath, branch, false);
    }
}

// ── The pure approve-decision core (approve-requires-acks) ──────────────────────────────────────────
// Acks are keyed by COMMAND string (the deduped unit). The ipc re-runs pre-flight from disk, then applies these
// against the FRESH report — the renderer's report/acks claim is never trusted. Approve may proceed only when
// every warn command is acked; ok-red never needs an ack.
export function unackedWarnCommands(report: PreflightReport, acks: string[]): string[] {
    const acked = new Set(acks);
    return report.verdicts.filter((v) => isWarn(v.level) && !acked.has(v.command)).map((v) => v.command);
}
export function approvalPermitted(report: PreflightReport, acks: string[]): boolean {
    if (report.blocked) return false; // BLOCKED is never a pass — no ack can turn "couldn't observe" into consent
    return unackedWarnCommands(report, acks).length === 0;
}
