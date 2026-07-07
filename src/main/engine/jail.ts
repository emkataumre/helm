// src/main/engine/jail.ts
// The PURE jail planner — ALL Docker-jail assembly in one Electron-free, docker-free module (the verify
// slice drives this directly). buildJailPlan turns a per-task jail context + the per-iteration claude args
// into a structured plan: the full `docker run` argv, the env-file lines (the .ralph transport), the kill
// args, and the orphan-reap prefix. spawn.ts (Task 4) executes the plan; the ipc/runTask edge builds the
// JailSpec next to buildSpawnSettings, so spawn.ts stays decoupled from Project.
//
// LEAF MODULE — imports nothing from the engine graph. Every constant below is spike-pinned
// (scripts/jail-spike/FINDINGS.md): non-root `node` user, CLAUDE_CONFIG_DIR auth mount, base64 → env-file
// transport, no tty, `docker kill` semantics, `helm-jail-` name prefix.

// The deterministic-name prefix. The kill path and orphan reap address containers/volumes ONLY by this
// prefix (FINDINGS §4: my own random-named probes leaked; deterministic names are load-bearing for reap).
export const JAIL_NAME_PREFIX = "helm-jail-";
// The jail-owned auth volume (one-time human login persisted here — subscription billing, FINDINGS §2).
export const AUTH_VOLUME = "helm-claude-auth";

// In-container mount targets (FINDINGS §1b/§2/§3): the bare exchange (bind), the per-task clone volume,
// and the auth volume at the non-root user's CLAUDE_CONFIG_DIR.
const EXCHANGE_MOUNT = "/exchange";
const WORK_MOUNT = "/work";
const AUTH_MOUNT = "/home/node/.claude";

// The per-task jail context, built at the ipc/runTask edge (decoupled from Project). By construction it
// carries NO real-origin URL and NO host credential path — that's invariant #1 (origin-unreachable-in-jail),
// so origin knowledge is kept OUT of this type entirely.
export interface JailSpec {
    image: string;                 // project.jailImage (non-null ⇒ jail mode)
    taskId: string;                // → the deterministic container + volume names
    taskBranch: string;            // the task's branch in the exchange (e.g. ralph/task-<id>)
    exchangeHostPath: string;      // host path to the bare exchange repo (the ONLY bind-mount source)
    setupCommand: string | null;   // project.setupCommand — run once in-container on a fresh clone
    ralph: RalphFiles;             // the .ralph contents (base64'd into the env-file — untracked, can't ride git)
    envFilePath: string;           // where the edge writes the env-file before `docker run` (FINDINGS §5/§7)
    authVolume?: string;           // default AUTH_VOLUME; overridable for tests
}

export interface RalphFiles { instructions: string; task: string; progress: string }

// The per-iteration claude invocation pieces (spawn.ts already assembles these for host mode).
export interface JailClaudeArgs {
    prompt: string;
    sessionId: string;
    settings?: string;             // the M6-② never-push deny belt — rides into the jail for free (inline argv)
    model?: string;
    extraArgs?: string[];
}

// The structured plan. `argv`/`envFileLines`/`mounts` are what the invariants inspect; `killArgs`/`reapPrefix`
// are the abandon-reap contract (FINDINGS §4). By construction: exactly three mounts, no tty, no origin.
export interface JailPlan {
    argv: string[];                // full docker argv: `run --rm --name … -v … --env-file … <image> claude …`
    mounts: string[];              // the `-v` mount specs (source:target[:mode]) — for exchange-only-mount
    envFileLines: string[];        // the HELM_* lines the edge writes to envFilePath
    envFilePath: string;
    containerName: string;         // helm-jail-task-<id>
    volumeName: string;            // helm-jail-task-<id> (same stem — one per task)
    killArgs: string[];            // ["kill", containerName] — the abort path (docker kill, NOT killTree)
    reapPrefix: string;            // JAIL_NAME_PREFIX — the census filter for orphan reap
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

export const containerNameFor = (taskId: string): string => `${JAIL_NAME_PREFIX}task-${taskId}`;

export function buildJailPlan(spec: JailSpec, claude: JailClaudeArgs): JailPlan {
    const containerName = containerNameFor(spec.taskId);
    const volumeName = containerName; // one per-task volume, same stem as the container
    const authVolume = spec.authVolume ?? AUTH_VOLUME;

    // Mounts — EXACTLY three (invariant exchange-only-mount): the bare exchange (bind, read+write for the
    // push-back), the per-task clone volume, and the auth volume. NO worktree bind-mount, NO origin, NO
    // host credential path. The bare exchange holds ONLY the task branch — never the real remote.
    const mounts = [
        `${spec.exchangeHostPath}:${EXCHANGE_MOUNT}`,
        `${volumeName}:${WORK_MOUNT}`,
        `${authVolume}:${AUTH_MOUNT}`,
    ];

    // The .ralph directive files ride as base64 in an --env-file (FINDINGS §5/§7 — untracked so they can't
    // ride the exchange; newlines so they can't be raw env values; env-file keeps the big blobs off the
    // ~32k command line). The entry decodes them write-if-absent into the container's clone.
    const envFileLines = [
        `HELM_TASK_BRANCH=${spec.taskBranch}`,
        ...(spec.setupCommand ? [`HELM_SETUP_CMD=${spec.setupCommand}`] : []),
        `HELM_RALPH_INSTRUCTIONS_B64=${b64(spec.ralph.instructions)}`,
        `HELM_RALPH_TASK_B64=${b64(spec.ralph.task)}`,
        `HELM_RALPH_PROGRESS_B64=${b64(spec.ralph.progress)}`,
    ];

    // The in-container claude invocation. Jail mode replaces `--permission-mode auto` with
    // `--dangerously-skip-permissions` (the whole point — full-permission iterations behind the container
    // wall); stream-json + session-id + the deny-belt settings are unchanged. These args trail the image, so
    // the baked ENTRYPOINT (helm-entry.sh) receives them as "$@" and wraps them (clone/seed → run → push).
    const claudeArgv = [
        "claude", "-p", claude.prompt,
        "--output-format", "stream-json", "--verbose",
        "--session-id", claude.sessionId,
        "--dangerously-skip-permissions",
        ...(claude.settings ? ["--settings", claude.settings] : []),
        ...(claude.model ? ["--model", claude.model] : []),
        ...(claude.extraArgs ?? []),
    ];

    // NO `-t`/tty (FINDINGS §6: a tty ANSI-mangles the stream-json). `--rm` auto-reaps on `docker kill`.
    const argv = [
        "run", "--rm", "--name", containerName,
        ...mounts.flatMap((m) => ["-v", m]),
        "--env-file", spec.envFilePath,
        spec.image,
        ...claudeArgv,
    ];

    return {
        argv, mounts, envFileLines, envFilePath: spec.envFilePath,
        containerName, volumeName,
        killArgs: ["kill", containerName],
        reapPrefix: JAIL_NAME_PREFIX,
    };
}

// The set of bind/volume sources a jail plan is ALLOWED to mount (invariant exchange-only-mount). A plan
// whose mounts aren't a subset of {exchange, per-task volume, auth volume} is a wall breach. Exported so
// the verify slice reads one source of truth.
export function allowedMountTargets(): string[] {
    return [EXCHANGE_MOUNT, WORK_MOUNT, AUTH_MOUNT];
}
