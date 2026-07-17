// src/renderer/components/TerminalTiling.tsx
// Side-by-side terminal tiling: N TerminalPanes in a horizontal split with draggable
// role="separator" handles between neighbours, so a running session and its drop-in can be
// watched together. Sizes are percentages of the row; dragging a handle moves ONLY the pair
// either side of it (resizeSplit — clamped so no pane collapses, total preserved). Each pane
// hosts the real xterm TerminalPane keyed by session id — its ResizeObserver re-fits the pty
// on every drag, so the split IS the resize wiring. initialSizes is an initializer only
// (renderer state, not persisted) — the static-render tests use it to drive a known split,
// since the no-jsdom harness can't drag the handle.
import { useRef, useState } from "react";
import type { PtySession } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";
import { TerminalPane } from "./TerminalPane";

// No pane may be dragged below this share of the row — a sliver of terminal is unreadable
// and a 0-width pane would fit the pty to nothing.
export const MIN_PANE_PCT = 15;

export function evenSplit(count: number): number[] {
    return Array.from({ length: count }, () => 100 / count);
}

// The drag math: move the boundary between pane i and pane i+1 by deltaPct, clamped so both
// stay at or above MIN_PANE_PCT. Only that pair moves; the total is preserved.
export function resizeSplit(sizes: number[], handleIndex: number, deltaPct: number, minPct: number = MIN_PANE_PCT): number[] {
    const a = sizes[handleIndex];
    const b = sizes[handleIndex + 1];
    if (a === undefined || b === undefined) return sizes;
    const clamped = Math.max(minPct - a, Math.min(deltaPct, b - minPct));
    const next = sizes.slice();
    next[handleIndex] = a + clamped;
    next[handleIndex + 1] = b - clamped;
    return next;
}

export function TerminalTiling({ sessions, initialSizes, labels }: {
    sessions: PtySession[];
    initialSizes?: number[];
    // Helm-side display names keyed by session id (task title / manual rename) — presentation
    // only; an omitted id falls back to the session's own pty title inside TerminalPane.
    labels?: Record<string, string>;
}) {
    const [sizes, setSizes] = useState<number[]>(() =>
        initialSizes && initialSizes.length === sessions.length ? initialSizes : evenSplit(sessions.length));
    const rowRef = useRef<HTMLDivElement | null>(null);

    const startDrag = (handleIndex: number) => (down: React.PointerEvent<HTMLDivElement>) => {
        const row = rowRef.current;
        if (!row || !row.clientWidth) return;
        down.preventDefault();
        const pxToPct = 100 / row.clientWidth;
        const startX = down.clientX;
        const startSizes = sizes;
        const handle = down.currentTarget;
        handle.setPointerCapture(down.pointerId);
        const onMove = (e: PointerEvent) => setSizes(resizeSplit(startSizes, handleIndex, (e.clientX - startX) * pxToPct));
        const onUp = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onUp);
            handle.removeEventListener("pointercancel", onUp);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
    };

    return (
        <div ref={rowRef}
            {...verifyAttrs({ unit: "TerminalTiling", panes: sessions.length, sizes: sizes.map((s) => Math.round(s)).join(",") })}
            style={{ display: "flex", height: "100%", width: "100%", minHeight: 0, minWidth: 0 }}>
            {sessions.map((s, i) => (
                // Fragments would do, but the handle belongs BETWEEN panes — render it before every pane but the first.
                <div key={s.id} style={{ display: "contents" }}>
                    {i > 0 && (
                        <div role="separator" aria-orientation="vertical" aria-label="Resize split"
                            {...verifyAttrs({ handle: i - 1 })}
                            onPointerDown={startDrag(i - 1)}
                            style={{ flex: "0 0 6px", cursor: "col-resize", background: "var(--border-subtle)", borderRadius: 3, alignSelf: "stretch", touchAction: "none" }} />
                    )}
                    <div {...verifyAttrs({ pane: i, "pane-session": s.id })}
                        style={{ flexGrow: 1, flexShrink: 1, flexBasis: `${sizes[i]}%`, minWidth: 0, minHeight: 0 }}>
                        <TerminalPane key={s.id} session={s} label={labels?.[s.id]} />
                    </div>
                </div>
            ))}
        </div>
    );
}
