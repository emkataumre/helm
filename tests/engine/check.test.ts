// tests/engine/check.test.ts
import { runCheck } from "../../src/main/engine/check";
import type { ExecFn } from "../../src/main/engine/exec";

const fakeExec = (result: { code: number; timedOut?: boolean }): ExecFn =>
    async () => ({ code: result.code, stdout: "out", stderr: "err", timedOut: result.timedOut ?? false });

it("is green on exit 0", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: 0 }));
    expect(r.green).toBe(true);
    expect(r.timedOut).toBe(false);
});

it("is not green on non-zero exit", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: 1 }));
    expect(r.green).toBe(false);
});

it("flags a timeout as not green", async () => {
    const r = await runCheck("/wt", "npm test", 1000, fakeExec({ code: -1, timedOut: true }));
    expect(r.green).toBe(false);
    expect(r.timedOut).toBe(true);
});
