// src/main/engine/terminalWindow.ts
// The PURE, DI'd home of the terminal pin/unpin + detached-window registry (the "unpin a terminal into
// its own OS window and pin it back" feature). Electron-free and fake-able exactly like ptyManager: the
// window side effects (create/destroy a real BrowserWindow, re-point a PTY's stream) are injected as a
// `WindowDriver`, so a test drives the REAL registry with a fake driver and the native window layer NEVER
// loads. The real driver is wired only in ipc.ts.
//
// The MODEL — a terminal (its PTY session id) always has EXACTLY ONE live host: the in-app tiling
// ("pinned"), or a detached OS window ("unpinned", keyed by a windowId). The node-pty process stays in
// main throughout; unpin routes its stream to the new window, pin-back routes it back into the tiling.
// The state machine's whole job is to keep that "exactly one host, never orphaned" contract true through
// unpin / pin-back / an externally-closed window.
//
// LEAF MODULE: imports nothing (pure state + predicates), so the verify slice can drive the real
// transitions AND assert the real invariants with zero Electron — the ptyManager/dropin-slice pattern.

// A terminal's host: the in-app tiling, or one specific detached OS window.
export type Host =
    | { readonly kind: "tiling" }
    | { readonly kind: "window"; readonly windowId: string };

export const TILING: Host = { kind: "tiling" };

// The machine-readable surface (verification.md §1): the whole registry state as a plain, serializable
// object a verifier (or a snapshot) can read directly.
//   • hosts:   termId → its current host. A terminal present here is TRACKED; every tracked terminal MUST
//              have a host (the no-orphan contract).
//   • windows: windowId → the termId it hosts. The back-index — exactly one terminal per detached window.
export interface PinState {
    readonly hosts: Readonly<Record<string, Host>>;
    readonly windows: Readonly<Record<string, string>>;
}

export function emptyPinState(): PinState {
    return { hosts: {}, windows: {} };
}

// ── Pure transitions ────────────────────────────────────────────────────────────────────────────────
// Every reducer is TOTAL: idempotent, tolerant of unknown ids (never throws), and returns a NEW state
// (the previous one is never mutated — probes clone a baseline and flip one field). None may ever leave a
// tracked terminal hostless or point two hosts at one terminal — that's the whole contract they defend.

// Track a terminal, hosted by the tiling. Idempotent: a terminal already tracked keeps its current host
// (re-tracking an unpinned terminal must NOT silently yank it back to the tiling).
export function track(s: PinState, termId: string): PinState {
    if (s.hosts[termId]) return s;
    return { hosts: { ...s.hosts, [termId]: TILING }, windows: s.windows };
}

// Forget a terminal entirely (its PTY was killed / closed): drop its host AND any window it occupied, so a
// dead terminal can never leave a dangling window→term back-pointer.
export function untrack(s: PinState, termId: string): PinState {
    if (!s.hosts[termId]) return s;
    const hosts = { ...s.hosts };
    delete hosts[termId];
    const windows = { ...s.windows };
    for (const [wid, tid] of Object.entries(windows)) if (tid === termId) delete windows[wid];
    return { hosts, windows };
}

// Unpin: move a tiling-hosted terminal into its OWN detached window (windowId supplied by the caller — the
// impure driver.open result, kept out of this pure core). No-op unless the terminal is tracked AND
// currently in the tiling: an untracked id or an already-detached one is left untouched, so a
// double-unpin can never fork one terminal across two windows (the "two hosts" failure).
export function unpin(s: PinState, termId: string, windowId: string): PinState {
    const h = s.hosts[termId];
    if (!h || h.kind !== "tiling") return s;
    return {
        hosts: { ...s.hosts, [termId]: { kind: "window", windowId } },
        windows: { ...s.windows, [windowId]: termId },
    };
}

// Pin back: reattach a detached terminal into the tiling and forget its window. No-op unless the terminal
// is currently in a window.
export function pinBack(s: PinState, termId: string): PinState {
    const h = s.hosts[termId];
    if (!h || h.kind !== "window") return s;
    const windows = { ...s.windows };
    delete windows[h.windowId];
    return { hosts: { ...s.hosts, [termId]: TILING }, windows };
}

// An OS window was closed (by the driver's own pin-back, OR by the user closing the detached window): the
// terminal it hosted returns to the tiling — NEVER orphaned. No-op for an unknown/already-forgotten window
// (so the driver's post-pin-back 'closed' event is a harmless re-entry).
export function windowClosed(s: PinState, windowId: string): PinState {
    const termId = s.windows[windowId];
    if (termId === undefined) return s;
    const windows = { ...s.windows };
    delete windows[windowId];
    const hosts = s.hosts[termId] ? { ...s.hosts, [termId]: TILING } : s.hosts;
    return { hosts, windows };
}

// ── Invariants (verification.md §3) — the durable truths the model must always satisfy ────────────────
// Pure predicates over a PinState. Each returns `true` (holds) or a human-readable violation string. These
// are the domain truths the whole feature exists to keep, expressed once and read off the surface.
export interface PinInvariant { name: string; holds: (s: PinState) => true | string }
export interface PinCheck { name: string; ok: boolean; detail?: string }

export const PIN_INVARIANTS: PinInvariant[] = [
    // Every tracked terminal has EXACTLY ONE host, and a window-host's back-index agrees. This is the core
    // "unpin/pin-back keeps one live host per terminal" contract: a terminal whose host is a window that
    // doesn't point back (or points at a DIFFERENT terminal) means the stream and the window disagree —
    // effectively two/zero hosts.
    {
        name: "exactly-one-host-per-terminal",
        holds: (s) => {
            for (const [termId, host] of Object.entries(s.hosts)) {
                if (host == null) return `terminal ${termId} has no host`;
                if (host.kind === "window") {
                    if (!(host.windowId in s.windows)) return `terminal ${termId} claims window ${host.windowId} but no such window is registered`;
                    if (s.windows[host.windowId] !== termId) return `terminal ${termId} claims window ${host.windowId}, but that window hosts ${s.windows[host.windowId]}`;
                } else if (host.kind !== "tiling") {
                    return `terminal ${termId} has an unknown host kind`;
                }
            }
            return true;
        },
    },
    // No orphaned PTY: every terminal the registry knows about is routed SOMEWHERE (tiling or a window) —
    // never left hostless. This is the exact failure the task's probe hunts for: an unpin that drops a
    // terminal's host without giving it a window leaves its live node-pty streaming to nothing.
    {
        name: "no-orphan-pty",
        holds: (s) => {
            for (const [termId, host] of Object.entries(s.hosts)) {
                if (host == null) return `terminal ${termId} is orphaned (no host — its PTY streams nowhere)`;
                if (host.kind !== "tiling" && host.kind !== "window") return `terminal ${termId} has an invalid host`;
            }
            return true;
        },
    },
    // Window-registry consistency: every detached window hosts exactly ONE tracked terminal whose host
    // points back at THIS window, and no two windows host the same terminal. A window pointing at an
    // unknown terminal, or two windows claiming one terminal, is the "two hosts for one terminal" failure.
    {
        name: "one-terminal-per-window",
        holds: (s) => {
            const claimedBy: Record<string, string> = {};
            for (const [windowId, termId] of Object.entries(s.windows)) {
                const host = s.hosts[termId];
                if (!host) return `window ${windowId} hosts unknown terminal ${termId}`;
                if (host.kind !== "window" || host.windowId !== windowId) {
                    return `window ${windowId} hosts ${termId}, but that terminal's host is ${host.kind === "window" ? `window ${host.windowId}` : "the tiling"} (two hosts for one terminal)`;
                }
                if (claimedBy[termId]) return `terminal ${termId} is hosted by two windows (${claimedBy[termId]} and ${windowId})`;
                claimedBy[termId] = windowId;
            }
            return true;
        },
    },
];

// Run every invariant, wrapping each so a predicate that THROWS becomes a FAILED check, never a silent
// pass ("when in doubt, FAIL" — verification.md §5).
export function checkPinState(s: PinState): PinCheck[] {
    return PIN_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(s);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}

// ── The DI'd registry — the pure machine wired to a side-effecting window driver ──────────────────────
// The driver is the ONE impure seam (verification.md's surface-vs-internals split): the real one (ipc.ts)
// creates/destroys a BrowserWindow and re-points the PTY's data stream; every test injects a fake. The
// registry owns the PinState and applies the reducers around each driver call, so the "exactly one host"
// contract holds at every observable moment.
export interface WindowDriver {
    // Create a detached OS window hosting termId; return its stable window id.
    open(termId: string): string;
    // Destroy the detached OS window.
    close(windowId: string): void;
    // Re-point the terminal's PTY stream at its new host (a window, or back to the tiling).
    route(termId: string, host: Host): void;
}

export interface TerminalWindowRegistry {
    track(termId: string): void;
    untrack(termId: string): void;
    unpin(termId: string): void;               // tiling → own window (driver.open + route)
    pinBack(termId: string): void;             // window → tiling (driver.close + route)
    windowClosed(windowId: string): void;      // the driver's 'closed' callback — reattach, never orphan
    hostOf(termId: string): Host | undefined;
    isUnpinned(termId: string): boolean;
    state(): PinState;                         // the machine-readable surface
}

export function createTerminalWindowRegistry(driver: WindowDriver): TerminalWindowRegistry {
    let state = emptyPinState();

    return {
        track: (termId) => { state = track(state, termId); },
        untrack: (termId) => { state = untrack(state, termId); },
        unpin: (termId) => {
            const h = state.hosts[termId];
            if (!h || h.kind !== "tiling") return; // only a tracked, tiling-hosted terminal unpins (idempotent)
            const windowId = driver.open(termId);  // impure: mint the real window FIRST…
            state = unpin(state, termId, windowId); // …then record it, then route — so state never lies mid-op
            driver.route(termId, { kind: "window", windowId });
        },
        pinBack: (termId) => {
            const h = state.hosts[termId];
            if (!h || h.kind !== "window") return; // only a detached terminal pins back (idempotent)
            const windowId = h.windowId;
            state = pinBack(state, termId);         // drop the window mapping BEFORE closing, so the driver's
            driver.close(windowId);                 // resulting 'closed' → windowClosed() is a harmless no-op
            driver.route(termId, TILING);
        },
        windowClosed: (windowId) => {
            const termId = state.windows[windowId];
            state = windowClosed(state, windowId);
            if (termId !== undefined) driver.route(termId, TILING); // user-closed the window → reattach to tiling
        },
        hostOf: (termId) => state.hosts[termId],
        isUnpinned: (termId) => state.hosts[termId]?.kind === "window",
        state: () => state,
    };
}
