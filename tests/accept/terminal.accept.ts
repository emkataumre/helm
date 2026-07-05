// M8.5 acceptance scenarios — the embedded terminal (re-automates the M7/M8 manual terminal checks): a
// free terminal round-trip and a tab-switch scrollback re-attach. PTY facts are asserted via window.helm
// session metadata + the pty:data stream (the guide's structured agent handle), NOT by scraping xterm's DOM
// rows. Every scenario try/finally-closes its Electron app; no real claude runs. The worktree-reap scenario
// lives in reap.accept.ts (runs earlier, on a clean console — see that file's header).
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject, until, collect, readBuf, ptyList, normPath } from "./harness";

describe("terminal", () => {
    it("free terminal round-trip: [+ terminal] on a project → live pwsh in the repo → close kills it", async () => {
        const { repo, seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { page } = helm;
        try {
            // [+ terminal] on the project (cwd = repoPath). App calls window.helm.ptyCreate → a tab opens.
            await page.getByRole("button", { name: "+ AcceptProj", exact: true }).click();
            const s = await until(async () => (await ptyList(page)).find((x) => x.kind === "free") ?? null, { label: "free pty session" });
            expect(s.alive).toBe(true);
            expect(normPath(s.cwd)).toBe(normPath(repo)); // the shell really opened in the repo
            // The renderer drew the tab (its title is visible).
            await page.getByText("AcceptProj — shell").waitFor({ state: "visible", timeout: 15_000 });

            // Type a command into the pane (API-side write = exactly what term.onData does) and observe the
            // output on the real pty:data stream — the round-trip works.
            await collect(page, s.id);
            await page.evaluate((id) => window.helm.ptyWrite(id, "echo helloaccept12345\r"), s.id);
            await until(async () => (await readBuf(page, s.id)).includes("helloaccept12345"), { timeoutMs: 25_000, label: "pty echo output" });

            // Close the tab (the × — the only renderer-initiated kill). The session dies.
            await page.getByTitle("Close terminal (kills this session)").click();
            await until(async () => { const cur = (await ptyList(page)).find((x) => x.id === s.id); return !cur || !cur.alive; }, { label: "session dead after close" });
            // The tab is gone from the DOM (host unmounts when the last tab closes).
            await until(async () => (await page.getByText("AcceptProj — shell").count()) === 0, { label: "tab removed from DOM" });
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
            await page.getByRole("button", { name: "+ AcceptProj", exact: true }).click();
            const a = await until(async () => (await ptyList(page)).find((x) => x.kind === "free") ?? null, { label: "session A" });
            await collect(page, a.id);
            await page.evaluate((id) => window.helm.ptyWrite(id, "echo scrollmarkerA\r"), a.id);
            await until(async () => (await readBuf(page, a.id)).includes("scrollmarkerA"), { timeoutMs: 25_000, label: "A produced output" });

            // Tab B — becomes active, so A's pane unmounts and detaches (the "switch away").
            await page.getByRole("button", { name: "+ AcceptProj", exact: true }).click();
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
