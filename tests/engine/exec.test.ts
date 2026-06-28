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
