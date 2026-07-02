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
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
                theme: { background: "#141413", foreground: "#FAF9F5", cursor: "#D97757" },
            });
            const fit = new FitAddon();
            t.loadAddon(fit);
            t.open(host);
            fit.fit();
            term = t;

            t.onData((data) => { void window.helm.ptyWrite(session.id, data); });
            unsubData = window.helm.onPtyData((id, chunk) => { if (id === session.id) t.write(chunk); });

            // attach LAST: the replay + live stream now lands in a terminal that's open and sized.
            const pushResize = () => { fit.fit(); void window.helm.ptyResize(session.id, t.cols, t.rows); };
            void window.helm.ptyAttach(session.id);
            pushResize();
            resizeObs = new ResizeObserver(() => pushResize());
            resizeObs.observe(host);
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
