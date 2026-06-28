// src/main/engine/spawn.ts
import { randomUUID } from "node:crypto";
import { run, type ExecFn } from "./exec";

export interface SpawnOptions { model?: string; extraArgs?: string[]; idleTimeoutMs?: number; sessionId?: string; }
export interface SpawnResult { ok: boolean; output: string; sessionId: string | null; stalled: boolean; }

// The shape of the stream-json events we read (confirmed by the build-time spike, Task 1).
interface StreamEvent {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
    result?: string;
}

// THE single chokepoint for launching Claude. M6 swaps the `claude` invocation for
// `docker run … claude` here and nowhere else. M2: spawn with a minimal stream-json transport,
// consumed only for an idle-timer stall detector (via exec) and per-iteration session-id.
export async function spawnAgent(
    worktreePath: string,
    prompt: string,
    opts: SpawnOptions = {},
    exec: ExecFn = run,
): Promise<SpawnResult> {
    const sessionId = opts.sessionId ?? randomUUID();
    let parsedSessionId: string | null = null;
    const assistantText: string[] = [];

    const onLine = (line: string) => {
        let evt: StreamEvent;
        try { evt = JSON.parse(line) as StreamEvent; } catch { return; }
        if (evt.type === "system" && evt.subtype === "init" && typeof evt.session_id === "string") {
            parsedSessionId = evt.session_id;
        }
        if (evt.type === "assistant" && evt.message?.content) {
            for (const b of evt.message.content) if (b.type === "text" && typeof b.text === "string") assistantText.push(b.text);
        }
        if (evt.type === "result" && typeof evt.result === "string") assistantText.push(evt.result);
    };

    const args = [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--session-id", sessionId,
        "--permission-mode", "auto",
        ...(opts.model ? ["--model", opts.model] : []),
        ...(opts.extraArgs ?? []),
    ];
    const res = await exec("claude", args, { cwd: worktreePath, idleTimeoutMs: opts.idleTimeoutMs, onLine });

    return {
        ok: res.code === 0 && !res.timedOut && res.idleTimedOut !== true,
        output: assistantText.join("\n").trim() || `${res.stdout}\n${res.stderr}`.trim(),
        sessionId: parsedSessionId ?? sessionId,
        stalled: res.idleTimedOut === true,
    };
}
