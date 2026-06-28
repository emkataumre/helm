// tests/engine/spawn.test.ts
import { describe, it, expect } from "vitest";
import { spawnAgent } from "../../src/main/engine/spawn";
import type { ExecFn, ExecResult } from "../../src/main/engine/exec";

const INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "sess-xyz" });
const MSG = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "did the work" }] } });

describe("spawnAgent stream-json", () => {
    it("parses the init session id, collects assistant text, and reports ok", async () => {
        const exec: ExecFn = async (_cmd, _args, opts) => {
            opts?.onLine?.(INIT);
            opts?.onLine?.(MSG);
            return { code: 0, stdout: "", stderr: "", timedOut: false, idleTimedOut: false };
        };
        const res = await spawnAgent("/wt", "/goal do it", {}, exec);
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
});
