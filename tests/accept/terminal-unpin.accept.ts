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
import { launchHelm, seededProject, until, ptyList } from "./harness";
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
            // The cockpit window id(s) BEFORE unpinning — so we can later close the detached window by
            // identity (the new id), not by array position: getAllWindows() returns most-recent first,
            // so wins[last] is the main window, not the detached one.
            const priorIds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.id));

            await app.evaluate(({}, tid) => {
                const reg = (globalThis as unknown as { __helmTerminalWindows?: { track(id: string): void; unpin(id: string): void } }).__helmTerminalWindows;
                reg?.track(tid); reg?.unpin(tid);
            }, id);
            await until(async () => (await windowCount(app)) === baseWindows + 1, { label: "detached window opened" });

            // Close the detached window the way a user would — the window that didn't exist before unpin.
            await app.evaluate(({ BrowserWindow }, prior) => {
                for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !prior.includes(w.id)) w.close();
            }, priorIds);
            // The PTY reattaches to the tiling — not orphaned, not double-hosted.
            await until(async () => (await hostKind(app, id)) === "tiling", { label: "terminal pinned back on window close" });
            expect(await windowCount(app)).toBe(baseWindows);
        } finally {
            await helm.close();
        }
    });

    it("the real Unpin button detaches the active terminal into its own OS window (UI trigger, not the test hook)", async () => {
        const { seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { app, page } = helm;
        try {
            // Open a free shell through the real picker so it's the ACTIVE pane, then click the real button —
            // this drives the preload bridge + HelmApi + renderer button end-to-end, not the __helm hook.
            await page.locator(".helm-sidebar").getByText("Terminals").click();
            await page.locator(".helm-select", { hasText: "Open shell in" }).locator("select").selectOption({ label: "AcceptProj — repo root" });
            const s = await until(async () => (await ptyList(page)).find((x) => x.kind === "free") ?? null, { label: "free pty session" });
            const baseWindows = await windowCount(app);

            await page.getByRole("button", { name: "Unpin terminal" }).first().click();
            await until(async () => (await windowCount(app)) === baseWindows + 1, { label: "detached window opened via button" });
            expect(await hostKind(app, s.id)).toBe("window");
        } finally {
            await helm.close();
        }
    });
});
