// tests/verify/jail/jail.test.ts
// M13 Docker jail — the verify slice for the four safety invariants, driven against the REAL units
// (buildJailPlan / runTaskLoop in jail mode / spawnAgent in host mode). Part 1 pins the observable facts
// directly; Part 2 is the CI matrix over every fixture + its must-FAIL probe. Headless under `npm run check`,
// zero prod footprint (no real docker runs — spawn is faked in the loop, and the host spawn uses a fake exec).
import { describe, it, expect } from "vitest";
import { realPlanRecording, realLoopGateRecording, realHostSpawnRecording, type JailRecording } from "./surface";
import { runJailFixture, runAll, type Verdict } from "./runner";
import { JAIL_INVARIANTS, runJailInvariants } from "./invariants";
import { JAIL_FIXTURES } from "./fixtures";

const failed = (r: JailRecording) => runJailInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/jail Part 1: the real units satisfy the safety invariants", () => {
    it("the REAL buildJailPlan carries no origin and mounts only the exchange/volume/auth", () => {
        const r = realPlanRecording();
        expect(failed(r)).toEqual([]);
        // spot-check the surface directly, too
        const targets = r.plan!.mounts.map((m) => m.split(":").slice(-1)[0]);
        expect(targets.sort()).toEqual(["/exchange", "/home/node/.claude", "/work"]);
        expect(r.plan!.argv.join(" ")).not.toMatch(/origin|https?:\/\//i);
    });

    it("the REAL runTaskLoop in jail mode runs every gate with the HOST worktree as cwd", async () => {
        const r = await realLoopGateRecording();
        expect(failed(r)).toEqual([]);
        expect(r.gateCwds!.length).toBeGreaterThanOrEqual(2); // check + acceptance
        expect(new Set(r.gateCwds)).toEqual(new Set([r.hostWorktree]));
    });

    it("the REAL host-mode chokepoint launches `claude` with no docker/jail token", async () => {
        const r = await realHostSpawnRecording();
        expect(failed(r)).toEqual([]);
        expect(r.hostSpawn!.command).toBe("claude");
        expect(r.hostSpawn!.args).toContain("--permission-mode"); // still the host auto-mode flag
        expect(r.hostSpawn!.args).not.toContain("--dangerously-skip-permissions");
    });
});

describe("verify/jail Part 2: the CI matrix over every fixture", () => {
    it.each(JAIL_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS", async (_id, fixture) => {
        expect<Verdict>((await runJailFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(JAIL_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("declares a must-FAIL probe for EACH declared invariant", () => {
        const probed = new Set(JAIL_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...probed].sort()).toEqual(JAIL_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(JAIL_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/jail Part 2: negative controls — each broken recording FAILS its named invariant", () => {
    it("an origin-sneaked plan FAILS origin-unreachable-in-jail", () => {
        const fx = JAIL_FIXTURES.find((f) => f.id === "probe-origin-sneaked");
        expect(fx?.probe && failed(fx.recording)).toContain("origin-unreachable-in-jail");
    });
    it("a worktree-bind-mount plan FAILS exchange-only-mount", () => {
        const fx = JAIL_FIXTURES.find((f) => f.id === "probe-worktree-mount");
        expect(fx?.probe && failed(fx.recording)).toContain("exchange-only-mount");
    });
    it("a gate-ran-in-the-container recording FAILS gates-run-host-side", () => {
        const fx = JAIL_FIXTURES.find((f) => f.id === "probe-gate-in-container");
        expect(fx?.probe && failed(fx.recording)).toContain("gates-run-host-side");
    });
    it("a host spawn carrying a jail token FAILS jail-opt-in-host-default", () => {
        const fx = JAIL_FIXTURES.find((f) => f.id === "probe-host-carries-docker-token");
        expect(fx?.probe && failed(fx.recording)).toContain("jail-opt-in-host-default");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as JailRecording; // property access throws inside predicates
        const results = runJailInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
