// src/renderer/terminalTabs.ts
// The pure tab-state kernel behind the M8 terminal host (App.tsx). Terminals are ephemeral (die with the
// process; no DB rows — a fresh boot has zero tabs, by design), so the whole model is this in-memory list
// plus "which one is focused". Keeping it here, DOM-free, means the "active tab after add/close/exit" logic
// is unit-tested (terminalTabs.test.ts) while the tab strip stays a thin presentational render (TerminalTabs).
import type { PtySession, PtySessionInfo } from "../shared/types";

// Append a newly created/dropped-in session as a tab, unless it's already open (idempotent by id) — so a
// second Drop in / [+ terminal] on the same live session re-focuses rather than duplicating the tab.
export function upsertTab(tabs: PtySessionInfo[], session: PtySession): PtySessionInfo[] {
    return tabs.some((t) => t.id === session.id) ? tabs : [...tabs, { ...session, alive: true }];
}

// Drop a tab (an explicit close = kill, or a session that exited). Nothing else — resolveActive re-picks
// the focus separately, so a caller never has to thread the two together.
export function removeTab(tabs: PtySessionInfo[], id: string): PtySessionInfo[] {
    return tabs.filter((t) => t.id !== id);
}

// The focused tab id after any list change: keep the current one if it's still open, else fall back to the
// LAST (most-recently-opened) tab, or null when nothing is left. Called whenever `tabs` changes so a closed
// active tab hands focus to a neighbour instead of blanking the pane.
export function resolveActive(tabs: PtySessionInfo[], active: string | null): string | null {
    if (active != null && tabs.some((t) => t.id === active)) return active;
    return tabs.length ? tabs[tabs.length - 1].id : null;
}
