// src/main/ctl/server.ts
// The named-pipe JSON-RPC edge (untested glue — the pure dispatch lives in verbs.ts). One connection =
// one newline-terminated JSON request = one JSON response, then the server ends the socket. Per-
// connection belts everywhere: a malformed request, a handler throw, or a socket error must NEVER
// crash the app. EADDRINUSE (a second Helm instance on the same userData) fails LOUDLY and leaves ctl
// disabled in this instance — it never silently steals the pipe (spec §8).
import { createServer, type Server } from "node:net";
import { dispatchCtl, type CtlHandler } from "./verbs";
import type { CtlRequest } from "./protocol";

const MAX_REQUEST_BYTES = 64 * 1024; // a verb + args is tiny; anything bigger is garbage
const SOCKET_TIMEOUT_MS = 15_000;    // a client that never sends a newline gets dropped, not leaked

export function startCtlServer(pipeName: string, verbs: Record<string, CtlHandler>): { close: () => void } {
    const server: Server = createServer((sock) => {
        let buf = "";
        let replied = false;
        const reply = (resp: unknown): void => {
            if (replied) return;
            replied = true;
            try { sock.end(JSON.stringify(resp) + "\n"); } catch { /* client gone — nothing to do */ }
        };
        sock.setEncoding("utf8");
        sock.setTimeout(SOCKET_TIMEOUT_MS, () => sock.destroy());
        sock.on("error", () => { /* client vanished mid-request — harmless */ });
        sock.on("data", (chunk: string) => {
            buf += chunk;
            if (buf.length > MAX_REQUEST_BYTES) { reply({ ok: false, error: "request too large" }); return; }
            const nl = buf.indexOf("\n");
            if (nl < 0) return; // wait for the full line
            const line = buf.slice(0, nl);
            void (async () => {
                let raw: Partial<CtlRequest>;
                try { raw = JSON.parse(line) as Partial<CtlRequest>; }
                catch { reply({ ok: false, error: "malformed request (expected one JSON object per line)" }); return; }
                if (typeof raw?.verb !== "string") { reply({ ok: false, error: "malformed request: missing verb" }); return; }
                const req: CtlRequest = {
                    verb: raw.verb,
                    args: raw.args && typeof raw.args === "object" ? raw.args : {},
                    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
                };
                reply(await dispatchCtl(verbs, req));
            })();
        });
    });
    server.on("error", (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        console.error(
            `[helm] ctl pipe server failed (${code ?? err.message})` +
            (code === "EADDRINUSE" ? " — another Helm instance owns this pipe; ctl is DISABLED here (close the other instance and restart)" : ""),
        );
    });
    server.listen(pipeName);
    return { close: () => { try { server.close(); } catch { /* already down */ } } };
}
