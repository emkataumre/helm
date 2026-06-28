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
