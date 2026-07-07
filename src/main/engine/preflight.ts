// src/main/engine/preflight.ts
// M11 dynamic pre-flight — the throwaway-worktree SIBLING of runMergeStage / runPromoteStage. Static pre-flight
// (M10) only reads names; this EXECUTES each acceptance command once, in a throwaway worktree off the integration
// tip, and classifies the outcome so approve can be informed consent. It shares the promote skeleton — throwaway
// worktree, setup, always-cleanup — but its OUTCOME is a read-only report: it advances NO ref and pushes nothing.
//
// The non-negotiable, STRUCTURAL never-advance (the promote-mirrored safety property): PreflightDeps simply has
// no advanceBranch/pushBranch seam, so the stage physically cannot move a ref. The verify slice inspects the
// injected deps + recorded ops to prove it. Pure DI — no Electron, no direct git — so it unit-tests with fakes.
import type { Project, PlanDraft, PreflightVerdict, PreflightReport, PreflightCommandVerdict, PreflightLevel } from "../../shared/types";
export type { PreflightReport, PreflightCommandVerdict, PreflightLevel };

// The injected surface: reads + the throwaway-worktree lifecycle + a single-command runner. NO advanceBranch /
// pushBranch — advancing a ref is structurally impossible here (the never-advance invariant, promote-style).
export interface PreflightDeps {
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

export const isWarn = (l: PreflightLevel): boolean => l === "warn-missing" || l === "warn-already-green";

// Classify ONE command's outcome. The disambiguation the plan calls for: exit 0 → already-green; otherwise a
// non-zero exit is a legit red (ok-red) UNLESS the static verdict says the name is missing (an unknown npm
// script / non-existent path) or the shell couldn't even spawn it (code < 0) — then it's warn-missing.
function classify(r: { code: number; timedOut: boolean }, staticWarn: boolean): PreflightLevel {
    if (r.code === 0 && !r.timedOut) return "warn-already-green";
    if (r.code < 0 || staticWarn) return "warn-missing";
    return "ok-red";
}

// Execute a draft's acceptance commands against reality and classify each. `staticVerdicts` are M10's static
// judgements for the SAME draft (the missing-script cross-check). Advances/pushes nothing; always cleans up.
export async function runPreflight(project: Project, draft: PlanDraft, staticVerdicts: PreflightVerdict[], deps: PreflightDeps): Promise<PreflightReport> {
    const repo = project.repoPath;

    // Static verdict per command (first wins; the static judge is a pure fn of command+ctx, so duplicates agree).
    const staticByCommand = new Map<string, PreflightVerdict>();
    for (const v of staticVerdicts) if (!staticByCommand.has(v.command)) staticByCommand.set(v.command, v);

    // Dedupe commands across tasks (first-seen order), fanning each command's slugs — one run, one verdict.
    const order: string[] = [];
    const slugsByCommand = new Map<string, string[]>();
    for (const t of draft.tasks) for (const command of t.acceptance) {
        let slugs = slugsByCommand.get(command);
        if (!slugs) { slugs = []; slugsByCommand.set(command, slugs); order.push(command); }
        if (!slugs.includes(t.slug)) slugs.push(t.slug);
    }

    // A UNIQUE throwaway branch off the integration TIP (unique short-sha so a re-run of a moved tip can't
    // collide). The branch is temp — cleanup deletes it (keepBranch false), unlike promote which keeps its branch.
    const integrationSha = await deps.revParse(repo, project.integrationBranch);
    const branch = `helm/preflight-${project.id}-${integrationSha.slice(0, SHORT)}`;

    let worktreePath: string | null = null;
    try {
        worktreePath = await deps.createWorktree(repo, project.integrationBranch, branch, project.worktreeDir);

        // A fresh worktree has no gitignored deps — install them (the M4 lesson). If setup FAILS we can't trust
        // any command's exit in a broken env, so every command becomes unverifiable (warn-missing) and none run.
        let setupFailure: string | null = null;
        if (project.setupCommand) {
            const s = await deps.runSetup(worktreePath, project.setupCommand, deps.checkTimeoutMs);
            if (!s.ok) setupFailure = tail(s.output);
        }

        const verdicts: PreflightCommandVerdict[] = [];
        for (const command of order) {
            const slugs = slugsByCommand.get(command)!;
            const stat = staticByCommand.get(command);
            if (setupFailure != null) {
                verdicts.push({
                    command, taskSlugs: slugs, level: "warn-missing", exitCode: null,
                    tail: `environment setup failed — could not validate:\n${setupFailure}`,
                    reason: "the project setupCommand failed in the throwaway worktree",
                });
                continue;
            }
            const r = await deps.runCommand(worktreePath, command, deps.checkTimeoutMs);
            const level = classify(r, stat?.level === "warn");
            verdicts.push({
                command, taskSlugs: slugs, level, exitCode: r.code, tail: tail(r.output),
                ...(level === "warn-missing" && stat?.reason ? { reason: stat.reason } : {}),
                ...(level === "warn-missing" && stat?.suggestion ? { suggestion: stat.suggestion } : {}),
            });
        }
        return { ran: true, verdicts, warnCount: verdicts.filter((v) => isWarn(v.level)).length };
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
    return unackedWarnCommands(report, acks).length === 0;
}
