// tests/engine/spawn.test.ts
import { describe, it, expect } from "vitest";
import { spawnAgent } from "../../src/main/engine/spawn";
import type { ExecFn } from "../../src/main/engine/exec";
import type { SnapshotEvent } from "../../src/shared/types";

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-xyz" });
const MSG = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did the work" }] } });
const TOOL = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
// Shape confirmed by the Task 1 spike: result.usage is the CUMULATIVE session total.
const RESULT = JSON.stringify({
    type: "result", subtype: "success", result: "DONE", duration_ms: 46460, total_cost_usd: 0.3259895,
    usage: { input_tokens: 14861, output_tokens: 294, cache_read_input_tokens: 85709, cache_creation_input_tokens: 20148 },
});

const linesExec = (lines: string[]): ExecFn => async (_cmd, _args, opts) => {
    for (const l of lines) opts?.onLine?.(l);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
};

describe("spawnAgent stream-json", () => {
    it("parses the init session id, collects assistant text, and reports ok", async () => {
        const res = await spawnAgent("/wt", "/goal do it", {}, linesExec([INIT, MSG]));
        expect(res.ok).toBe(true);
        expect(res.sessionId).toBe("sess-xyz");
        expect(res.output).toContain("did the work");
        expect(res.stalled).toBe(false);
    });

    it("passes the stream-json + auto-mode flags and an idle timeout", async () => {
        let seenArgs: string[] = [];
        let seenIdle: number | undefined;
        const exec: ExecFn = async (_cmd, args, opts) => { seenArgs = args ?? []; seenIdle = opts?.idleTimeoutMs; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
        await spawnAgent("/wt", "/goal do it", { idleTimeoutMs: 1234 }, exec);
        expect(seenArgs).toContain("--output-format");
        expect(seenArgs).toContain("stream-json");
        expect(seenArgs).toContain("--verbose");
        expect(seenArgs).toContain("auto");
        expect(seenIdle).toBe(1234);
    });

    it("reports stalled (and not-ok) when the stream went idle", async () => {
        const exec: ExecFn = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, idleTimedOut: true });
        const res = await spawnAgent("/wt", "/goal do it", {}, exec);
        expect(res.ok).toBe(false);
        expect(res.stalled).toBe(true);
    });

    // ── M3 additions ────────────────────────────────────────────────────────────────────────
    it("extracts cumulative usage + duration from the result event into SpawnResult", async () => {
        const res = await spawnAgent("/wt", "/goal x", {}, linesExec([INIT, MSG, RESULT]));
        expect(res.usage).toEqual({ input: 14861, output: 294, cacheRead: 85709, cacheCreation: 20148, costUsd: 0.3259895 });
        expect(res.durationMs).toBe(46460);
    });

    it("has zeroed usage and null duration when no result event arrives", async () => {
        const res = await spawnAgent("/wt", "/goal x", {}, linesExec([INIT, MSG]));
        expect(res.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 });
        expect(res.durationMs).toBeNull();
    });

    it("translates stream events to snapshot events stamped with the iteration index", async () => {
        const events: SnapshotEvent[] = [];
        await spawnAgent("/wt", "/goal x", { iterationIndex: 2, onEvent: (e) => events.push(e) }, linesExec([INIT, MSG, TOOL, RESULT]));
        expect(events.map((e) => e.type)).toEqual(["assistant", "tool-use", "usage"]);
        for (const e of events) if (e.type !== "status") expect(e.index).toBe(2);
        const usage = events.find((e) => e.type === "usage");
        expect(usage).toMatchObject({ type: "usage", index: 2, tokens: { output: 294 }, durationMs: 46460, sessionId: "sess-xyz" });
    });

    it("forwards EVERY raw line to logSink, including unparseable ones", async () => {
        const lines: string[] = [];
        await spawnAgent("/wt", "/goal x", { logSink: (l) => lines.push(l) }, linesExec([INIT, MSG, RESULT, "not json"]));
        expect(lines).toEqual([INIT, MSG, RESULT, "not json"]);
    });

    // ── M5: the drop-in interrupt is threaded through the spawn chokepoint ────────────────────
    it("forwards the AbortSignal straight to exec", async () => {
        const controller = new AbortController();
        let seenSignal: AbortSignal | undefined;
        const exec: ExecFn = async (_cmd, _args, opts) => { seenSignal = opts?.signal; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
        await spawnAgent("/wt", "/goal x", { signal: controller.signal }, exec);
        expect(seenSignal).toBe(controller.signal);
    });

    it("surfaces aborted on the result when exec reports it (informational)", async () => {
        const exec: ExecFn = async () => ({ code: -1, stdout: "", stderr: "", timedOut: false, aborted: true });
        const res = await spawnAgent("/wt", "/goal x", {}, exec);
        expect(res.aborted).toBe(true);
        expect(res.ok).toBe(false);
    });
});
