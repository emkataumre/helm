// src/main/engine/check.ts
import { run, type ExecFn } from "./exec";

export async function runCheck(
    worktreePath: string,
    checkCommand: string,
    timeoutMs: number,
    exec: ExecFn = run,
): Promise<{ green: boolean; timedOut: boolean; output: string }> {
    const res = await exec(checkCommand, [], { cwd: worktreePath, timeoutMs, shell: true });
    return {
        green: res.code === 0 && !res.timedOut,
        timedOut: res.timedOut,
        output: `${res.stdout}\n${res.stderr}`.trim(),
    };
}
