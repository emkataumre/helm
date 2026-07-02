// tests/verify/terminal/fixtures.ts
// Two kinds of fixture. The POSITIVE fixture drives the REAL createPtyManager (fake factory) + REAL
// buildDropinArgv (surface.runTerminalScenario) — every invariant must hold. PROBES are hand-crafted
// BROKEN recordings (negative controls): each MUST FAIL its named invariant, proving the harness catches
// a lie and isn't just replaying happy paths ("an all-✅ checklist is just a happy-path replay").
import { runTerminalScenario, BASELINE, type TerminalRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => TerminalRecording }
export interface ProbeFixture { id: string; probe: true; recording: TerminalRecording; mustFail: string }
export type TerminalFixture = PositiveFixture | ProbeFixture;

export const TERMINAL_FIXTURES: TerminalFixture[] = [
    // The comprehensive real run: create+kill+disposeAll, buildDropinArgv resume-guard cases, and an
    // emit→attach→live scrollback replay — all through the real units.
    { id: "real-lifecycle", run: runTerminalScenario },

    // ── Probes — hand-crafted negative controls ──────────────────────────────────────────────────
    // A session left alive after the quit path (a leaked pwsh) — the exact orphan Task-7 hunts for.
    { id: "orphan-after-dispose", probe: true, mustFail: "no-orphan-ptys", recording: { ...BASELINE, orphansAfterDispose: 1 } },
    // disposeAll ran but a created session's kill was never invoked (handle survives).
    { id: "unkilled-session", probe: true, mustFail: "no-orphan-ptys", recording: { ...BASELINE, killedHandleCount: 2 } },
    // A null-session task whose argv still carries --resume → `claude --resume` a session that never persisted.
    {
        id: "resume-for-null-session", probe: true, mustFail: "dropin-respects-resume-guard",
        recording: { ...BASELINE, argvCases: [{ sessionId: null, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume ghost"] }] },
    },
    // A replay that dropped a chunk → the reopened tab lies about history.
    { id: "dropped-scrollback-chunk", probe: true, mustFail: "attach-replays-scrollback", recording: { ...BASELINE, replayed: "one three " } },
];
