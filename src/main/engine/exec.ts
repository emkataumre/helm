// src/main/engine/exec.ts
import { spawn } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; }
export interface ExecOptions { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean; }
export type ExecFn = (command: string, args?: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const run: ExecFn = (command, args = [], opts = {}) =>
    new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            shell: opts.shell ?? false,
            windowsHide: true,
        });
        let stdout = "", stderr = "", timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
        }
        child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
        child.on("error", (err) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut }); });
    });

function killTree(pid?: number): void {
    if (!pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
