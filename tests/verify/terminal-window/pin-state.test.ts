// tests/verify/terminal-window/pin-state.test.ts
// The verify slice for "unpin a terminal into its own OS window + pin back". Self-contained (surface +
// invariants + fixtures + runner in one file — the smallest proof). The POSITIVE fixture drives the REAL
// createTerminalWindowRegistry (with a recording FAKE WindowDriver — no BrowserWindow ever loads) through
// track → unpin → pin-back → user-closes-the-window, and asserts every invariant holds AND the driver was
// commanded correctly. PROBES are hand-crafted BROKEN PinStates (negative controls): each MUST FAIL its
// named invariant, proving the harness catches a lie and isn't just replaying a happy path.
//
// The two failures the task calls out by name — "an unpin that leaves the PTY hostless" and "two hosts for
// one terminal" — are the load-bearing probes (hostless-after-unpin, two-windows-one-terminal). Vocabulary
// (PASS / FAIL / BLOCKED / SKIP, probe-must-fail) from ~/.claude/verification.md.
//
// The LIVE-window behaviour (a real BrowserWindow, focus, pin-back destroying it) can't be driven by the
// headless `npm run check` gate — it ships as the MANUAL-acceptance tail tests/accept/terminal-unpin.accept.ts
// under `npm run accept`. This slice proves the pure pin/unpin/registry logic the headless world CAN observe.
import { describe, it, expect } from "vitest";
import {
    createTerminalWindowRegistry, checkPinState, PIN_INVARIANTS, emptyPinState, TILING,
    track, untrack, unpin, pinBack, windowClosed,
    type PinState, type Host, type WindowDriver,
} from "../../../src/main/engine/terminalWindow";

type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";
const failed = (s: PinState) => checkPinState(s).filter((c) => !c.ok).map((c) => c.name);

// ── A recording fake WindowDriver: mints deterministic window ids and records every command ───────────
interface DriverLog {
    opens: string[];                                   // termIds unpinned (in order)
    closes: string[];                                  // windowIds destroyed (in order)
    routes: Array<{ termId: string; host: Host }>;     // every stream re-point
    liveWindows: Set<string>;                          // windowIds currently open (open adds, close removes)
}
function recordingDriver(): { driver: WindowDriver; log: DriverLog } {
    const log: DriverLog = { opens: [], closes: [], routes: [], liveWindows: new Set() };
    let seq = 0;
    const driver: WindowDriver = {
        open: (termId) => { log.opens.push(termId); const id = `win-${++seq}`; log.liveWindows.add(id); return id; },
        close: (windowId) => { log.closes.push(windowId); log.liveWindows.delete(windowId); },
        route: (termId, host) => { log.routes.push({ termId, host }); },
    };
    return { driver, log };
}

// ── The positive recording: one REAL registry driven through the whole lifecycle ─────────────────────
// Every intermediate state is captured so the invariants can be asserted at each observable moment, not
// just at the end (an unpin that briefly orphans the PTY would be a real bug the end-state hides).
interface Recording {
    afterTrack: PinState;
    afterUnpin: PinState;
    afterPinBack: PinState;
    afterReUnpin: PinState;
    afterUserClose: PinState;
    log: DriverLog;
    // Behavioural facts the invariants don't cover but the scenario must prove:
    windowIdOnUnpin: string | null;             // the window the terminal was routed to on unpin
    routedToWindowOnUnpin: boolean;             // unpin routed the stream to that window
    routedToTilingOnPinBack: boolean;           // pin-back routed the stream back to the tiling
    closedTheWindowOnPinBack: boolean;          // pin-back destroyed the detached window
    noWindowLeftLive: boolean;                  // after pin-back the window is gone (not leaked)
    userCloseReattachedToTiling: boolean;       // a user-closed detached window reattaches to the tiling
    doubleUnpinForkedAWindow: boolean;          // a second unpin while detached opened a SECOND window (must be false)
    unpinUnknownOpenedAWindow: boolean;         // unpinning an untracked id opened a window (must be false)
}

function runScenario(): Recording {
    const { driver, log } = recordingDriver();
    const reg = createTerminalWindowRegistry(driver);
    const T = "term-A";

    reg.track(T);
    const afterTrack = reg.state();

    // Unpin → the terminal detaches into its own window; the stream is routed there.
    reg.unpin(T);
    const afterUnpin = reg.state();
    const hostAfterUnpin = reg.hostOf(T);
    const windowIdOnUnpin = hostAfterUnpin?.kind === "window" ? hostAfterUnpin.windowId : null;
    const routedToWindowOnUnpin = log.routes.some((r) => r.termId === T && r.host.kind === "window" && r.host.windowId === windowIdOnUnpin);

    // A double-unpin while already detached must NOT fork a second window (idempotent — the "two hosts" guard).
    const opensBeforeDoubleUnpin = log.opens.length;
    reg.unpin(T);
    const doubleUnpinForkedAWindow = log.opens.length !== opensBeforeDoubleUnpin;

    // Pin back → the window is destroyed and the stream returns to the tiling.
    reg.pinBack(T);
    const afterPinBack = reg.state();
    const closedTheWindowOnPinBack = windowIdOnUnpin !== null && log.closes.includes(windowIdOnUnpin);
    const routedToTilingOnPinBack = log.routes.some((r, i) => r.termId === T && r.host.kind === "tiling" && i > 0);
    const noWindowLeftLive = log.liveWindows.size === 0;

    // Re-unpin, then simulate the USER closing the detached OS window directly (the driver's 'closed'
    // event) — the terminal must reattach to the tiling, never orphan.
    reg.unpin(T);
    const afterReUnpin = reg.state();
    const reWindowId = reg.hostOf(T)?.kind === "window" ? (reg.hostOf(T) as { windowId: string }).windowId : "";
    reg.windowClosed(reWindowId);
    const afterUserClose = reg.state();
    const userCloseReattachedToTiling = reg.hostOf(T)?.kind === "tiling";

    // Unpinning an id the registry never tracked is a no-op (no window minted).
    const opensBeforeUnknown = log.opens.length;
    reg.unpin("never-tracked");
    const unpinUnknownOpenedAWindow = log.opens.length !== opensBeforeUnknown;

    return {
        afterTrack, afterUnpin, afterPinBack, afterReUnpin, afterUserClose, log,
        windowIdOnUnpin, routedToWindowOnUnpin, routedToTilingOnPinBack, closedTheWindowOnPinBack,
        noWindowLeftLive, userCloseReattachedToTiling, doubleUnpinForkedAWindow, unpinUnknownOpenedAWindow,
    };
}

// ── A clean baseline PinState (all invariants hold) — probes clone it and break ONE thing ────────────
// term-P is detached into window win-1; term-Q stays in the tiling.
const BASELINE: PinState = {
    hosts: { "term-P": { kind: "window", windowId: "win-1" }, "term-Q": TILING },
    windows: { "win-1": "term-P" },
};

// ── Fixtures: one real positive run + hand-crafted probes (each MUST FAIL its named invariant) ────────
interface PositiveFixture { id: string; probe?: false; state: () => PinState }
interface ProbeFixture { id: string; probe: true; state: PinState; mustFail: string }
type Fixture = PositiveFixture | ProbeFixture;

const FIXTURES: Fixture[] = [
    // The comprehensive real run's END state — every invariant holds through the whole lifecycle.
    { id: "real-lifecycle", state: () => runScenario().afterUserClose },

    // ── Probes — hand-crafted broken states (negative controls) ──────────────────────────────────────
    // The task's headline failure #1: an unpin that leaves the PTY HOSTLESS. The window mapping was
    // removed but the terminal's host was never restored — its live node-pty now streams to nothing.
    {
        id: "hostless-after-unpin", probe: true, mustFail: "no-orphan-pty",
        state: { hosts: { "term-P": null as unknown as Host }, windows: {} },
    },
    // The task's headline failure #2: TWO hosts for one terminal — two windows both claim term-P.
    {
        id: "two-windows-one-terminal", probe: true, mustFail: "one-terminal-per-window",
        state: { hosts: { "term-P": { kind: "window", windowId: "win-1" } }, windows: { "win-1": "term-P", "win-2": "term-P" } },
    },
    // A terminal whose host points at a window that isn't registered (host/back-index disagree).
    {
        id: "host-points-at-ghost-window", probe: true, mustFail: "exactly-one-host-per-terminal",
        state: { hosts: { "term-P": { kind: "window", windowId: "win-ghost" } }, windows: {} },
    },
    // A window pointing at a terminal whose host is the TILING (the window/host disagree the other way).
    {
        id: "window-hosts-a-pinned-terminal", probe: true, mustFail: "one-terminal-per-window",
        state: { hosts: { "term-P": TILING }, windows: { "win-1": "term-P" } },
    },
];

// ── The runner: one loop per fixture — read the state, run the invariants, compute a verdict ──────────
// For a PROBE, PASS means "the harness correctly caught the broken state" — its named invariant FAILED.
// BLOCKED (couldn't observe) is never a pass.
interface FixtureResult { id: string; probe: boolean; verdict: Verdict; checks: PinCheck[]; notes: string[] }
type PinCheck = ReturnType<typeof checkPinState>[number];

function runFixture(fx: Fixture): FixtureResult {
    const probe = Boolean(fx.probe);
    let s: PinState;
    try {
        s = fx.probe ? fx.state : fx.state();
    } catch (err) {
        return { id: fx.id, probe, verdict: "BLOCKED", checks: [], notes: [`could not build state — threw: ${(err as Error)?.message ?? String(err)}`] };
    }
    const checks = checkPinState(s);
    if (checks.length === 0) return { id: fx.id, probe, verdict: "BLOCKED", checks, notes: ["no verifiers ran"] };

    if (probe) {
        const mustFail = (fx as ProbeFixture).mustFail;
        const named = checks.find((c) => c.name === mustFail);
        const caught = named !== undefined && !named.ok;
        return { id: fx.id, probe, verdict: caught ? "PASS" : "FAIL", checks, notes: caught ? [] : [`probe expected "${mustFail}" to FAIL, but it held (the harness missed the lie)`] };
    }
    const violations = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? "violated"}`);
    return { id: fx.id, probe, verdict: violations.length === 0 ? "PASS" : "FAIL", checks, notes: violations };
}

function runAll(): FixtureResult[] {
    if (FIXTURES.length === 0) return [{ id: "(none)", probe: false, verdict: "SKIP", checks: [], notes: ["no fixtures declared"] }];
    return FIXTURES.map(runFixture);
}

// ── The CI matrix ─────────────────────────────────────────────────────────────────────────────────
describe("verify/terminal-window: the CI matrix over every fixture", () => {
    it.each(FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS", (_id, fx) => {
        expect<Verdict>(runFixture(fx).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("has a probe for EVERY declared invariant (each must be catchable)", () => {
        const covered = new Set(FIXTURES.filter((f) => f.probe).map((f) => (f as ProbeFixture).mustFail));
        expect([...covered].sort()).toEqual(PIN_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", () => {
        const results = runAll();
        expect(results).toHaveLength(FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

// ── The real registry's behaviour (drive the REAL units, assert what actually happened) ──────────────
describe("verify/terminal-window: the real pin/unpin lifecycle keeps one live host per terminal", () => {
    it("every observable state through track → unpin → pin-back → user-close satisfies all invariants", () => {
        const rec = runScenario();
        for (const s of [rec.afterTrack, rec.afterUnpin, rec.afterPinBack, rec.afterReUnpin, rec.afterUserClose]) {
            expect(failed(s)).toEqual([]);
        }
    });

    it("track hosts a new terminal in the tiling", () => {
        const rec = runScenario();
        expect(rec.afterTrack.hosts["term-A"]).toEqual(TILING);
    });

    it("unpin detaches the terminal into its own window and routes the stream there", () => {
        const rec = runScenario();
        expect(rec.windowIdOnUnpin).not.toBeNull();
        expect(rec.afterUnpin.hosts["term-A"]).toEqual({ kind: "window", windowId: rec.windowIdOnUnpin });
        expect(rec.afterUnpin.windows[rec.windowIdOnUnpin!]).toBe("term-A");
        expect(rec.routedToWindowOnUnpin).toBe(true);
    });

    it("a double-unpin never forks a second window (idempotent — no two hosts)", () => {
        expect(runScenario().doubleUnpinForkedAWindow).toBe(false);
    });

    it("pin-back destroys the window, routes back to the tiling, and leaks no window", () => {
        const rec = runScenario();
        expect(rec.afterPinBack.hosts["term-A"]).toEqual(TILING);
        expect(rec.afterPinBack.windows).toEqual({});
        expect(rec.closedTheWindowOnPinBack).toBe(true);
        expect(rec.routedToTilingOnPinBack).toBe(true);
        expect(rec.noWindowLeftLive).toBe(true);
    });

    it("a user-closed detached window reattaches its terminal to the tiling — never orphaned", () => {
        const rec = runScenario();
        expect(rec.userCloseReattachedToTiling).toBe(true);
        expect(rec.afterUserClose.hosts["term-A"]).toEqual(TILING);
        expect(rec.afterUserClose.windows).toEqual({});
    });

    it("unpinning an untracked terminal is a no-op (no window minted)", () => {
        expect(runScenario().unpinUnknownOpenedAWindow).toBe(false);
    });

    it("the evaluated invariant set equals the declared set", () => {
        expect(checkPinState(emptyPinState()).map((c) => c.name).sort()).toEqual(PIN_INVARIANTS.map((i) => i.name).sort());
    });
});

// ── Pure-reducer edge cases: totality (never throws, idempotent, never orphans) ──────────────────────
describe("verify/terminal-window: the pure reducers are total and never orphan a PTY", () => {
    it("track is idempotent and never yanks an unpinned terminal back to the tiling", () => {
        let s = track(emptyPinState(), "t");
        s = unpin(s, "t", "w1");
        const reTracked = track(s, "t"); // re-tracking must NOT re-home it to the tiling
        expect(reTracked.hosts["t"]).toEqual({ kind: "window", windowId: "w1" });
    });

    it("pinBack on a tiling-hosted (or unknown) terminal is a no-op", () => {
        const s = track(emptyPinState(), "t");
        expect(pinBack(s, "t")).toBe(s);        // already in the tiling
        expect(pinBack(s, "ghost")).toBe(s);    // unknown id
    });

    it("windowClosed for the driver's post-pin-back re-entry is a harmless no-op", () => {
        let s = track(emptyPinState(), "t");
        s = unpin(s, "t", "w1");
        s = pinBack(s, "t");                     // window mapping already dropped
        expect(windowClosed(s, "w1")).toBe(s);  // the driver's 'closed' event now finds nothing
        expect(failed(s)).toEqual([]);
    });

    it("unpin then untrack (PTY killed while detached) leaves no dangling window back-pointer", () => {
        let s = track(emptyPinState(), "t");
        s = unpin(s, "t", "w1");
        s = untrack(s, "t");
        expect(s.hosts["t"]).toBeUndefined();
        expect(s.windows).toEqual({});
        expect(failed(s)).toEqual([]);
    });

    it("a broken invariant that THROWS becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as PinState; // Object.entries(null) throws inside the predicates
        const checks = checkPinState(garbage);
        expect(checks.every((c) => typeof c.ok === "boolean")).toBe(true);
        expect(checks.some((c) => !c.ok)).toBe(true);
    });
});

// ── Negative controls: each broken state FAILS its named invariant (the probes, asserted directly) ────
describe("verify/terminal-window: negative controls", () => {
    it("a hostless terminal FAILS no-orphan-pty", () => {
        expect(failed({ hosts: { t: null as unknown as Host }, windows: {} })).toContain("no-orphan-pty");
    });
    it("two windows for one terminal FAILS one-terminal-per-window", () => {
        expect(failed({ hosts: { t: { kind: "window", windowId: "w1" } }, windows: { w1: "t", w2: "t" } }))
            .toContain("one-terminal-per-window");
    });
    it("a host pointing at an unregistered window FAILS exactly-one-host-per-terminal", () => {
        expect(failed({ hosts: { t: { kind: "window", windowId: "ghost" } }, windows: {} }))
            .toContain("exactly-one-host-per-terminal");
    });
    it("a window hosting a terminal that thinks it's tiled FAILS one-terminal-per-window", () => {
        expect(failed({ hosts: { t: TILING }, windows: { w1: "t" } })).toContain("one-terminal-per-window");
    });
});
