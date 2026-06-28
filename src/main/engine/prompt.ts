// src/main/engine/prompt.ts
// Builds the three things the engine feeds each iteration (spec §5.5): the /goal directive
// (the -p arg), the static ritual (.ralph/INSTRUCTIONS.md), and the progress.md seed. Pure —
// no IO — so runTask imports it directly rather than taking it as a dependency.
import type { Project, Task } from "../../shared/types";

// The static "Ralph ritual", written once into .ralph/INSTRUCTIONS.md.
export function buildInstructions(): string {
    return `# Ralph ritual — read this first, every iteration

You are one iteration of an autonomous loop driving a single task to a verifiable "done".
Each iteration is a FRESH session; the only memory across iterations is this worktree's git
history and the notes in .ralph/progress.md.

1. Read .ralph/progress.md first. It is your own running log — current focus, what's done,
   what's left, and approaches already ruled out. Do not re-walk a ruled-out path.
2. Make progress on the task in the prompt. Stay within the task's scope.
3. Verify your own work before stopping: run the project check and every acceptance command
   yourself and make them pass. The engine re-runs them independently — a transcript that
   merely claims success is caught and fed back to the next iteration as a failure.
4. Update .ralph/progress.md LAST, before you finish: refresh Current focus / Done /
   Remaining / Tried & ruled out so the next iteration starts where you left off.
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

// The -p argument: the /goal condition + the directive (intent + acceptance + read-the-ralph-
// files), plus the engine's ground-truth prior-gate failure on retry. The exact /goal arg form
// is confirmed by the build-time spike (plan Task 1); adjust here if the spike requires it.
export function buildGoalPrompt(project: Project, task: Task, priorFailure?: string): string {
    const accLines = task.acceptance.map((c) => `- ${c}`).join("\n");
    const accInline = task.acceptance.join("; ");
    const condition = `The project check \`${project.checkCommand}\` exits 0 AND every one of these acceptance commands exits 0, all demonstrated in this transcript: ${accInline}`;
    const priorBlock = priorFailure
        ? `\n\nThe previous iteration's gate failed. The engine re-ran it independently and got:\n\`\`\`\n${priorFailure}\n\`\`\`\nFix this before anything else.`
        : "";
    return `/goal ${condition}

You are working task "${task.title}".

${task.intent}

Acceptance commands (the engine re-runs these independently after you stop — make them pass):
${accLines}

First read .ralph/INSTRUCTIONS.md and .ralph/progress.md and follow the ritual.${priorBlock}`;
}
