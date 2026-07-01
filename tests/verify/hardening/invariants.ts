// tests/verify/hardening/invariants.ts
// The two M6-② safety-hardening invariants — pure predicates over the HardeningRecording. Each returns
// `true` or a human-readable violation string; runHardeningInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and
// complementary to, the untouched M2–M5 slices.
import type { HardeningRecording } from "./surface";

export interface HardeningInvariant { name: string; holds: (r: HardeningRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// A deny entry counts as a never-push block if it scopes a Bash `git push` command.
const isGitPushDeny = (d: string): boolean => /^Bash\(\s*git\s+push/i.test(d);

export const HARDENING_INVARIANTS: HardeningInvariant[] = [
    // The absolute never-push belt (spec §5.7/§13): the injected settings' permissions.deny hard-blocks
    // the agent pushing. Runs before the classifier, can't be overridden.
    {
        name: "agent-push-denied",
        holds: (r) => r.deny.some(isGitPushDeny) ||
            `permissions.deny carries no git-push block (deny=${JSON.stringify(r.deny)})`,
    },
    // The belt must actually REACH the agent: the chokepoint injects the built settings JSON, unmangled,
    // as the --settings argument. A deny that's composed but never passed to `claude` protects nothing.
    {
        name: "settings-injected",
        holds: (r) => r.injectedSettingsArg === r.settingsJson ||
            (r.injectedSettingsArg === null
                ? "--settings was not injected at the chokepoint (the built settings never reached claude)"
                : `--settings was injected but mangled (got ${r.injectedSettingsArg}, expected the built JSON)`),
    },
];

export function runHardeningInvariants(r: HardeningRecording): InvariantResult[] {
    return HARDENING_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
