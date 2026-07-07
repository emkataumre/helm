// src/main/engine/trayCounts.ts
// M12 tray fleet counts — PURE, Electron-free tooltip math. The board's task rows each carry a status;
// deriveTrayCounts folds them into the three at-a-glance fleet numbers the tray reports, and
// formatTrayTooltip renders the one-line tooltip. Both are pure fns of their inputs so they test headless.
// Electron's Tray stays strictly in index.ts, which just does setToolTip(formatTrayTooltip(deriveTrayCounts(tasks)));
// ipc.ts calls the same pair on the tasks:changed seam so the tooltip refreshes whenever the board mutates.
import type { TaskStatus } from "../../shared/types";

// Only the status field matters here — accept the minimal shape so any task-ish row (or a test fixture) fits.
export interface TrayCountable { status: TaskStatus }

export interface TrayCounts {
    running: number;
    needsHuman: number;
    merged: number;
}

// Fold the board into the three reported numbers. Every other status (queued / handed-off / abandoned) is
// deliberately NOT surfaced in the tooltip — it reports fleet activity (running), what needs a human, and
// what's landed (merged). Counts derive ONLY from the status field, never a stored aggregate.
export function deriveTrayCounts(tasks: readonly TrayCountable[]): TrayCounts {
    const counts: TrayCounts = { running: 0, needsHuman: 0, merged: 0 };
    for (const t of tasks) {
        if (t.status === "running") counts.running++;
        else if (t.status === "needs-human") counts.needsHuman++;
        else if (t.status === "merged") counts.merged++;
    }
    return counts;
}

// The one-line tooltip, e.g. "Helm — 2 running · 1 needs-human · 5 merged". Middle-dot separated; the labels
// are stable so a verifier (or a human) can read the fleet state at a glance without opening the window.
export function formatTrayTooltip(counts: TrayCounts): string {
    return `Helm — ${counts.running} running · ${counts.needsHuman} needs-human · ${counts.merged} merged`;
}
