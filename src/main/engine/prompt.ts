// src/main/engine/prompt.ts
// Builds the three things the engine feeds each iteration (spec §5.5): the /goal directive
// (the -p arg), the static ritual (.ralph/INSTRUCTIONS.md), and the progress.md seed. Pure —
// no IO — so runTask imports it directly rather than taking it as a dependency.
import type { FailureKind, Project, Task } from "../../shared/types";

// M18: what the retry block is ABOUT changes how it must be framed — a failed gate ("fix this"), a
// lost merge race ("integration advanced; merge it in"), or a resumed task's parked reason ("a human
// intervened; verify it's addressed"). The loop constructs these; the framing picks the wrap text,
// and merge-loss additionally extends the /goal condition itself (see buildGoalPrompt).
export interface PriorFailure {
    framing: "gate" | "merge-loss" | "parked";
    body: string; // the evidence: gate output tail, merge-stage reason, or the parked failureReason
    kind?: Extract<FailureKind, "merge-conflict" | "recheck-failed">; // merge-loss only
}

// The CLI hard-caps a /goal condition at 4000 characters — and it counts EVERYTHING after "/goal "
// in the -p string (pinned live 2026-07-07, the M12 dogfood incident: a 3.4k self-contained intent
// + the retry block → "Goal condition is limited to 4000 characters", a synthetic zero-work turn on
// every retry, read by the loop as no-progress). So the prompt is a short fixed-size frame pointing
// at .ralph/TASK.md (budget-free — it carries the full directive), and the retry evidence is clamped
// to whatever room the frame leaves.
const PROMPT_BUDGET = 3800;

// The static "Ralph ritual", written once into .ralph/INSTRUCTIONS.md.
export function buildInstructions(): string {
    return `# Ralph ritual — read this first, every iteration

You are one iteration of an autonomous loop driving a single task to a verifiable "done".
Each iteration is a FRESH session; the only memory across iterations is this worktree's git
history and the notes in .ralph/progress.md.

1. Read .ralph/progress.md first. It is your own running log — current focus, what's done,
   what's left, and approaches already ruled out. Do not re-walk a ruled-out path.
2. Make progress on the task — the full directive is in .ralph/TASK.md. Stay within its scope.
3. Verify your own work before stopping: run the project check and every acceptance command
   yourself and make them pass. The engine re-runs them independently — a transcript that
   merely claims success is caught and fed back to the next iteration as a failure.
4. Update .ralph/progress.md LAST, before you finish: refresh Current focus / Done /
   Remaining / Tried & ruled out so the next iteration starts where you left off.
   Keep these four headings verbatim — \`## Current focus\`, \`## Done\`, \`## Remaining\`,
   \`## Tried & ruled out\` — the cockpit parses them to render your progress.
`;
}

// The per-repo context seam: a repo-committed .helm/context.md (a user-maintained manifest of
// pointers to key files/docs) rides into every task's INSTRUCTIONS.md VERBATIM, appended under its
// own heading so the ritual stays byte-identical above it. Pure — ralph.ts does the read and calls
// this only when the manifest exists and is non-blank; absent/blank → the ritual ships unmodified.
export function withProjectContext(instructions: string, context: string): string {
    const sep = instructions.endsWith("\n") ? "" : "\n";
    return `${instructions}${sep}
# Project context — from this repo's .helm/context.md

${context}`;
}

// The initial .ralph/progress.md, seeded once; the agent owns it thereafter.
export function seedProgress(task: Task): string {
    return `# Progress — ${task.title}

## Current focus
(not started)

## Done
(nothing yet)

## Remaining
- Achieve the task's goal and make the project check and every acceptance command pass.

## Tried & ruled out
(nothing yet)
`;
}

// The full task directive, seeded once into .ralph/TASK.md at worktree setup (write-if-absent,
// like INSTRUCTIONS). It carries the intent VERBATIM — which may be arbitrarily long (the planner
// writes self-contained intents) — precisely because the -p prompt no longer can (PROMPT_BUDGET).
export function buildTaskDirective(task: Task): string {
    const accLines = task.acceptance.map((c) => `- ${c}`).join("\n");
    return `# Task — ${task.title}

${task.intent}

## Acceptance commands (the engine re-runs these independently after you stop — make them pass)
${accLines}
`;
}

// The post-green review /goal (M19 post-green review phase, confirm-only). When the work has already
// gone green, the loop spawns this REVIEW-FRAMED session instead of another work turn: a fresh, independent
// agent re-runs the gates and judges whether the work truly and completely satisfies the task — WITHOUT
// changing the implementation (this slice is confirm-only; a clean pass advances toward finalize). Kept
// well under PROMPT_BUDGET. The leading "You are REVIEWING" line is the stable frame the loop/tests key
// off to tell a review spawn apart from a work spawn at the chokepoint.
export function buildReviewPrompt(project: Project, task: Task): string {
    const accInline = task.acceptance.join("; ");
    return `/goal You are REVIEWING already-green work on task "${task.title}" — a confirm-only review pass, NOT a work turn. Independently re-verify that the project check \`${project.checkCommand}\` exits 0 AND every one of these acceptance commands exits 0, all demonstrated in this transcript: ${accInline}. Then judge whether the committed work correctly and completely satisfies the task's intent. Do NOT change the implementation — only confirm and report your judgement.

You are reviewing task "${task.title}".

Your full directive is in .ralph/TASK.md — read it first, then .ralph/INSTRUCTIONS.md and .ralph/progress.md. This is a review pass: verify and judge, do not re-implement.`;
}

// The -p argument: the /goal condition + a short frame pointing at the .ralph files, plus the
// engine's ground-truth prior failure on retry (framing-aware, M18) — the whole string kept under
// PROMPT_BUDGET (an oversized /goal is rejected outright by the CLI, wasting the iteration).
export function buildGoalPrompt(project: Project, task: Task, priorFailure?: PriorFailure): string {
    const accInline = task.acceptance.join("; ");
    // Re-enable the spec §5.5 no-out-of-scope clause from the per-task scopeHint (M2 deferred it).
    const scopeClause = task.scopeHint ? `. No files outside \`${task.scopeHint}\` are changed` : "";
    // M18 no-op trap: a merge-loser's gates STILL PASS in its worktree, so on a merge-loss retry the
    // condition itself must demand the integration merge be demonstrated — otherwise "goal met" is
    // satisfiable with zero work and the loop burns a mutex-serialized merge round per wasted retry.
    const mergeClause = priorFailure?.framing === "merge-loss"
        ? `\`git merge ${project.integrationBranch}\` has completed in this worktree with every conflict resolved, AND `
        : "";
    const condition = `${mergeClause}The project check \`${project.checkCommand}\` exits 0 AND every one of these acceptance commands exits 0, all demonstrated in this transcript: ${accInline}${scopeClause}`;
    const frame = `/goal ${condition}

You are working task "${task.title}".

Your full directive is in .ralph/TASK.md — read it first, then .ralph/INSTRUCTIONS.md and .ralph/progress.md, and follow the ritual.`;
    if (!priorFailure) return frame;

    const wraps: Record<PriorFailure["framing"], (body: string) => string> = {
        gate: (body) => `\n\nThe previous iteration's gate failed. The engine re-ran it independently and got:\n\`\`\`\n${body}\n\`\`\`\nFix this before anything else.`,
        "merge-loss": (body) => priorFailure.kind === "merge-conflict"
            ? `\n\nYour work went green but lost the merge race: integration advanced while you worked, and your branch now conflicts with the current \`${project.integrationBranch}\` tip. The merge stage reported:\n\`\`\`\n${body}\n\`\`\`\nRun \`git merge ${project.integrationBranch}\`, resolve every conflict, then make the gates green again.`
            : `\n\nYour work went green but lost the merge race: integration advanced while you worked, and your work no longer composes with the new tip — the engine's re-check on the merged result failed:\n\`\`\`\n${body}\n\`\`\`\nRun \`git merge ${project.integrationBranch}\`, reproduce the red locally, and fix it before anything else.`,
        parked: (body) => `\n\nThis task was previously parked for a human with this failure:\n\`\`\`\n${body}\n\`\`\`\nA human has since intervened in this worktree — verify the issue is addressed before continuing.`,
    };
    const wrap = wraps[priorFailure.framing];
    const marker = "…(truncated)\n";
    const room = PROMPT_BUDGET - frame.length - wrap("").length;
    if (room <= marker.length) return frame; // pathological frame — drop the evidence, never the budget
    const body = priorFailure.body.length > room
        ? `${marker}${priorFailure.body.slice(-(room - marker.length))}`
        : priorFailure.body;
    return `${frame}${wrap(body)}`;
}
