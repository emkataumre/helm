// tests/engine/spawn.test.ts
import { spawnAgent } from "../../src/main/engine/spawn";
import type { ExecFn, ExecResult } from "../../src/main/engine/exec";

it("invokes claude with -p, auto permission mode, in the worktree, and reports success", async () => {
    let seen: { command: string; args: string[]; cwd?: string } | null = null;
    const fakeExec: ExecFn = async (command, args = [], opts = {}) => {
        seen = { command, args, cwd: opts.cwd };
        return { code: 0, stdout: "done", stderr: "", timedOut: false } as ExecResult;
    };
    const r = await spawnAgent("/wt", "build the thing", { model: "claude-opus-4-8" }, fakeExec);
    expect(r.ok).toBe(true);
    expect(seen!.command).toBe("claude");
    expect(seen!.cwd).toBe("/wt");
    expect(seen!.args).toEqual(["-p", "build the thing", "--permission-mode", "auto", "--model", "claude-opus-4-8"]);
});

it("reports failure on non-zero exit", async () => {
    const fakeExec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
    const r = await spawnAgent("/wt", "x", {}, fakeExec);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("boom");
});
