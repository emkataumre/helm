// src/main/engine/exec.ts
import { spawn } from "node:child_process";

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean; idleTimedOut?: boolean; }
export interface ExecOptions { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean; idleTimeoutMs?: number; onLine?: (line: string) => void; }
export type ExecFn = (command: string, args?: string[], opts?: ExecOptions) => Promise<ExecResult>;

export const run: ExecFn = (command, args = [], opts = {}) =>
    new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            shell: opts.shell ?? false,
            windowsHide: true,
        });
        let stdout = "", stderr = "", timedOut = false, idleTimedOut = false, buffer = "";
        let timer: NodeJS.Timeout | undefined;
        let idleTimer: NodeJS.Timeout | undefined;

        const resetIdle = () => {
            if (!opts.idleTimeoutMs || opts.idleTimeoutMs <= 0) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { idleTimedOut = true; killTree(child.pid); }, opts.idleTimeoutMs);
        };
        const onData = (isErr: boolean) => (d: Buffer) => {
            const s = d.toString();
            if (isErr) stderr += s; else stdout += s;
            resetIdle();
            if (opts.onLine) {
                buffer += s;
                let nl: number;
                while ((nl = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, nl).replace(/\r$/, "");
                    buffer = buffer.slice(nl + 1);
                    if (line.length) opts.onLine(line);
                }
            }
        };
        child.stdout?.on("data", onData(false));
        child.stderr?.on("data", onData(true));
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);
        }
        resetIdle();

        const finish = (code: number) => {
            if (timer) clearTimeout(timer);
            if (idleTimer) clearTimeout(idleTimer);
            if (opts.onLine && buffer.trim().length) opts.onLine(buffer.replace(/\r$/, ""));
            resolve({ code, stdout, stderr, timedOut, idleTimedOut });
        };
        child.on("close", (code) => finish(code ?? -1));
        child.on("error", (err) => { stderr += String(err); finish(-1); });
    });

function killTree(pid?: number): void {
    if (!pid) return;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
}
