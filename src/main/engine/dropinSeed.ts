// src/main/engine/dropinSeed.ts
// Start-fresh drop-in seeding (the #7 floor). When a task is dropped into with "Start fresh" there is
// often NO resumable claude session to --resume (the M5 finding: an iteration killed before claude
// persisted its session leaves nothing on disk to resume), so the fresh terminal would otherwise open
// blank. This composes a context bundle from the task's own on-disk state so an EARLY drop-in lands with
// real context instead of a cold prompt — reusing what the t1 seeding path already wrote:
//   .ralph/TASK.md     — the full directive (seeded write-if-absent at worktree setup)
//   .ralph/progress.md — the running notes the last iteration left behind
//   the tail of the latest iteration log (logSink's iter-<index>.ndjson) — this one is NOT in the
//   worktree (it lives under app-data and outlives the worktree), so only a composer that reaches into
//   the log dir can surface it into the fresh session.
//
// PURE composer (composeDropinSeed) + thin IO reader (readDropinSeedInputs / readTranscriptTail), the
// codebase's edge-IO seam: the composer assembles the bundle from already-read bytes and is unit-tested
// against raw content; the readers do the filesystem work at the ipc edge.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DropinSeedInputs {
    task: string | null;            // .ralph/TASK.md contents
    progress: string | null;        // .ralph/progress.md contents
    transcriptTail: string | null;  // tail of the latest iter-<index>.ndjson
}

// How much of the latest iteration log to carry — enough to show what the killed session was doing
// without dumping an unbounded NDJSON stream into the seed.
const TRANSCRIPT_TAIL = 2000;

const blank = (s: string | null): boolean => s == null || s.trim().length === 0;

// Read a UTF-8 file, returning null on any error or a whitespace-only body (a missing worktree file is
// the normal early-drop-in case, not an error).
function readOrNull(path: string): string | null {
    try {
        const s = readFileSync(path, "utf8");
        return s.trim().length ? s : null;
    } catch {
        return null;
    }
}

// The tail of the HIGHEST-index iteration log for a task. logSink writes iter-<index>.ndjson under
// <logBaseDir>/<taskId>/; the freshest iteration is the one whose tail is most relevant to a drop-in.
// null when the task has no readable log yet (a drop-in before iteration 0 ever persisted a line).
export function readTranscriptTail(logBaseDir: string, taskId: string, maxChars = TRANSCRIPT_TAIL): string | null {
    let files: string[];
    try {
        files = readdirSync(join(logBaseDir, taskId));
    } catch {
        return null; // no log dir for this task yet
    }
    const indices = files
        .map((f) => /^iter-(\d+)\.ndjson$/.exec(f))
        .filter((m): m is RegExpExecArray => m != null)
        .map((m) => Number(m[1]));
    if (!indices.length) return null;
    const raw = readOrNull(join(logBaseDir, taskId, `iter-${Math.max(...indices)}.ndjson`));
    if (raw == null) return null;
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
}

// Gather the three on-disk inputs a Start-fresh drop-in seeds from: the two .ralph files from THIS
// worktree's checkout, and the transcript tail from the (worktree-outliving) log dir.
export function readDropinSeedInputs(worktreePath: string, logBaseDir: string, taskId: string): DropinSeedInputs {
    return {
        task: readOrNull(join(worktreePath, ".ralph", "TASK.md")),
        progress: readOrNull(join(worktreePath, ".ralph", "progress.md")),
        transcriptTail: readTranscriptTail(logBaseDir, taskId),
    };
}

// Compose the seed bundle: a fresh-session preamble followed by each PRESENT input under its own heading,
// each reproduced VERBATIM so the fresh session sees exactly what is on disk. Returns "" when NOTHING is on
// disk (every input blank) — the caller treats an empty bundle as "no seed" (falls back to a bare claude),
// and the mandated probe asserts that a blank bundle FAILS the has-context invariant even though the files
// exist (which is exactly what the pre-seam bare-`claude` Start-fresh produced).
export function composeDropinSeed(inputs: DropinSeedInputs): string {
    const sections: string[] = [];
    if (!blank(inputs.task)) sections.push(`## .ralph/TASK.md\n\n${inputs.task}`);
    if (!blank(inputs.progress)) sections.push(`## .ralph/progress.md\n\n${inputs.progress}`);
    if (!blank(inputs.transcriptTail)) sections.push(`## Recent transcript tail (latest iteration log)\n\n${inputs.transcriptTail}`);
    if (!sections.length) return "";
    return `# Drop-in context — Start fresh (no resumable session)

You are dropping into an in-flight task fresh: there is no prior claude session to resume, but the
previous iterations left their state on disk and it is reproduced below. Read it, then follow the
ritual in .ralph/INSTRUCTIONS.md and continue the task.

${sections.join("\n\n")}
`;
}
