// tests/engine/terminalLaunch.test.ts
// The drop-in terminal launch. Only the PURE command-builder is unit-tested; launchTerminal itself is
// the untested Electron edge (a thin detached spawn), exactly like M3's Notification.
import { describe, it, expect } from "vitest";
import { buildTerminalCommand, DEFAULT_TERMINAL_COMMAND } from "../../src/main/engine/terminalLaunch";

describe("buildTerminalCommand (pure)", () => {
    it("substitutes the (quoted) worktree and a resume flag with the default template", () => {
        const cmd = buildTerminalCommand(DEFAULT_TERMINAL_COMMAND, { worktree: "C:/Temp/wt path", resume: "--resume abc-123" });
        expect(cmd).toContain('"C:/Temp/wt path"'); // worktree stays quoted (the path-with-spaces lesson)
        expect(cmd).toContain("--resume abc-123");
        expect(cmd).toBe('wt.exe -d "C:/Temp/wt path" claude --resume abc-123');
    });

    it("leaves NO dangling --resume when resume is empty (Start fresh / no captured session)", () => {
        const cmd = buildTerminalCommand(DEFAULT_TERMINAL_COMMAND, { worktree: "/wt", resume: "" });
        expect(cmd).not.toContain("--resume");
        expect(cmd).toBe('wt.exe -d "/wt" claude ');
    });

    it("substitutes ALL occurrences of both placeholders in a custom template", () => {
        const tmpl = 'pwsh -NoExit -Command "cd {worktree}; echo {worktree}; claude {resume}"';
        const cmd = buildTerminalCommand(tmpl, { worktree: "/w", resume: "--resume s1" });
        expect(cmd).toBe('pwsh -NoExit -Command "cd /w; echo /w; claude --resume s1"');
    });

    it("leaves a template with no placeholders intact", () => {
        expect(buildTerminalCommand("just a literal command", { worktree: "/w", resume: "--resume s" })).toBe("just a literal command");
    });
});
