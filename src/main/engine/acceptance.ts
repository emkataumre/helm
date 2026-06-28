// src/main/engine/acceptance.ts
// Layer B — executable acceptance. Runs a task's "prove it" command list in its worktree,
// sequentially, stopping at the first non-zero exit or timeout. A pure leaf — knows nothing
// about the loop, iterations, or reporting. Ported from Pail's acceptance.ts.
import { run, type ExecFn } from "./exec";

export interface AcceptanceResult {
    ok: boolean;
    failedCommand?: string;
    output: string;
}

export async function runAcceptance(
    worktreePath: string,
    commands: string[],
    timeoutMs: number,
    exec: ExecFn = run,
): Promise<AcceptanceResult> {
    const parts: string[] = [];
    for (const command of commands) {
        const res = await exec(command, [], { cwd: worktreePath, timeoutMs, shell: true });
        const out = `${res.stdout}\n${res.stderr}`.trim();
        parts.push(`$ ${command}\n${out}`.trim());
        if (res.code !== 0 || res.timedOut) {
            return { ok: false, failedCommand: command, output: parts.join("\n\n") };
        }
    }
    return { ok: true, output: parts.join("\n\n") };
}
