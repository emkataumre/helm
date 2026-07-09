// tests/verify/ctl/fixtures.ts
// Two kinds of fixture. The POSITIVE fixture drives the REAL ctl kernel (buildCtlVerbs/dispatchCtl
// with recording actions, the real spawnAgent with a recording exec, the real env builder + conductor
// guard). PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named
// invariant, proving the harness catches a lie and isn't just replaying happy paths.
import { runCtlScenario, BASELINE, type CtlRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<CtlRecording> }
export interface ProbeFixture { id: string; probe: true; recording: CtlRecording; mustFail: string }
export type CtlFixture = PositiveFixture | ProbeFixture;

export const CTL_FIXTURES: CtlFixture[] = [
    // The comprehensive real run: registry + dispatch + steer routing + chokepoint env + conductor guard.
    { id: "real-kernel", run: runCtlScenario },

    // ── Probes — hand-crafted negative controls ──────────────────────────────────────────────────
    // The spec's own probe: a registered createTask verb — intake smuggled onto the control plane.
    {
        id: "registered-create-task", probe: true, mustFail: "ctl-verbs-are-blessed",
        recording: { ...BASELINE, registeredVerbs: [...BASELINE.registeredVerbs, "createTask"] },
    },
    // A registry that silently ACCEPTS an unknown verb (no structured rejection).
    { id: "unknown-verb-accepted", probe: true, mustFail: "ctl-verbs-are-blessed", recording: { ...BASELINE, unknownVerbRejected: false } },
    // The spec's own probe: an agent env carrying HELM_CTL_PIPE — the agent could steer its scheduler.
    {
        id: "pipe-in-agent-env", probe: true, mustFail: "ctl-absent-in-agent-spawns",
        recording: { ...BASELINE, agentEnvKeys: ["PATH", "HELM_CTL_PIPE"] },
    },
    // The env builder mutated its base — the pipe would leak into everything inheriting process.env.
    { id: "base-env-mutated", probe: true, mustFail: "ctl-absent-in-agent-spawns", recording: { ...BASELINE, baseEnvMutated: true } },
    // The spec's own probe: a steer verb that bypasses the shared (mutex-wrapped) button path.
    {
        id: "abandon-bypasses-shared-path", probe: true, mustFail: "mutations-route-through-mutex",
        recording: {
            ...BASELINE,
            steerCalls: BASELINE.steerCalls.map((c) => (c.verb === "abandon" ? { ...c, sharedActionInvoked: false } : c)),
        },
    },
    // The spec's own probe: --resume for a null-session project (a conversation claude can't find).
    {
        id: "resume-for-null-session", probe: true, mustFail: "conductor-resume-respects-guard",
        recording: {
            ...BASELINE,
            conductorCases: [{ recorded: null, persisted: false, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume ghost"] }],
        },
    },
    // A recorded-but-never-persisted id (turn-less death) whose argv still carries --resume.
    {
        id: "resume-for-unpersisted-session", probe: true, mustFail: "conductor-resume-respects-guard",
        recording: {
            ...BASELINE,
            conductorCases: [{ recorded: "sess-ghost", persisted: false, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume sess-ghost"] }],
        },
    },
];
