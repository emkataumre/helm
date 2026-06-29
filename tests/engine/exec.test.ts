// tests/engine/exec.test.ts
import { run } from "../../src/main/engine/exec";

it("captures stdout and a zero exit code", async () => {
    const r = await run(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.timedOut).toBe(false);
});

it("reports a non-zero exit code", async () => {
    const r = await run(process.execPath, ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
});

it("times out and flags timedOut", async () => {
    const r = await run(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
});

// M5: the AbortSignal interrupt primitive — drop-in hard-kills the in-flight child on demand,
// reusing the existing killTree. A correct abort resolves promptly (well under the 30s backstop).
describe("run + AbortSignal (the drop-in interrupt primitive)", () => {
    it("kills a running child when the signal fires and flags aborted with a non-zero code", async () => {
        const controller = new AbortController();
        const p = run(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { signal: controller.signal });
        controller.abort(); // the listener is registered synchronously by run(), so this fires immediately
        const r = await p;
        expect(r.aborted).toBe(true);
        expect(r.code).not.toBe(0);
    });

    it("kills immediately when the signal is already aborted before run()", async () => {
        const controller = new AbortController();
        controller.abort();
        const r = await run(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { signal: controller.signal });
        expect(r.aborted).toBe(true);
    });

    it("is unaffected by a signal that never fires (same as no signal)", async () => {
        const controller = new AbortController();
        const r = await run(process.execPath, ["-e", "process.stdout.write('hi')"], { signal: controller.signal });
        expect(r.code).toBe(0);
        expect(r.stdout).toBe("hi");
        expect(r.aborted).toBeFalsy();
    });
});

describe("run streaming + idle-timeout", () => {
    it("delivers complete stdout lines to onLine", async () => {
        const lines: string[] = [];
        await run(process.execPath, ["-e", "console.log('a');console.log('b')"], { onLine: (l) => lines.push(l) });
        expect(lines).toEqual(["a", "b"]);
    });

    it("kills a process whose output is silent past idleTimeoutMs and flags idleTimedOut", async () => {
        const res = await run(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { idleTimeoutMs: 200 });
        expect(res.idleTimedOut).toBe(true);
    });

    it("does not idle-timeout a process that keeps emitting", async () => {
        const res = await run(
            process.execPath,
            ["-e", "let n=0;const t=setInterval(()=>{console.log(n++);if(n>4){clearInterval(t)}},50)"],
            { idleTimeoutMs: 500 },
        );
        expect(res.idleTimedOut).toBe(false);
        expect(res.code).toBe(0);
    });
});
