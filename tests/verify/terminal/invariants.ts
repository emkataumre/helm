// tests/verify/terminal/invariants.ts
// The three M7 terminal-safety invariants — pure predicates over the TerminalRecording. Each returns
// `true` or a human-readable violation string; runTerminalInvariants wraps them so a predicate that
// THROWS becomes a failed check, never a silent pass ("when in doubt, FAIL"). Distinct from, and
// complementary to, the untouched M2/M3/M4/M5/M6 slices.
import type { TerminalRecording } from "./surface";

export interface TerminalInvariant { name: string; holds: (r: TerminalRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const TERMINAL_INVARIANTS: TerminalInvariant[] = [
    // The quit path reaps everything: after disposeAll() no session is left alive, every created session's
    // handle.kill was invoked, and an explicit kill(id) genuinely kills (invokes the handle + flips alive).
    // This is what backs Task-7's "no orphan pwsh/conhost on Quit".
    {
        name: "no-orphan-ptys",
        holds: (r) => {
            if (r.orphansAfterDispose !== 0) return `${r.orphansAfterDispose} session(s) still alive after disposeAll()`;
            if (r.killedHandleCount < r.createdCount) return `only ${r.killedHandleCount}/${r.createdCount} sessions' kill was invoked`;
            if (!r.killActuallyKills) return "kill(id) did not invoke the handle's kill / flip the session not-alive";
            return true;
        },
    },
    // The resume-guard, carried onto the in-app surface: the drop-in argv contains `--resume <id>` IFF a
    // resumable session exists (M5's kernel "recorded sessionId ⇔ resumable"). A null-session task must
    // never carry --resume (it would `claude --resume` a session claude never persisted → "No conversation").
    {
        name: "dropin-respects-resume-guard",
        holds: (r) => {
            for (const c of r.argvCases) {
                const carriesResume = c.argv.join(" ").includes("--resume");
                if (carriesResume !== (c.sessionId != null)) {
                    return `argv resume=${carriesResume} but sessionId=${c.sessionId === null ? "null" : `"${c.sessionId}"`} (must agree)`;
                }
                if (c.sessionId != null && !c.argv.join(" ").includes(`--resume ${c.sessionId}`)) {
                    return `resumable case does not carry "--resume ${c.sessionId}"`;
                }
            }
            return true;
        },
    },
    // Attach replays the scrollback ring in order (so a hidden/reopened window repaints history), then
    // streams live in order. A dropped/re-ordered chunk in the replay means the reopened tab lies about
    // what happened — the whole point of the main-resident ring.
    {
        name: "attach-replays-scrollback",
        holds: (r) => {
            if (r.replayed !== r.emittedBeforeAttach) return `replay "${r.replayed}" ≠ pre-attach "${r.emittedBeforeAttach}" (dropped/reordered)`;
            if (r.streamedAfterAttach !== r.liveEmittedAfterAttach) return `live stream "${r.streamedAfterAttach}" ≠ emitted "${r.liveEmittedAfterAttach}"`;
            return true;
        },
    },
];

export function runTerminalInvariants(r: TerminalRecording): InvariantResult[] {
    return TERMINAL_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
