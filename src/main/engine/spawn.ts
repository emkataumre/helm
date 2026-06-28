// src/main/engine/spawn.ts
import { run, type ExecFn } from "./exec";

export interface SpawnOptions { model?: string; extraArgs?: string[]; timeoutMs?: number; }
export interface SpawnResult { ok: boolean; output: string; sessionId: string | null; }

// THE single chokepoint for launching Claude. M6 swaps the `claude` invocation for
// `docker run … claude` here and nowhere else.
export async function spawnAgent(
    worktreePath: string,
    prompt: string,
    opts: SpawnOptions = {},
    exec: ExecFn = run,
): Promise<SpawnResult> {
    const args = [
        "-p", prompt,
        "--permission-mode", "auto",
        ...(opts.model ? ["--model", opts.model] : []),
        ...(opts.extraArgs ?? []),
    ];
    const res = await exec("claude", args, { cwd: worktreePath, timeoutMs: opts.timeoutMs });
    return { ok: res.code === 0 && !res.timedOut, output: `${res.stdout}\n${res.stderr}`.trim(), sessionId: null };
}
