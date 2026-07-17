// M8.5 acceptance scenarios — the embedded terminal (re-automates the M7/M8 manual terminal checks): a
// free terminal round-trip and a tab-switch scrollback re-attach. PTY facts are asserted via window.helm
// session metadata + the pty:data stream (the guide's structured agent handle), NOT by scraping xterm's DOM
// rows. Every scenario try/finally-closes its Electron app; no real claude runs. The worktree-reap scenario
// lives in reap.accept.ts (runs earlier, on a clean console — see that file's header).
//
// M14 cockpit deltas: terminals live in a dedicated Terminals view — shells open via the "Open shell in…"
// picker, killing a LIVE session confirms via dialog (closing is killing, §8.5), and a dead session stays
// listed greyed ("· exited") until explicitly removed.
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject, until, collect, readBuf, ptyList, normPath } from "./harness";
import type { Page } from "playwright-core";

// Open the Terminals view and spawn a free shell at the project's repo root through the real picker.
async function openShellIn(page: Page, projectLabel: string): Promise<void> {
    await page.locator(".helm-sidebar").getByText("Terminals").click();
    // Disambiguate from the project/task filter Selects (Plan 2 #12) that now share .helm-select:
    // target the "Open shell in…" picker specifically.
    await page.locator(".helm-select", { hasText: "Open shell in" }).locator("select").selectOption({ label: `${projectLabel} — repo root` });
}

describe("terminal", () => {
    it("free shell round-trip: Open shell in repo → live pwsh → kill (confirmed) → removable dead tab", async () => {
        const { repo, seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            await openShellIn(page, "AcceptProj");
            const s = await until(async () => (await ptyList(page)).find((x) => x.kind === "free") ?? null, { label: "free pty session" });
            expect(s.alive).toBe(true);
            expect(normPath(s.cwd)).toBe(normPath(repo)); // the shell really opened in the repo
            // The renderer drew the tab (its title is visible).
            await page.getByText("AcceptProj — shell").first().waitFor({ state: "visible", timeout: 15_000 });

            // Type a command into the pane (API-side write = exactly what term.onData does) and observe the
            // output on the real pty:data stream — the round-trip works.
            await collect(page, s.id);
            await page.evaluate((id) => window.helm.ptyWrite(id, "echo helloaccept12345\r"), s.id);
            await until(async () => (await readBuf(page, s.id)).includes("helloaccept12345"), { timeoutMs: 25_000, label: "pty echo output" });

            // Kill the session (the tab's ×, confirmed — closing is killing). The session dies but the tab
            // STAYS, greyed "· exited", until removed.
            await page.getByRole("button", { name: "Kill session" }).first().click();
            await page.locator(".helm-dialog").getByRole("button", { name: "Kill session", exact: true }).click();
            await until(async () => { const cur = (await ptyList(page)).find((x) => x.id === s.id); return !cur || !cur.alive; }, { label: "session dead after kill" });
            await page.getByText("· exited").waitFor({ state: "visible", timeout: 15_000 });

            // Remove the dead tab from the list (no confirm — nothing is running).
            await page.getByRole("button", { name: "Kill session" }).first().click();
            await until(async () => (await page.getByText("AcceptProj — shell").count()) === 0, { label: "dead tab removed from DOM" });
        } finally {
            await helm.close();
        }
    });

    it("tab-switch re-attach: write to A, open B, re-attach A → A's scrollback survives", async () => {
        const { seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // Tab A.
            await openShellIn(page, "AcceptProj");
            const a = await until(async () => (await ptyList(page)).find((x) => x.kind === "free") ?? null, { label: "session A" });
            await collect(page, a.id);
            await page.evaluate((id) => window.helm.ptyWrite(id, "echo scrollmarkerA\r"), a.id);
            await until(async () => (await readBuf(page, a.id)).includes("scrollmarkerA"), { timeoutMs: 25_000, label: "A produced output" });

            // Tab B — becomes active, so A's pane unmounts and detaches (the "switch away").
            await page.locator(".helm-select", { hasText: "Open shell in" }).locator("select").selectOption({ label: "AcceptProj — repo root" });
            const b = await until(async () => (await ptyList(page)).find((x) => x.kind === "free" && x.id !== a.id) ?? null, { label: "session B" });
            expect(b.id).not.toBe(a.id);

            // "Switch back to A": reset A's buffer, then re-attach → the manager replays A's scrollback ring.
            // If the ring survived (it must), the marker written before the switch reappears in the replay.
            await page.evaluate((id) => { (window as unknown as { __bufs: Record<string, string> }).__bufs[id] = ""; return window.helm.ptyAttach(id); }, a.id);
            await until(async () => (await readBuf(page, a.id)).includes("scrollmarkerA"), { timeoutMs: 15_000, label: "A scrollback replayed on re-attach" });
        } finally {
            await helm.close();
        }
    });
});
