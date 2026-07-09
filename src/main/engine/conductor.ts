// src/main/engine/conductor.ts
// The PURE conductor-session kernel (M16). The conductor is the per-project persistent interactive
// claude session — the planner pane grown into the project's single touchpoint. It has NO autonomy
// (it acts only in conversation); this module only decides HOW the session process is launched and
// when a recorded session may be resumed.
//
// The M5 resume-guard, conductor edition. Drop-in records a sessionId off the stream-json of a
// COMPLETED agent turn, so "recorded ⇔ resumable" holds by construction. An interactive TUI session
// has no observable turn boundary, so the conductor inverts the mechanism while keeping the kernel:
//   · a FRESH launch forces the id (`--session-id <uuid>`) so it is known and recordable up front;
//   · the id counts as RESUMABLE only once claude has actually persisted that session on disk
//     (the .jsonl under ~/.claude/projects/ — the exact ground truth `--resume` needs).
// A launch that dies before the first completed turn leaves no file → Resume stays disabled → we can
// never `claude --resume` a conversation claude can't find. Belt on top: the pwsh -NoExit wrapper
// (the M5 resilient-shell contract) lands any failed claude at a live shell, never a dead tab.
//
// LEAF MODULE (node:path only): the verify slice drives these directly
// (invariant conductor-resume-respects-guard).
import { join } from "node:path";

// The launch argv for the conductor PTY (the PtyFactory shape: argv[0]=program, rest=args — the
// buildDropinArgv sibling; cwd is the project repoPath, set by the manager). `resume` is honored ONLY
// with a recorded session id (belt: even a caller bug can't produce `--resume null`); otherwise a
// fresh launch forces the id so the caller can record it BEFORE claude ever writes a byte.
export function buildConductorArgv(sessionId: string | null, resume: boolean): string[] {
    const claude = resume && sessionId != null ? `claude --resume ${sessionId}`
        : sessionId != null ? `claude --session-id ${sessionId}`
            : "claude";
    return ["pwsh.exe", "-NoExit", "-Command", claude];
}

// Where claude persists a session for (repoPath, sessionId): ~/.claude/projects/<munged-cwd>/<id>.jsonl,
// where the munge replaces every non-alphanumeric char with "-" (e.g. I:\Personal\helm → I--Personal-helm).
// Takes `home` as an argument so the slice tests it without touching the real profile.
export function claudeSessionFile(home: string, repoPath: string, sessionId: string): string {
    const munged = repoPath.replace(/[^a-zA-Z0-9]/g, "-");
    return join(home, ".claude", "projects", munged, `${sessionId}.jsonl`);
}

// The guard predicate: "recorded ⇔ resumable". A recorded id counts iff claude's persisted session
// file exists. If the CC session layout ever changes, this degrades SAFELY: the probe misses, Resume
// stays disabled, and Fresh still works.
export function isConductorResumable(
    sessionId: string | null,
    fileExists: (path: string) => boolean,
    home: string,
    repoPath: string,
): boolean {
    return sessionId != null && fileExists(claudeSessionFile(home, repoPath, sessionId));
}
