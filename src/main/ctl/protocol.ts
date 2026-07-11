// src/main/ctl/protocol.ts
// The PURE half of the blessed CLI (M16, spec §3): pipe naming, the request/response wire shape, the
// CLI argv grammar, the PATH-shim contents, and the human-PTY env overlay. Everything here is
// Electron-free and side-effect-free so the verify slice + unit tests drive it headlessly; server.ts,
// cli.ts and ipc.ts are the thin impure edges. The standing rule the whole seam obeys: NEW TRANSPORT,
// ZERO NEW ENGINE CAPABILITY — every verb maps 1:1 onto existing handler logic (see verbs.ts).
import { createHash } from "node:crypto";

// One pipe per app INSTANCE: derived from the userData path — per-user by construction (userData lives
// under the user profile) AND distinct for a throwaway HELM_USER_DATA, so an accept-harness app never
// collides with a real Helm. A second instance on the SAME userData fails LOUDLY (EADDRINUSE in
// server.ts) — it never silently steals the pipe. Normalized (slashes + case) so the same dir always
// hashes the same regardless of how the path was spelled.
export function pipeNameFor(userDataPath: string): string {
    const hash = createHash("sha256").update(userDataPath.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\helm-ctl-${hash}`;
}

// The wire shape: one newline-terminated JSON request per connection → one JSON response. `cwd` is the
// client's working directory — the reads that scope to a project (status --project, plan status) can
// resolve the project from it when --project is absent (the conductor session runs at the repo root).
export interface CtlRequest {
    verb: string;
    args: Record<string, string>;
    cwd?: string;
}
export type CtlResponse = { ok: true; data: unknown } | { ok: false; error: string };

export const CLI_USAGE = `helm — control CLI for the running Helm app (reads + existing cockpit verbs only)

reads
  helm status [--project <name>]        board snapshot: tasks, statuses, waiting-on, cost
  helm task <id>                        one task's detail + failureReason + iteration summaries
  helm progress <id>                    the task's progress.md tail
  helm plan status [--project <name>]   plans + the live .helm/plan/ draft state
  helm failures [--project <name>] [--open] [--kind <k>] [--all]
                                        the durable failure ledger: by-kind counts + recent entries
                                        (--open = unresolved only; --all = every project)

steers (each maps onto an existing cockpit button — the CLI has no new authority)
  helm pause | helm resume              the global scheduler pause
  helm abandon <id>                     reap the task's worktree + mark abandoned (destructive — confirm first)
  helm clear-deps <id>                  clear a task's dependency edges (it may immediately unblock)

There is deliberately NO create-task verb: intake goes through the .helm/plan/ seam + the human ack gate.`;

// The CLI grammar → a wire request. A CLOSED grammar: unknown shapes get a usage error here (the server
// would reject the verb anyway — failing client-side just gives a better message).
export type ParsedCli =
    | { ok: true; request: { verb: string; args: Record<string, string> } }
    | { ok: false; error: string };

export function parseCliArgs(argv: string[]): ParsedCli {
    const [first, ...rest] = argv;
    if (!first || first === "--help" || first === "-h" || first === "help") return { ok: false, error: CLI_USAGE };
    const takeProject = (xs: string[]): Record<string, string> => {
        const i = xs.indexOf("--project");
        return i >= 0 && xs[i + 1] ? { project: xs[i + 1] } : {};
    };
    switch (first) {
        case "status":
            return { ok: true, request: { verb: "status", args: takeProject(rest) } };
        case "failures": {
            // Flags → string args (the wire's Record<string,string>); the verb registry re-types them.
            const args = takeProject(rest);
            if (rest.includes("--open")) args.open = "true";
            if (rest.includes("--all")) args.all = "true";
            const ki = rest.indexOf("--kind");
            if (ki >= 0 && rest[ki + 1]) args.kind = rest[ki + 1];
            return { ok: true, request: { verb: "failures", args } };
        }
        case "plan":
            if (rest[0] !== "status") return { ok: false, error: `unknown plan subcommand "${rest[0] ?? ""}" — try: helm plan status` };
            return { ok: true, request: { verb: "plan-status", args: takeProject(rest.slice(1)) } };
        case "pause":
        case "resume":
            return { ok: true, request: { verb: first, args: {} } };
        case "task":
        case "progress":
        case "abandon":
        case "clear-deps": {
            if (!rest[0]) return { ok: false, error: `helm ${first} <task-id> — the task id is required` };
            return { ok: true, request: { verb: first, args: { id: rest[0] } } };
        }
        default:
            return { ok: false, error: `unknown verb "${first}"\n\n${CLI_USAGE}` };
    }
}

// The PATH shims Helm writes under userData at boot. The shim dir is PATH-prepended into HUMAN PTYs
// only (buildCtlEnv), so `helm` resolves inside the conductor pane / free terminals and nowhere else.
// Both shims delegate to `node <cli.js>` (cmd.exe picks .cmd, pwsh picks either) forwarding argv and
// the exit code verbatim.
export function buildShims(cliJsPath: string): Array<{ name: string; content: string }> {
    return [
        { name: "helm.cmd", content: `@echo off\r\nnode "${cliJsPath}" %*\r\n` },
        { name: "helm.ps1", content: `& node "${cliJsPath}" @args\r\nexit $LASTEXITCODE\r\n` },
    ];
}

// The full env for a HUMAN PTY: base env + HELM_CTL_PIPE + the shim-dir PATH prepend. The existing PATH
// key is found case-insensitively (Windows env objects usually carry "Path") and overwritten IN PLACE —
// adding a second, differently-cased PATH key would leave which-one-wins to the OS. Returns a FRESH
// object; the base (process.env in prod) is NEVER mutated — agents inherit plain process.env at the
// spawn.ts chokepoint, so the pipe stays structurally invisible to them (spec §6).
export function buildCtlEnv(base: NodeJS.ProcessEnv, pipeName: string, shimDir: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v != null) env[k] = v;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
    env[pathKey] = env[pathKey] ? `${shimDir};${env[pathKey]}` : shimDir;
    env.HELM_CTL_PIPE = pipeName;
    return env;
}
