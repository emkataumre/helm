// M8.5 regression scenario for the 2026-07-05 machine-wide "terminals randomly die" incident. The gun:
// under Electron + OS ConPTY, node-pty's pty.kill() forks a conpty_console_list_agent that crashes
// ("AttachConsole failed"), and its 5s timeout-fallback then process.kill()s the shell's pid ~5s AFTER the
// native kill freed it — a delayed stray fire at whatever recycled the PID (killing innocent console hosts
// machine-wide). Fixed at the source: nodePtyFactory spawns with useConptyDll:true, whose kill branch never
// forks the agent and never schedules the fallback. This scenario is the accept-layer canary: kill a shell,
// stay alive PAST the 5s window, and assert the Electron main process emitted NO agent/AttachConsole traffic.
// A revert to the OS-conpty kill path re-forks the crashing agent within ~5s → this FAILS.
import { describe, it, expect } from "vitest";
import { launchHelm, seededProject } from "./harness";

describe("kill", () => {
    it("ptyKill takes the conpty.dll branch — no crashed agent, no delayed stray-fire process.kill", async () => {
        const { repo, seed } = seededProject();
        const helm = await launchHelm({ seed });
        const { app, page } = helm;
        // Capture the Electron MAIN-process stderr — where the agent crash + its 5s-later process.kill surface.
        let mainStderr = "";
        const stderr = app.process().stderr;
        if (!stderr) throw new Error("could not capture Electron main stderr — the canary would pass vacuously");
        stderr.on("data", (d: Buffer) => { mainStderr += d.toString(); });
        try {
            // Create a real shell, then kill it — the exact operation that fired the stray process.kill.
            const s = await page.evaluate((cwd) => window.helm.ptyCreate({ cwd, argv: ["pwsh.exe", "-NoLogo"], kind: "free", title: "kill probe" }), repo);
            await new Promise((r) => setTimeout(r, 1500)); // let pwsh boot
            await page.evaluate((id) => window.helm.ptyKill(id), s.id);
            // Stay alive well PAST node-pty's 5s timeout-fallback window (the OS-conpty branch would fork the
            // agent, crash it, then fire process.kill() at whatever recycled the freed pid here).
            await new Promise((r) => setTimeout(r, 6500));
            expect(mainStderr).not.toMatch(/conpty_console_list_agent|AttachConsole/);
        } finally {
            await helm.close();
        }
    });
});
