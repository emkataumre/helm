// tests/verify/jail/fixtures.ts
// POSITIVE fixtures drive the REAL units (buildJailPlan / runTaskLoop / spawnAgent) — every invariant must
// hold. PROBES are hand-crafted BROKEN recordings (negative controls): each MUST FAIL its named invariant,
// proving the harness catches a lie and isn't a happy-path replay. One probe per declared invariant.
import { allowedMountTargets } from "../../../src/main/engine/jail";
import { realPlanRecording, realLoopGateRecording, realHostSpawnRecording, type JailRecording } from "./surface";

export interface PositiveFixture { id: string; probe?: false; run: () => Promise<JailRecording> | JailRecording }
export interface ProbeFixture { id: string; probe: true; recording: JailRecording; mustFail: string }
export type JailFixture = PositiveFixture | ProbeFixture;

const ALLOWED = allowedMountTargets();

export const JAIL_FIXTURES: JailFixture[] = [
    // ── Positive — the REAL units; every invariant must hold ──────────────────────────────────────────────
    { id: "real-plan", run: () => realPlanRecording() },              // #1 + #3 over the real buildJailPlan
    { id: "real-loop-gates-host-side", run: () => realLoopGateRecording() }, // #2 over the real runTaskLoop (jail mode)
    { id: "real-host-spawn", run: () => realHostSpawnRecording() },   // #4 over the real host-mode chokepoint

    // ── Probes — hand-crafted BROKEN recordings, each breaking ONE invariant ──────────────────────────────
    // A plan whose config sneaks the real origin in (a remote URL in the argv + an `origin` env line).
    // MUST FAIL origin-unreachable-in-jail.
    {
        id: "probe-origin-sneaked", probe: true, mustFail: "origin-unreachable-in-jail",
        recording: {
            unit: "jail",
            plan: {
                mounts: ["C:/x/t1.git:/exchange", "helm-jail-task-t1:/work", "helm-claude-auth:/home/node/.claude"],
                argv: ["run", "--rm", "-e", "GIT_REMOTE=https://github.com/acme/repo.git", "helm-jail:latest", "claude"],
                envFileLines: ["HELM_TASK_BRANCH=ralph/task-t1", "HELM_ORIGIN=https://github.com/acme/repo.git"],
                allowedTargets: ALLOWED,
            },
        },
    },
    // A plan that bind-mounts the HOST worktree into the container (target /wt not in the allow-list).
    // MUST FAIL exchange-only-mount.
    {
        id: "probe-worktree-mount", probe: true, mustFail: "exchange-only-mount",
        recording: {
            unit: "jail",
            plan: {
                mounts: ["C:/x/t1.git:/exchange", "helm-jail-task-t1:/work", "helm-claude-auth:/home/node/.claude", "C:/repo/.helm/worktrees/ralph-task-t1:/wt"],
                argv: ["run", "--rm", "helm-jail:latest", "claude"],
                envFileLines: ["HELM_TASK_BRANCH=ralph/task-t1"],
                allowedTargets: ALLOWED,
            },
        },
    },
    // A loop recording where a gate ran inside the CONTAINER (/work/repo) instead of the host worktree.
    // MUST FAIL gates-run-host-side.
    {
        id: "probe-gate-in-container", probe: true, mustFail: "gates-run-host-side",
        recording: { unit: "jail", gateCwds: ["/work/repo"], hostWorktree: "/repo/.helm/worktrees/ralph-task-t1" },
    },
    // A host-mode spawn recording whose argv carries a jail token (--dangerously-skip-permissions leaked into
    // a non-jailed spawn). MUST FAIL jail-opt-in-host-default.
    {
        id: "probe-host-carries-docker-token", probe: true, mustFail: "jail-opt-in-host-default",
        recording: { unit: "jail", hostSpawn: { command: "claude", args: ["-p", "/goal x", "--dangerously-skip-permissions"] } },
    },
];
