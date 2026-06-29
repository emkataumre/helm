// src/main/engine/spawn.ts
import { randomUUID } from "node:crypto";
import { run, type ExecFn } from "./exec";
import type { SnapshotEvent, TokenTotals } from "../../shared/types";

export interface SpawnOptions {
    model?: string;
    extraArgs?: string[];
    idleTimeoutMs?: number;
    sessionId?: string;
    iterationIndex?: number;            // stamped into the SnapshotEvents this spawn emits (default 0)
    onEvent?: (e: SnapshotEvent) => void; // translate stream events → snapshot events
    logSink?: (line: string) => void;   // called for EVERY raw line (the durable per-iteration log)
}
export interface SpawnResult {
    ok: boolean;
    output: string;
    sessionId: string | null;
    stalled: boolean;
    usage: TokenTotals;                 // cumulative session totals from the result event (Task 1 spike)
    durationMs: number | null;
}

// The shape of the stream-json events we read (confirmed by the build-time spike, Task 1).
interface StreamEvent {
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
    result?: string;
    total_cost_usd?: number;
    duration_ms?: number;
    // The terminal result event's CUMULATIVE session usage — read once (not summed per message).
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

// THE single chokepoint for launching Claude. M6 swaps the `claude` invocation for
// `docker run … claude` here and nowhere else. M3: consume the rich stream — token accounting
// (from the terminal result event), per-iteration activity events (assistant/tool-use), and a
// raw NDJSON log of every line — on top of M2's session-id capture + idle-timer stall detector.
export async function spawnAgent(
    worktreePath: string,
    prompt: string,
    opts: SpawnOptions = {},
    exec: ExecFn = run,
): Promise<SpawnResult> {
    const sessionId = opts.sessionId ?? randomUUID();
    const index = opts.iterationIndex ?? 0;
    let parsedSessionId: string | null = null;
    const assistantText: string[] = [];
    const usage: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
    let durationMs: number | null = null;

    const onLine = (line: string) => {
        opts.logSink?.(line); // every raw line, parseable or not — the durable archive
        let evt: StreamEvent;
        try { evt = JSON.parse(line) as StreamEvent; } catch { return; }

        if (evt.type === "system" && evt.subtype === "init" && typeof evt.session_id === "string") {
            parsedSessionId = evt.session_id;
        }
        if (evt.type === "assistant" && evt.message?.content) {
            for (const b of evt.message.content) {
                if (b.type === "text" && typeof b.text === "string") {
                    assistantText.push(b.text);
                    opts.onEvent?.({ type: "assistant", index, text: b.text });
                } else if (b.type === "tool_use" && typeof b.name === "string") {
                    opts.onEvent?.({ type: "tool-use", index, name: b.name });
                }
            }
        }
        if (evt.type === "result") {
            if (typeof evt.result === "string") assistantText.push(evt.result);
            // Per the Task 1 spike, result.usage is the cumulative session total — read once here.
            // (Defensive fallback if a future CLI makes it non-cumulative: sum the per-message
            //  assistant.message.usage.output_tokens instead. Not needed today — 294 ≠ summed 72.)
            const u = evt.usage;
            if (u) {
                usage.input = u.input_tokens ?? 0;
                usage.output = u.output_tokens ?? 0;
                usage.cacheRead = u.cache_read_input_tokens ?? 0;
                usage.cacheCreation = u.cache_creation_input_tokens ?? 0;
            }
            if (typeof evt.total_cost_usd === "number") usage.costUsd = evt.total_cost_usd;
            if (typeof evt.duration_ms === "number") durationMs = evt.duration_ms;
            opts.onEvent?.({ type: "usage", index, tokens: { ...usage }, durationMs: durationMs ?? undefined, sessionId: parsedSessionId ?? sessionId });
        }
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
        usage,
        durationMs,
    };
}
