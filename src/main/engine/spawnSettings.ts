// src/main/engine/spawnSettings.ts
// The pure composer for the per-spawn `--settings` JSON (spec §5.7/§10, M6-② Task 3). A LEAF: it takes a
// Project and returns the JSON string the chokepoint forwards to `claude --settings`. Kept pure + unit-
// tested; spawn.ts stays decoupled from Project (ipc builds the string at the edge and passes it down).
//
// Shape confirmed against Claude Code 2.1.172 by the Task-1 build-spike (scripts/settings-spike.ps1):
//   { "permissions": { "deny": [...] }, "autoMode": { "environment": [...] } }
// - permissions.deny runs BEFORE the auto-mode classifier and can't be overridden → the absolute
//   never-push belt (spec §5.7/§13). `Bash(git push:*)` is the canonical colon form `/permissions` emits;
//   the spike proved it actually blocks `git push origin HEAD` at the permission layer.
// - autoMode.environment is a string[] of natural-language trust lines. "$defaults" splices in the CLI's
//   built-in environment (which already trusts "the git repository the agent started in and its
//   configured remote(s)") — so we ALWAYS keep it, and a per-project autoModeEnvironment only ADDS lines.
import type { Project } from "../../shared/types";

// The never-push belt-and-suspenders (spec §5.7/§13). Also blocks `git remote set-url` so a push can't be
// smuggled by re-pointing the origin. Exported so the verify slice reads one source of truth.
export const NEVER_PUSH_DENY: string[] = ["Bash(git push:*)", "Bash(git remote set-url:*)"];

const DEFAULTS = "$defaults";

// Parse the raw per-project value into the extra trust lines, tolerating either a JSON string[] or plain
// newline-separated text. Always guarantees "$defaults" is present (prepended if absent) so the built-in
// safety environment is never accidentally replaced. NULL/blank → just ["$defaults"].
function buildEnvironment(raw: string | null): string[] {
    const trimmed = raw?.trim();
    if (!trimmed) return [DEFAULTS];

    let lines: string[];
    try {
        const parsed: unknown = JSON.parse(trimmed);
        lines = Array.isArray(parsed)
            ? parsed.map((v) => String(v).trim()).filter((v) => v.length > 0)
            : splitLines(trimmed); // JSON that isn't an array (e.g. a bare number/object) → treat as text
    } catch {
        lines = splitLines(trimmed);
    }

    return lines.includes(DEFAULTS) ? lines : [DEFAULTS, ...lines];
}

const splitLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

export function buildSpawnSettings(project: Project): string {
    return JSON.stringify({
        permissions: { deny: NEVER_PUSH_DENY },
        autoMode: { environment: buildEnvironment(project.autoModeEnvironment) },
    });
}
