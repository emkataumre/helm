// tests/verify/hardening/surface.ts
// The M6-② verify SURFACE. Drives the REAL units end to end — buildSpawnSettings(project) composes the
// --settings JSON, and the REAL spawnAgent forwards it to a fake `exec` that records argv — then distils
// the flat HardeningRecording the invariants read. Proves the never-push belt (agent side) is real, not
// a fake-deps mirage. Complementary to, and separate from, the untouched M2/M3/M4/M5 slices.
//
// NOTE the load-bearing boundary: the classifier ACTUALLY enforcing the deny is a real-CLI behaviour, not
// headless-reachable → covered by the Task-1 build-spike (transcript-proven) + the Task-6 manual
// acceptance. This slice proves the settings we inject CARRY the deny and REACH the chokepoint argv.
import { buildSpawnSettings } from "../../../src/main/engine/spawnSettings";
import { spawnAgent } from "../../../src/main/engine/spawn";
import type { ExecFn } from "../../../src/main/engine/exec";
import type { Project } from "../../../src/shared/types";

export const mkProject = (autoModeEnvironment: string | null): Project => ({
    id: "P", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment,
});

// The flat recording the invariants read. `injectedSettingsArg` is the argv token the chokepoint placed
// right after `--settings` (null if the flag was absent) — the real spawnAgent's actual behaviour.
export interface HardeningRecording {
    unit: "hardening";
    deny: string[];                     // permissions.deny parsed out of the built settings JSON
    settingsJson: string;               // exactly what buildSpawnSettings(project) returned
    injectedSettingsArg: string | null; // the argv value following --settings in the real spawnAgent call
}

// The positive scenario: compose the settings for a project, then drive the REAL spawnAgent (fake exec
// records argv) and read back whether the built JSON reached the chokepoint unmangled.
export async function runHardeningScenario(project: Project): Promise<HardeningRecording> {
    const settingsJson = buildSpawnSettings(project);
    const parsed = JSON.parse(settingsJson) as { permissions: { deny: string[] } };

    let seenArgs: string[] = [];
    const exec: ExecFn = async (_cmd, args) => { seenArgs = args ?? []; return { code: 0, stdout: "", stderr: "", timedOut: false }; };
    await spawnAgent("/wt", "/goal do it", { settings: settingsJson }, exec);

    const i = seenArgs.indexOf("--settings");
    return {
        unit: "hardening",
        deny: parsed.permissions.deny,
        settingsJson,
        injectedSettingsArg: i >= 0 ? seenArgs[i + 1] ?? null : null,
    };
}
