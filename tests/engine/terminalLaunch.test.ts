// tests/engine/terminalLaunch.test.ts
// The drop-in terminal launch. Only the PURE command-builders are unit-tested; launchTerminal itself is
// the untested Electron edge (a thin detached spawn), exactly like M3's Notification. M7 adds
// buildDropinArgv — the in-app-tab sibling of buildTerminalCommand (the same resilient-shell contract,
// expressed as argv for node-pty instead of a shell string for wt.exe).
import { describe, it, expect } from "vitest";
import { buildTerminalCommand, buildDropinArgv, DEFAULT_TERMINAL_COMMAND } from "../../src/main/engine/terminalLaunch";

describe("buildTerminalCommand (pure)", () => {
    it("substitutes the (quoted) worktree and a resume flag with the default template", () => {
        const cmd = buildTerminalCommand(DEFAULT_TERMINAL_COMMAND, { worktree: "C:/Temp/wt path", resume: "--resume abc-123" });
        expect(cmd).toContain('"C:/Temp/wt path"'); // worktree stays quoted (the path-with-spaces lesson)
        expect(cmd).toContain("--resume abc-123");
        expect(cmd).toBe('wt.exe -d "C:/Temp/wt path" pwsh -NoExit -Command "claude --resume abc-123"');
    });

    it("wraps claude in pwsh -NoExit so a failed --resume lands at a live shell, not a closed tab", () => {
        // The bug this fixes: an iteration killed before claude persisted a resumable session makes
        // `claude --resume <id>` fail ("No conversation found"); with the old bare-claude default the tab
        // then closed. -NoExit keeps the pwsh pane open in the worktree so the user can just run `claude`.
        const cmd = buildTerminalCommand(DEFAULT_TERMINAL_COMMAND, { worktree: "/wt", resume: "--resume dead-session" });
        expect(cmd).toContain("pwsh -NoExit");
    });

    it("leaves NO dangling --resume when resume is empty (Start fresh / no captured session)", () => {
        const cmd = buildTerminalCommand(DEFAULT_TERMINAL_COMMAND, { worktree: "/wt", resume: "" });
        expect(cmd).not.toContain("--resume");
        expect(cmd).toContain("pwsh -NoExit");
        expect(cmd).toBe('wt.exe -d "/wt" pwsh -NoExit -Command "claude "');
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

describe("buildDropinArgv (pure) — the in-app-tab argv for node-pty", () => {
    it("resumes the latest session: pwsh -NoExit -Command 'claude --resume <id>'", () => {
        expect(buildDropinArgv("abc-123")).toEqual(["pwsh.exe", "-NoExit", "-Command", "claude --resume abc-123"]);
    });

    it("null session (Start fresh / not-yet-resumable): bare 'claude', no dangling --resume", () => {
        const argv = buildDropinArgv(null);
        expect(argv).toEqual(["pwsh.exe", "-NoExit", "-Command", "claude"]);
        expect(argv.join(" ")).not.toContain("--resume");
    });

    it("keeps the resilient-shell contract: -NoExit so a failed --resume lands at a live worktree shell", () => {
        // Same fix as M5's external template: if `claude --resume <id>` fails ("No conversation found"),
        // -NoExit keeps the pwsh pane alive in the worktree so the user just runs `claude` fresh — the
        // in-app tab never dies on a resume miss.
        expect(buildDropinArgv("dead")).toContain("-NoExit");
        expect(buildDropinArgv(null)).toContain("-NoExit");
    });

    it("argv[0] is the program and the rest are discrete args (the PtyFactory shape — no shell parsing)", () => {
        const argv = buildDropinArgv("s1");
        expect(argv[0]).toBe("pwsh.exe");
        // the claude invocation is ONE -Command string (pwsh parses it), not pre-split into tokens
        expect(argv.slice(1)).toEqual(["-NoExit", "-Command", "claude --resume s1"]);
    });
});
