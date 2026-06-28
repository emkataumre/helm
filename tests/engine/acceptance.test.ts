// tests/engine/acceptance.test.ts
import { describe, it, expect } from "vitest";
import { runAcceptance } from "../../src/main/engine/acceptance";
import type { ExecResult } from "../../src/main/engine/exec";

const ok = (): ExecResult => ({ code: 0, stdout: "ok", stderr: "", timedOut: false });
const fail = (): ExecResult => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });

describe("runAcceptance", () => {
    it("runs commands sequentially and passes when all exit 0", async () => {
        const calls: string[] = [];
        const exec = async (cmd: string) => { calls.push(cmd); return ok(); };
        const res = await runAcceptance("/wt", ["a", "b"], 1000, exec);
        expect(res.ok).toBe(true);
        expect(calls).toEqual(["a", "b"]);
    });

    it("stops at the first failing command and reports it", async () => {
        const calls: string[] = [];
        const exec = async (cmd: string) => { calls.push(cmd); return cmd === "b" ? fail() : ok(); };
        const res = await runAcceptance("/wt", ["a", "b", "c"], 1000, exec);
        expect(res.ok).toBe(false);
        expect(res.failedCommand).toBe("b");
        expect(calls).toEqual(["a", "b"]); // never reached "c"
    });

    it("treats a timeout as failure", async () => {
        const exec = async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", timedOut: true });
        const res = await runAcceptance("/wt", ["a"], 1000, exec);
        expect(res.ok).toBe(false);
    });
});
