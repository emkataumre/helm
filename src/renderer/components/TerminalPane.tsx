// src/renderer/components/TerminalPane.tsx
// The ONE reusable xterm pane every later mount shares (drop-in now, planner + free tabs later). Wraps a
// Terminal + FitAddon over a single PTY session:
//   • human keystrokes  → term.onData → helm.ptyWrite
//   • pty output        → helm.onPtyData(id) → term.write   (filtered to THIS session)
//   • fit-on-resize      → helm.ptyResize(cols, rows)
// On mount it ATTACHes (the main-side scrollback replay paints history, then live streams); on unmount it
// DETACHes only — NEVER kill. Closing a view ≠ closing a session; kill is an explicit user action.
//
// xterm is browser-only (needs a real DOM), so it's loaded via DYNAMIC import INSIDE the effect — the
// react-dom/server shell-only render test (node env, no DOM) never touches it. The presentational shell
// carries the data-verify-* contract; xterm's internals are the vendor edge (untested), exactly as planned.
import { useEffect, useRef } from "react";
import type { PtySession } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

export function TerminalPane({ session }: { session: PtySession }) {
    const hostRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let disposed = false;
        let term: import("@xterm/xterm").Terminal | null = null;
        let unsubData: (() => void) | null = null;
        let resizeObs: ResizeObserver | null = null;

        void (async () => {
            const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
            if (disposed) return;
            const t = new Terminal({
                cursorBlink: true,
                // Cascadia first (ships with Win11): the generic ui-monospace stack lacked the box/braille
                // glyphs TUI art uses — the claude logo rendered broken (M10-acceptance finding).
                fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
                fontSize: 13,
                theme: { background: "#141413", foreground: "#FAF9F5", cursor: "#D97757" },
            });
            const fit = new FitAddon();
            t.loadAddon(fit);
            t.open(host);
            term = t;

            // Ctrl+V / Ctrl+Shift+V paste (M10-acceptance finding: with no app menu there's no paste
            // accelerator, so Ctrl+V just sent ^V to the pty and nothing pasted). term.paste() goes through
            // bracketed paste → the TUI receives it as a paste, not keystrokes. Alt+V (the claude TUI's own
            // image-paste binding) is untouched — it never reaches this handler's chord.
            t.attachCustomKeyEventHandler((e) => {
                if (e.type === "keydown" && e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) {
                    void navigator.clipboard.readText().then((text) => { if (text) t.paste(text); });
                    return false;
                }
                return true;
            });

            t.onData((data) => { void window.helm.ptyWrite(session.id, data); });
            unsubData = window.helm.onPtyData((id, chunk) => { if (id === session.id) t.write(chunk); });

            // M8 fit-timing fix (the M7 cosmetic note): fit ONLY once the host has real dimensions.
            // A synchronous fit() right after open() ran on an unlaid-out element — and a hidden tab's
            // element measures 0×0 — so the pty was sized to 0 and the TUI rendered full-width/sparse.
            // The ResizeObserver fires when layout lands (0→real) AND on every tab-switch remount/window
            // resize; tryFit no-ops until the element actually has a box, so the pty is always sized right.
            const tryFit = () => {
                if (disposed || !host.clientWidth || !host.clientHeight) return;
                fit.fit();
                void window.helm.ptyResize(session.id, t.cols, t.rows);
            };
            void window.helm.ptyAttach(session.id); // replay scrollback + live stream (xterm reflows on the first real fit)
            resizeObs = new ResizeObserver(() => tryFit());
            resizeObs.observe(host);
            tryFit(); // belt: fit now if the element is already laid out at mount
        })();

        return () => {
            disposed = true;
            resizeObs?.disconnect();
            unsubData?.();
            void window.helm.ptyDetach(session.id); // detach only — NEVER kill
            term?.dispose();
        };
    }, [session.id]);

    return (
        <div
            {...verifyAttrs({ unit: "TerminalPane", session: session.id, kind: session.kind, title: session.title })}
            style={{ height: "100%", width: "100%", background: "#141413", borderRadius: 10, overflow: "hidden", padding: 6, boxSizing: "border-box" }}
        >
            <div ref={hostRef} style={{ height: "100%", width: "100%" }} />
        </div>
    );
}
