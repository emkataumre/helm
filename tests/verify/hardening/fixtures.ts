// tests/verify/hardening/fixtures.ts
// Two kinds of fixture. POSITIVE fixtures drive the REAL buildSpawnSettings + spawnAgent
// (surface.runHardeningScenario) — both invariants must hold. PROBES are hand-crafted BROKEN recordings
// (negative controls): each MUST FAIL its named invariant, proving the harness catches a lie and isn't
// just replaying happy paths.
import { runHardeningScenario, mkProject, type HardeningRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<HardeningRecording> }
export interface ProbeFixture { id: string; probe: true; recording: HardeningRecording; mustFail: string }
export type HardeningFixture = PositiveFixture | ProbeFixture;

// A clean baseline recording (both invariants hold) — each probe clones it and breaks ONE thing.
const BASELINE: HardeningRecording = {
    unit: "hardening",
    deny: ["Bash(git push:*)", "Bash(git remote set-url:*)"],
    settingsJson: '{"permissions":{"deny":["Bash(git push:*)"]},"autoMode":{"environment":["$defaults"]}}',
    injectedSettingsArg: '{"permissions":{"deny":["Bash(git push:*)"]},"autoMode":{"environment":["$defaults"]}}',
};

export const HARDENING_FIXTURES: HardeningFixture[] = [
    // Real units: a default project (NULL autoModeEnvironment → ["$defaults"]) and one with a custom
    // trusted-env line. Both must carry the push deny AND inject it at the chokepoint.
    { id: "default-project", run: () => runHardeningScenario(mkProject(null)) },
    { id: "custom-environment", run: () => runHardeningScenario(mkProject("**Trusted internal domains**: registry.acme.internal")) },

    // ── Probes — hand-crafted negative controls ──────────────────────────────────────────────────
    // The settings were composed WITHOUT a git-push deny → the belt is missing.
    { id: "deny-missing", probe: true, mustFail: "agent-push-denied", recording: { ...BASELINE, deny: ["Bash(rm:*)"] } },
    // The deny exists but the chokepoint DROPPED --settings → it never reaches claude (protects nothing).
    { id: "injection-omitted", probe: true, mustFail: "settings-injected", recording: { ...BASELINE, injectedSettingsArg: null } },
];
