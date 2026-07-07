// src/main/engine/prompt.ts
// Builds the three things the engine feeds each iteration (spec §5.5): the /goal directive
// (the -p arg), the static ritual (.ralph/INSTRUCTIONS.md), and the progress.md seed. Pure —
// no IO — so runTask imports it directly rather than taking it as a dependency.
import type { Project, Task } from "../../shared/types";

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

// The -p argument: the /goal condition + a short frame pointing at the .ralph files, plus the
// engine's ground-truth prior-gate failure on retry — the whole string kept under PROMPT_BUDGET
// (an oversized /goal is rejected outright by the CLI, wasting the iteration).
export function buildGoalPrompt(project: Project, task: Task, priorFailure?: string): string {
    const accInline = task.acceptance.join("; ");
    // Re-enable the spec §5.5 no-out-of-scope clause from the per-task scopeHint (M2 deferred it).
    const scopeClause = task.scopeHint ? `. No files outside \`${task.scopeHint}\` are changed` : "";
    const condition = `The project check \`${project.checkCommand}\` exits 0 AND every one of these acceptance commands exits 0, all demonstrated in this transcript: ${accInline}${scopeClause}`;
    const frame = `/goal ${condition}

You are working task "${task.title}".

Your full directive is in .ralph/TASK.md — read it first, then .ralph/INSTRUCTIONS.md and .ralph/progress.md, and follow the ritual.`;
    if (!priorFailure) return frame;

    const wrap = (body: string) => `\n\nThe previous iteration's gate failed. The engine re-ran it independently and got:\n\`\`\`\n${body}\n\`\`\`\nFix this before anything else.`;
    const marker = "…(truncated)\n";
    const room = PROMPT_BUDGET - frame.length - wrap("").length;
    if (room <= marker.length) return frame; // pathological frame — drop the evidence, never the budget
    const body = priorFailure.length > room
        ? `${marker}${priorFailure.slice(-(room - marker.length))}`
        : priorFailure;
    return `${frame}${wrap(body)}`;
}
