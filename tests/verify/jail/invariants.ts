// tests/verify/jail/invariants.ts
// The four M13 jail invariants — pure predicates over the flat JailRecording. Each returns `true` or a
// human-readable violation string; runJailInvariants wraps them so a predicate that THROWS becomes a failed
// check, never a silent pass ("when in doubt, FAIL"). An invariant whose recording fields are absent holds
// (N/A) — a probe then supplies the field with a lie the invariant must catch.
import type { JailRecording } from "./surface";

export interface JailInvariant { name: string; holds: (r: JailRecording) => true | string }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const JAIL_INVARIANTS: JailInvariant[] = [
    // #1 — the jailed spawn's plan carries NO real-origin URL and NO host credential path anywhere (argv,
    // mounts, or env-file lines). "Never-push by unreachability": the real origin simply doesn't exist in the
    // jail. (The .ralph blobs are base64, so a decoded "origin" can't false-positive — we scan the raw plan.)
    {
        name: "origin-unreachable-in-jail",
        holds: (r) => {
            if (!r.plan) return true;
            const hay = [...r.plan.argv, ...r.plan.mounts, ...r.plan.envFileLines].join("\n");
            if (/https?:\/\//.test(hay)) return "the jail plan carries a remote URL (origin reachable)";
            if (/git@|ssh:\/\//.test(hay)) return "the jail plan carries an ssh remote (origin reachable)";
            if (/\.git-credentials|\.netrc|_netrc/.test(hay)) return "the jail plan carries a credential-file path";
            if (/\borigin\b/i.test(hay)) return "the jail plan references an `origin` remote";
            return true;
        },
    },
    // #3 — the bind/volume mounts are a SUBSET of {bare exchange, per-task volume, auth volume}. A worktree
    // bind-mount (or any other source) is a wall breach — the container must only ever see the exchange.
    {
        name: "exchange-only-mount",
        holds: (r) => {
            if (!r.plan) return true;
            for (const m of r.plan.mounts) {
                const target = m.split(":").slice(-1)[0];
                if (!r.plan.allowedTargets.includes(target)) return `mount target "${target}" is not in the exchange-only allow-list`;
            }
            return true;
        },
    },
    // #2 — check ∧ acceptance run with the HOST worktree as cwd, never a container/exchange path. A compromised
    // agent must not grade its own homework: the authoritative gate never moves inside the jail.
    {
        name: "gates-run-host-side",
        holds: (r) => {
            if (!r.gateCwds) return true;
            if (r.gateCwds.length === 0) return "no gate ran — cannot confirm the gate ran host-side";
            for (const cwd of r.gateCwds) {
                if (cwd !== r.hostWorktree) return `a gate ran with cwd "${cwd}", not the host worktree "${r.hostWorktree}"`;
            }
            return true;
        },
    },
    // #4 — with NO jail config the chokepoint launches `claude` with NO docker/jail token in its argv (byte-
    // identical to today). The opt-in is genuinely opt-in: a host project never leaks a container.
    {
        name: "jail-opt-in-host-default",
        holds: (r) => {
            if (!r.hostSpawn) return true;
            if (r.hostSpawn.command !== "claude") return `host-mode spawn launched "${r.hostSpawn.command}", not claude`;
            const jailTokens = ["docker", "run", "--name", "--env-file", "--dangerously-skip-permissions"];
            for (const t of jailTokens) {
                if (r.hostSpawn.args.includes(t)) return `host-mode args carry a docker/jail token: "${t}"`;
            }
            return true;
        },
    },
];

export function runJailInvariants(r: JailRecording): InvariantResult[] {
    return JAIL_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
