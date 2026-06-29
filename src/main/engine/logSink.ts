// src/main/engine/logSink.ts
// Per-iteration raw NDJSON sink. The log lives under an INJECTED base dir (the app-data path is
// resolved at the ipc.ts edge, Task 12) so this stays pure Node — Electron-free and unit-testable —
// and the log outlives the worktree (a needs-human task's `.ralph/` dies with its worktree, but its
// raw log must survive for inspection). No pruning in M3.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogSink = (line: string) => void;

export function createLogSink(baseDir: string, taskId: string, index: number): LogSink {
    const dir = join(baseDir, taskId);
    const file = join(dir, `iter-${index}.ndjson`);
    let ensured = false;
    return (line: string) => {
        if (!ensured) { mkdirSync(dir, { recursive: true }); ensured = true; } // lazy: no empty dirs
        appendFileSync(file, `${line}\n`);
    };
}
