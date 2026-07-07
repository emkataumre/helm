// tests/verify/preflight/invariants.ts
// The four M11 pre-flight safety invariants — pure predicates over the flat PreflightRecording. Each returns
// `true` or a human-readable violation string; runPreflightInvariants wraps them so a predicate that THROWS
// becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and complementary to, the
// untouched M2–M10 slices.
import type { PreflightRecording, VerdictRecord } from "./surface";

export interface PreflightInvariant { name: string; holds: (r: PreflightRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

// The ops the stage is ALLOWED to perform — reads + the throwaway-worktree lifecycle + running a command. NOT a
// ref advance / push (those aren't even in PreflightDeps; this is the recorded belt over the structural braces).
// ensure-branch is create-if-absent only (never moves an existing ref) — the fresh-project fix from M10 acceptance.
const ALLOWED_OPS = new Set(["ensure-branch", "rev-parse", "create-worktree", "setup", "remove-worktree"]);
const isAllowedOp = (op: string): boolean => ALLOWED_OPS.has(op) || op.startsWith("run:");

// The verdict TABLE, declared here independently of the impl (the ground truth the classification must match):
// exit 0 (not timed out) → already-green; else a spawn failure (code < 0) or a static-missing name → missing;
// else a legit red.
function expectedLevel(v: VerdictRecord): string {
    if (v.code === 0 && !v.timedOut) return "warn-already-green";
    if (v.code < 0 || v.staticWarn) return "warn-missing";
    return "ok-red";
}
const isWarn = (level: string): boolean => level === "warn-missing" || level === "warn-already-green";

export const PREFLIGHT_INVARIANTS: PreflightInvariant[] = [
    // The fresh-project guarantee (M10-acceptance finding): pre-flight must CREATE-IF-ABSENT the integration
    // branch before reading its tip — on a project that never ran a task, integration doesn't exist yet, and a
    // bare rev-parse throws (which hung the rail on "loading"). ensure-branch must precede the first rev-parse.
    {
        name: "integration-ensured-before-read",
        holds: (r) => {
            const read = r.ops.indexOf("rev-parse");
            if (read === -1) return true; // never read a tip → nothing to ensure
            const ensured = r.ops.indexOf("ensure-branch");
            if (ensured === -1) return "read the integration tip without ensuring the branch exists (fresh projects hang)";
            if (ensured > read) return "ensure-branch ran AFTER the tip was read — the fresh-project case still throws";
            return true;
        },
    },
    // THE structural safety property (spec §3, promote-mirrored): pre-flight advances/pushes NOTHING. The recorded
    // git surface is a subset of {rev-parse, create worktree, setup, run command, remove worktree} — no advance,
    // no push, ever. (PreflightDeps has no such seam, so this can only fail if a recording is hand-forged.)
    {
        name: "preflight-never-advances-refs",
        holds: (r) => {
            for (const op of r.ops) {
                if (/advance|push|branch -f|reset|commit/.test(op)) return `pre-flight performed a ref-mutating op: ${op}`;
                if (!isAllowedOp(op)) return `pre-flight performed an unexpected op outside the read-only lifecycle: ${op}`;
            }
            return true;
        },
    },
    // Every classified verdict matches the declared table for its scripted exit + static level. A red that's
    // actually already-green (or a missing script dressed up as a legit red) is caught here.
    {
        name: "verdict-classification-faithful",
        holds: (r) => {
            for (const v of r.verdicts) {
                const want = expectedLevel(v);
                if (v.level !== want) return `command "${v.command}" (exit ${v.code}, staticWarn=${v.staticWarn}) classified ${v.level} but the table says ${want}`;
            }
            return true;
        },
    },
    // Approve may proceed ONLY when every warn is acked — an unacked warn can never yield an approved outcome.
    {
        name: "approve-requires-acks",
        holds: (r) => {
            if (!r.approved) return true;
            const acked = new Set(r.acks);
            const unacked = r.verdicts.filter((v) => isWarn(v.level) && !acked.has(v.command)).map((v) => v.command);
            if (unacked.length) return `approved despite unacknowledged warn(s): ${unacked.join(", ")}`;
            return true;
        },
    },
    // The throwaway worktree is ALWAYS removed once created — on every path, including a mid-run throw. A created
    // worktree that was never removed is a leak.
    {
        name: "worktree-always-cleaned",
        holds: (r) => {
            if (r.worktreeCreated && !r.worktreeRemoved) return "the throwaway worktree was created but never removed (a leak)";
            return true;
        },
    },
];

export function runPreflightInvariants(r: PreflightRecording): InvariantResult[] {
    return PREFLIGHT_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
