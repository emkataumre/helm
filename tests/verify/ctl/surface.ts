// tests/verify/ctl/surface.ts
// The M16 verify SURFACE. Drives the REAL ctl kernel — buildCtlVerbs + dispatchCtl (with recording
// actions), buildCtlEnv, the REAL spawnAgent (with a recording exec — no claude ever runs), and the
// REAL conductor guard trio (isConductorResumable + buildConductorArgv) — and distils a flat
// CtlRecording the invariants read. The live pipe transport + a real conductor conversation are NOT
// headless-reachable → the accept scenario covers the wire and manual acceptance covers the
// conversation; this slice proves the pure safety logic the headless world CAN observe.
import { CTL_VERBS, CTL_STEER_VERBS, buildCtlVerbs, dispatchCtl, type CtlActions } from "../../../src/main/ctl/verbs";
import { buildCtlEnv } from "../../../src/main/ctl/protocol";
import { spawnAgent } from "../../../src/main/engine/spawn";
import type { ExecFn } from "../../../src/main/engine/exec";
import { buildConductorArgv, isConductorResumable, claudeSessionFile } from "../../../src/main/engine/conductor";

// The flat recording the invariants read.
export interface CtlRecording {
    unit: "ctl";
    // ctl-verbs-are-blessed
    registeredVerbs: string[];      // Object.keys of the REAL registry buildCtlVerbs returns
    blessedVerbs: string[];         // the declared closed set (CTL_VERBS)
    unknownVerbRejected: boolean;   // dispatchCtl rejected a non-blessed verb with a structured {ok:false}
    // ctl-absent-in-agent-spawns
    agentEnvKeys: string[] | null;  // env override the agent chokepoint handed exec (null = none passed → inherits process.env)
    baseEnvMutated: boolean;        // did buildCtlEnv mutate its base (what agents inherit)? MUST stay false
    ptyEnvHasPipe: boolean;         // the human-PTY overlay carries HELM_CTL_PIPE (the seam separation exists)
    ptyPathPrepended: boolean;      // ...and PATH-prepends the shim dir (found case-insensitively, in place)
    // mutations-route-through-mutex
    steerCalls: Array<{ verb: string; sharedActionInvoked: boolean }>;
    // conductor-resume-respects-guard
    conductorCases: Array<{ recorded: string | null; persisted: boolean; argv: string[] }>;
}

// The comprehensive positive run: the real kernel driven end to end (no pipe, no claude, no disk).
export async function runCtlScenario(): Promise<CtlRecording> {
    // ── ctl-verbs-are-blessed + mutations-route-through-mutex: the REAL registry over recording actions ─
    const invoked = new Set<string>();
    const rec = (name: string) => () => { invoked.add(name); return { done: name }; };
    const recVoid = (name: string) => (): void => { invoked.add(name); };
    const actions: CtlActions = {
        status: rec("status"), taskDetail: rec("taskDetail"), progressTail: rec("progressTail"),
        planStatus: rec("planStatus"), failures: rec("failures"), pause: recVoid("pause"), resume: recVoid("resume"),
        abandonTask: rec("abandonTask"), clearDeps: rec("clearDeps"),
    };
    const verbs = buildCtlVerbs(actions);
    const registeredVerbs = Object.keys(verbs);

    // Dispatch every steer verb through the REAL dispatcher and record that the injected shared action
    // (the same fn object the ipc handlers call) actually fired — the "one implementation, two
    // transports" seam, machine-checked.
    const steerToAction: Record<string, string> = { "pause": "pause", "resume": "resume", "abandon": "abandonTask", "clear-deps": "clearDeps" };
    const steerCalls: Array<{ verb: string; sharedActionInvoked: boolean }> = [];
    for (const verb of CTL_STEER_VERBS) {
        invoked.clear();
        const resp = await dispatchCtl(verbs, { verb, args: { id: "t-1" } });
        steerCalls.push({ verb, sharedActionInvoked: resp.ok && invoked.has(steerToAction[verb]) && invoked.size === 1 });
    }

    // An unknown (deliberately-absent) intake verb must be rejected structurally, not guessed at.
    const bad = await dispatchCtl(verbs, { verb: "create-task", args: {} });
    const unknownVerbRejected = !bad.ok;

    // ── ctl-absent-in-agent-spawns: the REAL chokepoint with a recording exec ──────────────────────
    let agentEnvKeys: string[] | null = null;
    const recordingExec: ExecFn = (_cmd, _args, opts) => {
        agentEnvKeys = opts?.env ? Object.keys(opts.env) : null;
        return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
    };
    await spawnAgent("/wt", "prompt", {}, recordingExec);

    // The REAL env builder over a captured fake base: the overlay must carry the pipe + the PATH
    // prepend, and the base (≙ process.env, what agents inherit) must come out untouched.
    const base: NodeJS.ProcessEnv = { Path: "C:\\Windows;C:\\bin", HOME: "C:\\Users\\x" };
    const ctlEnv = buildCtlEnv(base, "\\\\.\\pipe\\helm-ctl-test", "C:\\ud\\ctl");
    const baseEnvMutated = "HELM_CTL_PIPE" in base || base.Path !== "C:\\Windows;C:\\bin";
    const ptyEnvHasPipe = ctlEnv.HELM_CTL_PIPE === "\\\\.\\pipe\\helm-ctl-test";
    const ptyPathPrepended = ctlEnv.Path?.startsWith("C:\\ud\\ctl;") === true && !("PATH" in ctlEnv);

    // ── conductor-resume-respects-guard: the REAL guard + argv builder, mirroring the launch path ──
    const home = "C:\\Users\\x";
    const repo = "I:\\Personal\\helm";
    const persistedSet = new Set([claudeSessionFile(home, repo, "sess-live")]);
    const fileExists = (p: string) => persistedSet.has(p);
    const conductorCase = (recorded: string | null, freshId: string): { recorded: string | null; persisted: boolean; argv: string[] } => {
        const resumable = isConductorResumable(recorded, fileExists, home, repo);
        // Mirror conductor:launch — resume iff the guard holds; otherwise a fresh forced --session-id.
        const argv = resumable ? buildConductorArgv(recorded, true) : buildConductorArgv(freshId, false);
        return { recorded, persisted: recorded != null && fileExists(claudeSessionFile(home, repo, recorded)), argv };
    };
    const conductorCases = [
        conductorCase("sess-live", "fresh-a"),   // recorded + persisted → --resume sess-live
        conductorCase("sess-ghost", "fresh-b"),  // recorded but NEVER persisted (turn-less death) → fresh
        conductorCase(null, "fresh-c"),          // nothing recorded → fresh
    ];

    return {
        unit: "ctl",
        registeredVerbs,
        blessedVerbs: [...CTL_VERBS],
        unknownVerbRejected,
        agentEnvKeys,
        baseEnvMutated,
        ptyEnvHasPipe,
        ptyPathPrepended,
        steerCalls,
        conductorCases,
    };
}

// A clean baseline (all invariants hold) — probes clone it and break ONE field.
export const BASELINE: CtlRecording = {
    unit: "ctl",
    registeredVerbs: [...CTL_VERBS],
    blessedVerbs: [...CTL_VERBS],
    unknownVerbRejected: true,
    agentEnvKeys: null,
    baseEnvMutated: false,
    ptyEnvHasPipe: true,
    ptyPathPrepended: true,
    steerCalls: [
        { verb: "pause", sharedActionInvoked: true },
        { verb: "resume", sharedActionInvoked: true },
        { verb: "abandon", sharedActionInvoked: true },
        { verb: "clear-deps", sharedActionInvoked: true },
    ],
    conductorCases: [
        { recorded: "sess-live", persisted: true, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume sess-live"] },
        { recorded: "sess-ghost", persisted: false, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --session-id fresh-b"] },
        { recorded: null, persisted: false, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --session-id fresh-c"] },
    ],
};
