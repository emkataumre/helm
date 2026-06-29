// src/main/engine/terminalLaunch.ts
// The drop-in terminal launch (spec §8). A configurable terminal is opened in the task's worktree,
// resuming the latest claude session — Windows default
// `wt.exe -d "{worktree}" pwsh -NoExit -Command "claude --resume <id>"`.
//
// Split into a PURE, unit-tested command builder + a thin detached launcher (the untested Electron
// edge, exactly like M3's Notification). NOT routed through spawn.ts — that's the agent/Docker-jail
// chokepoint; this is a human-facing terminal. `detached + unref` so quitting Helm never kills it.
import { spawn } from "node:child_process";

// NULL terminalCommand on a project → this default; projects with a custom terminalCommand are unaffected.
// {worktree} is quoted because real worktree paths contain spaces (the M4 path-with-spaces lesson);
// {resume} is empty for Start-fresh / the no-session case.
//
// Why `pwsh -NoExit -Command "claude {resume}"` and not bare `claude {resume}`: an iteration killed before
// claude persisted a resumable session makes `claude --resume <id>` fail with "No conversation found". With
// bare claude as the tab's program, that failure CLOSED the tab (work lost from view). -NoExit keeps the
// pwsh pane alive in the worktree after claude exits/fails, so the user just lands at a shell and can run
// `claude` fresh. We deliberately do NOT auto-relaunch on failure (`; if ($LASTEXITCODE) { claude }`): wt's
// own `;` is a sub-command delimiter (the cmd→wt→pwsh nesting mangles the conditional), and a blanket
// relaunch would also fire on an intentional Ctrl-C — a predictable live shell is the more robust contract.
export const DEFAULT_TERMINAL_COMMAND = 'wt.exe -d "{worktree}" pwsh -NoExit -Command "claude {resume}"';

export interface TerminalVars {
    worktree: string; // the path to launch the terminal in
    resume: string;   // already-formed: `--resume <id>` normally, or "" (Start fresh / no captured session)
}

// Substitute EVERY occurrence of {worktree} and {resume}, leaving the rest of the template intact.
export function buildTerminalCommand(template: string, vars: TerminalVars): string {
    return template.split("{worktree}").join(vars.worktree).split("{resume}").join(vars.resume);
}

export interface LaunchResult { ok: boolean; error?: string }

// Fire the terminal as a detached, unref'd child so it outlives Helm. Any spawn failure is caught and
// returned as a structured error (the ipc layer logs it + surfaces a cockpit-visible message) — it must
// NEVER crash the drop-in handler. There is no auto-fallback chain: if `wt` is absent, edit the template.
export function launchTerminal(template: string, vars: TerminalVars): LaunchResult {
    const command = buildTerminalCommand(template, vars);
    try {
        const child = spawn(command, { shell: true, detached: true, stdio: "ignore", windowsHide: false });
        child.on("error", (e) => console.error(`[helm] terminal launch failed: ${e.message}`)); // async failure (best-effort)
        child.unref();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
