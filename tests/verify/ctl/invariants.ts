// tests/verify/ctl/invariants.ts
// The four M16 ctl-safety invariants (spec §7) — pure predicates over the CtlRecording. Each returns
// `true` or a human-readable violation string; runCtlInvariants wraps them so a predicate that THROWS
// becomes a failed check, never a silent pass ("when in doubt, FAIL").
import type { CtlRecording } from "./surface";

export interface CtlInvariant { name: string; holds: (r: CtlRecording) => true | string }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// Verb names that would smuggle INTAKE through the control plane. The hallucinated-acceptance-command
// protection + the human ack gate stay load-bearing for ALL intake (spec §3), so neither the registry
// nor the blessed declaration may ever contain one.
const INTAKE_PATTERN = /create|insert|new-?task|intake/i;

export const CTL_INVARIANTS: CtlInvariant[] = [
    // The verb table is a CLOSED set: everything registered is blessed, nothing smells like intake,
    // and a non-blessed verb is rejected structurally (never routed by guesswork).
    {
        name: "ctl-verbs-are-blessed",
        holds: (r) => {
            const blessed = new Set(r.blessedVerbs);
            const rogue = r.registeredVerbs.filter((v) => !blessed.has(v));
            if (rogue.length) return `registered verb(s) outside the blessed set: ${rogue.join(", ")}`;
            const intake = [...r.registeredVerbs, ...r.blessedVerbs].filter((v) => INTAKE_PATTERN.test(v));
            if (intake.length) return `intake-shaped verb(s) in the control plane: ${[...new Set(intake)].join(", ")}`;
            if (!r.unknownVerbRejected) return "an unknown verb was NOT rejected with a structured error";
            return true;
        },
    },
    // Agents must never see the pipe: the spawn chokepoint hands exec no env carrying HELM_CTL_PIPE
    // (today it hands none at all → agents inherit plain process.env), the env builder never mutates
    // its base (what agents inherit), and the overlay is genuinely scoped to the human-PTY seam
    // (pipe present + shim PATH prepended there — the separation must EXIST, not just be absent).
    {
        name: "ctl-absent-in-agent-spawns",
        holds: (r) => {
            if (r.agentEnvKeys?.includes("HELM_CTL_PIPE")) return "the agent spawn env carries HELM_CTL_PIPE — agents could steer their own scheduler";
            if (r.baseEnvMutated) return "buildCtlEnv mutated its base env — the pipe would leak into everything that inherits process.env";
            if (!r.ptyEnvHasPipe) return "the human-PTY overlay lacks HELM_CTL_PIPE — the CLI would be dead in the conductor pane";
            if (!r.ptyPathPrepended) return "the human-PTY overlay did not PATH-prepend the shim dir (or duplicated the PATH key)";
            return true;
        },
    },
    // Every steer verb routes through the SAME shared action the cockpit button calls (the injected fn
    // fired, and ONLY it) — so a pipe-steered mutation gets the same mutex/single-flight wrapping the
    // buttons get, by construction.
    {
        name: "mutations-route-through-mutex",
        holds: (r) => {
            const expected = ["pause", "resume", "abandon", "clear-deps"];
            const seen = new Map(r.steerCalls.map((c) => [c.verb, c.sharedActionInvoked]));
            for (const verb of expected) {
                if (!seen.has(verb)) return `steer verb "${verb}" was never exercised`;
                if (!seen.get(verb)) return `steer verb "${verb}" bypassed its shared (button-path) action`;
            }
            return true;
        },
    },
    // The conductor argv carries --resume IFF a recorded AND persisted session exists ("recorded ⇔
    // resumable"); every non-resume launch must force --session-id so the id is recordable up front.
    {
        name: "conductor-resume-respects-guard",
        holds: (r) => {
            for (const c of r.conductorCases) {
                const joined = c.argv.join(" ");
                const carriesResume = joined.includes("--resume");
                const shouldResume = c.recorded != null && c.persisted;
                if (carriesResume !== shouldResume) {
                    return `argv resume=${carriesResume} but recorded=${c.recorded === null ? "null" : `"${c.recorded}"`}, persisted=${c.persisted} (must agree)`;
                }
                if (shouldResume && !joined.includes(`--resume ${c.recorded}`)) return `resumable case does not carry "--resume ${c.recorded}"`;
                if (!shouldResume && !joined.includes("--session-id")) return "a fresh launch is missing the forced --session-id (the id would be unrecordable)";
            }
            return true;
        },
    },
];

export function runCtlInvariants(r: CtlRecording): InvariantResult[] {
    return CTL_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
