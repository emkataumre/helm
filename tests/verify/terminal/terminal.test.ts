// tests/verify/terminal/terminal.test.ts
// The M7 verify slice's CI matrix. The positive fixture drives the REAL createPtyManager (fake factory)
// + the REAL buildDropinArgv and distils a recording; probes are hand-crafted broken recordings (negative
// controls). Asserts the three M7 invariants — no-orphan-ptys, dropin-respects-resume-guard,
// attach-replays-scrollback — each with a probe that MUST FAIL. Vocabulary from ~/.claude/verification.md.
// Complementary to, and separate from, the untouched M2/M3/M4/M5/M6 slices. The real ConPTY + real claude
// TUI are NOT headless-reachable → manual acceptance (Task 7) is load-bearing.
import { describe, it, expect } from "vitest";
import { runTerminalFixture, runAll, type Verdict } from "./runner";
import { TERMINAL_INVARIANTS, runTerminalInvariants } from "./invariants";
import { TERMINAL_FIXTURES } from "./fixtures";
import { runTerminalScenario, BASELINE, type TerminalRecording } from "./surface";

const failed = (r: TerminalRecording) => runTerminalInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/terminal: the CI matrix over every fixture", () => {
    it.each(TERMINAL_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", (_id, fixture) => {
        expect<Verdict>(runTerminalFixture(fixture).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(TERMINAL_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("has a probe for each of the three invariants (each must be catchable)", () => {
        const covered = new Set(TERMINAL_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(["attach-replays-scrollback", "dropin-respects-resume-guard", "no-orphan-ptys"]);
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", () => {
        const results = runAll();
        expect(results).toHaveLength(TERMINAL_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/terminal: the recording is the real units' behaviour", () => {
    it("the real lifecycle run satisfies all three invariants", () => {
        expect(failed(runTerminalScenario())).toEqual([]);
    });

    it("disposeAll reaps every live session (no orphans) and kill(id) actually kills", () => {
        const rec = runTerminalScenario();
        expect(rec.orphansAfterDispose).toBe(0);
        expect(rec.killedHandleCount).toBe(rec.createdCount);
        expect(rec.killActuallyKills).toBe(true);
    });

    it("the manager forwards buildDropinArgv verbatim to the factory (real seam)", () => {
        expect(runTerminalScenario().argvForwardedToFactory).toBe(true);
    });

    it("attach replays the exact pre-attach scrollback, then streams live in order", () => {
        const rec = runTerminalScenario();
        expect(rec.replayed).toBe(rec.emittedBeforeAttach);
        expect(rec.streamedAfterAttach).toBe(rec.liveEmittedAfterAttach);
    });

    it("the evaluated invariant set equals the declared set", () => {
        expect(runTerminalInvariants(runTerminalScenario()).map((r) => r.name).sort())
            .toEqual(TERMINAL_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/terminal: negative controls — each broken recording FAILS its named invariant", () => {
    it("a session still alive after dispose FAILS no-orphan-ptys", () => {
        expect(failed({ ...BASELINE, orphansAfterDispose: 1 })).toContain("no-orphan-ptys");
    });
    it("a created session whose kill was never invoked FAILS no-orphan-ptys", () => {
        expect(failed({ ...BASELINE, killedHandleCount: 2 })).toContain("no-orphan-ptys");
    });
    it("kill(id) that didn't actually kill FAILS no-orphan-ptys", () => {
        expect(failed({ ...BASELINE, killActuallyKills: false })).toContain("no-orphan-ptys");
    });
    it("a null-session argv carrying --resume FAILS dropin-respects-resume-guard", () => {
        expect(failed({ ...BASELINE, argvCases: [{ sessionId: null, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume ghost"] }] }))
            .toContain("dropin-respects-resume-guard");
    });
    it("a resumable argv MISSING --resume FAILS dropin-respects-resume-guard", () => {
        expect(failed({ ...BASELINE, argvCases: [{ sessionId: "s9", argv: ["pwsh.exe", "-NoExit", "-Command", "claude"] }] }))
            .toContain("dropin-respects-resume-guard");
    });
    it("a replay that dropped a chunk FAILS attach-replays-scrollback", () => {
        expect(failed({ ...BASELINE, replayed: "one three " })).toContain("attach-replays-scrollback");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as TerminalRecording; // property access throws inside predicates
        const results = runTerminalInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
