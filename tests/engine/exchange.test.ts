// tests/engine/exchange.test.ts — the M13 host-side exchange primitives ("git as the wall", Task 4).
// ExecFn-injected arg-builders, unit-tested with a capturing fake: the exact git argv is the contract
// (force push bypassing the trunk-guard hook; fetch-then-hard-reset; idempotent bare init).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureExchange, pushToExchange, fetchFromExchange } from "../../src/main/engine/exchange";
import type { ExecFn } from "../../src/main/engine/exec";

const capture = () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: ExecFn = async (cmd, args = []) => { calls.push({ cmd, args }); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
    return { calls, exec };
};

describe("exchange primitives (git as the wall)", () => {
    it("pushToExchange force-pushes the worktree HEAD to the task branch, --no-verify to clear the trunk-guard hook", async () => {
        const { calls, exec } = capture();
        await pushToExchange("/wt", "/x/t1.git", "ralph/task-t1", exec);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ cmd: "git", args: ["-C", "/wt", "push", "--no-verify", "--force", "/x/t1.git", "HEAD:refs/heads/ralph/task-t1"] });
    });

    it("fetchFromExchange fetches the task branch, then HARD-RESETs the worktree to it (container authoritative out)", async () => {
        const { calls, exec } = capture();
        await fetchFromExchange("/wt", "/x/t1.git", "ralph/task-t1", exec);
        expect(calls[0].args).toEqual(["-C", "/wt", "fetch", "/x/t1.git", "refs/heads/ralph/task-t1"]);
        expect(calls[1].args).toEqual(["-C", "/wt", "reset", "--hard", "FETCH_HEAD"]);
    });

    it("ensureExchange git-inits a bare repo when absent, and is a no-op once HEAD exists (idempotent)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "helm-exch-"));
        const path = join(dir, "t1.git");
        const a = capture();
        await ensureExchange(path, a.exec);
        expect(a.calls[0]).toEqual({ cmd: "git", args: ["init", "--bare", path] });
        // simulate the now-initialised bare repo (HEAD present) → no git call on the second run
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
        const b = capture();
        await ensureExchange(path, b.exec);
        expect(b.calls).toHaveLength(0);
        rmSync(dir, { recursive: true, force: true });
    });

    it("throws when a primitive's git fails — a broken exchange must not silently pass", async () => {
        const failExec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
        await expect(pushToExchange("/wt", "/x/t1.git", "b", failExec)).rejects.toThrow(/push to exchange/);
        await expect(fetchFromExchange("/wt", "/x/t1.git", "b", failExec)).rejects.toThrow(/fetch from exchange/);
    });
});
