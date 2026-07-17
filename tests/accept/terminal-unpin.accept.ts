// M-terminal-unpin acceptance scenario — the LIVE-window tail of the pin/unpin feature (the pure state
// machine + its invariants are proven headlessly in tests/verify/terminal-window/pin-state.test.ts; this
// proves the REAL BrowserWindow behind it, which `npm run check` cannot drive). Runs under `npm run accept`.
//
// Why app.evaluate and not a UI click: the pin/unpin trigger lives on a main-side registry reachable from a
// renderer button only through the preload bridge (src/preload/index.ts) + shared HelmApi (src/shared) — both
// OUT of this feature's edit scope. So the scenario drives the registry the way the acceptance guide allows
// for main-process behaviour: through `app.evaluate` against the accept-only `__helmTerminalWindows` hook
// (exposed in ipc.ts only when HELM_USER_DATA is set — i.e. only under this harness). The user-facing
// "close the detached window to pin back" path IS reachable and is asserted too.
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject, until } from "./harness";
import type { CreatePtyOptions } from "../../src/shared/types";

// Count the live top-level BrowserWindows (the main cockpit is always one; each detached terminal adds one).
async function windowCount(app: import("playwright-core").ElectronApplication): Promise<number> {
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length);
}
// The registry surface (PinState) as seen from the main process — the machine-readable proof of the host.
async function hostKind(app: import("playwright-core").ElectronApplication, termId: string): Promise<string | undefined> {
    return app.evaluate(({}, id) => {
        const reg = (globalThis as unknown as { __helmTerminalWindows?: { state(): { hosts: Record<string, { kind: string } | undefined> } } }).__helmTerminalWindows;
        return reg?.state().hosts[id]?.kind;
    }, termId);
}

describe("terminal unpin/pin", () => {
    it("unpin opens a real OS window, pin-back destroys it — one live host throughout", async () => {
        const { repo, seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { app, page } = helm;
        try {
            // A real free PTY in the repo (main-resident node-pty).
            const opts: CreatePtyOptions = { cwd: repo, argv: ["pwsh.exe", "-NoLogo"], kind: "free", title: "unpin-me" };
            const session = await page.evaluate((o) => window.helm.ptyCreate(o), opts);
            const id = session.id;
            const baseWindows = await windowCount(app);

            // Unpin → track-then-detach through the pure registry; a new BrowserWindow appears and the
            // terminal's host becomes a window.
            await app.evaluate(({}, tid) => {
                const reg = (globalThis as unknown as { __helmTerminalWindows?: { track(id: string): void; unpin(id: string): void } }).__helmTerminalWindows;
                reg?.track(tid); reg?.unpin(tid);
            }, id);
            await until(async () => (await windowCount(app)) === baseWindows + 1, { label: "detached window opened" });
            expect(await hostKind(app, id)).toBe("window");

            // Pin back → the detached window is destroyed and the host returns to the tiling.
            await app.evaluate(({}, tid) => {
                (globalThis as unknown as { __helmTerminalWindows?: { pinBack(id: string): void } }).__helmTerminalWindows?.pinBack(tid);
            }, id);
            await until(async () => (await windowCount(app)) === baseWindows, { label: "detached window destroyed on pin-back" });
            expect(await hostKind(app, id)).toBe("tiling");
        } finally {
            await helm.close();
        }
    });

    it("closing the detached OS window pins the terminal back into the tiling (never orphans the PTY)", async () => {
        const { repo, seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { app, page } = helm;
        try {
            const opts: CreatePtyOptions = { cwd: repo, argv: ["pwsh.exe", "-NoLogo"], kind: "free", title: "close-me" };
            const session = await page.evaluate((o) => window.helm.ptyCreate(o), opts);
            const id = session.id;
            const baseWindows = await windowCount(app);

            await app.evaluate(({}, tid) => {
                const reg = (globalThis as unknown as { __helmTerminalWindows?: { track(id: string): void; unpin(id: string): void } }).__helmTerminalWindows;
                reg?.track(tid); reg?.unpin(tid);
            }, id);
            await until(async () => (await windowCount(app)) === baseWindows + 1, { label: "detached window opened" });

            // Close the detached window the way a user would (the last-opened, non-main window).
            await app.evaluate(({ BrowserWindow }) => {
                const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
                wins[wins.length - 1]?.close();
            });
            // The PTY reattaches to the tiling — not orphaned, not double-hosted.
            await until(async () => (await hostKind(app, id)) === "tiling", { label: "terminal pinned back on window close" });
            expect(await windowCount(app)).toBe(baseWindows);
        } finally {
            await helm.close();
        }
    });
});
