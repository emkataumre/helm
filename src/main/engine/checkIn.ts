// src/main/engine/checkIn.ts
// The soft hourly check-in math, kept pure so the engine stays time-agnostic: ipc.ts owns the
// actual timer + Electron Notification, this just answers "how many check-ins are due by now?".
export const CHECKIN_INTERVAL_MS = 60 * 60 * 1000; // 60 min (spec §5.3 — informational, never kills)

export function checkInsDue(elapsedMs: number, intervalMs: number = CHECKIN_INTERVAL_MS): number {
    if (intervalMs <= 0 || elapsedMs < 0) return 0;
    return Math.floor(elapsedMs / intervalMs);
}
