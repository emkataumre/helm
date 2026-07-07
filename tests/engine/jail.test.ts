// tests/engine/jail.test.ts — the pure jail planner (M13 Task 3). Unit-tests buildJailPlan's arg-building
// against the spike-pinned contracts (scripts/jail-spike/FINDINGS.md): exactly-three mounts, non-root auth
// mount, base64→env-file transport, --dangerously-skip-permissions (NOT --permission-mode auto), no tty,
// docker-kill semantics, helm-jail- reap prefix, and — load-bearing — no origin URL/credential anywhere.
import { buildJailPlan, containerNameFor, allowedMountTargets, JAIL_NAME_PREFIX, AUTH_VOLUME, type JailSpec, type JailClaudeArgs } from "../../src/main/engine/jail";

const spec = (over: Partial<JailSpec> = {}): JailSpec => ({
    image: "helm-jail:latest",
    taskId: "t1",
    taskBranch: "ralph/task-t1",
    exchangeHostPath: "C:/Temp/helm-target/.helm/jail-exchange/t1.git",
    setupCommand: null,
    ralph: { instructions: "# ritual\n", task: "# task\nDo it.\n", progress: "# progress\n" },
    envFilePath: "C:/Temp/helm-jail-t1.env",
    ...over,
});
const claude = (over: Partial<JailClaudeArgs> = {}): JailClaudeArgs => ({
    prompt: "/goal make it green\n\nRead .ralph/TASK.md.",
    sessionId: "sess-abc",
    ...over,
});
const decode = (line: string): string => Buffer.from(line.split("=").slice(1).join("="), "base64").toString("utf8");

describe("buildJailPlan", () => {
    it("mounts EXACTLY the exchange, the per-task volume, and the auth volume — nothing else", () => {
        const p = buildJailPlan(spec(), claude());
        expect(p.mounts).toEqual([
            "C:/Temp/helm-target/.helm/jail-exchange/t1.git:/exchange",
            "helm-jail-task-t1:/work",
            `${AUTH_VOLUME}:/home/node/.claude`,
        ]);
        // every mount TARGET is in the allow-list (exchange-only-mount)
        const targets = p.mounts.map((m) => m.split(":").slice(-1)[0]);
        for (const t of targets) expect(allowedMountTargets()).toContain(t);
    });

    it("uses deterministic container + volume names off the taskId", () => {
        const p = buildJailPlan(spec({ taskId: "abc" }), claude());
        expect(p.containerName).toBe("helm-jail-task-abc");
        expect(p.volumeName).toBe("helm-jail-task-abc");
        expect(containerNameFor("abc")).toBe("helm-jail-task-abc");
    });

    it("builds the docker argv: run --rm --name, the three -v mounts, --env-file, image, then the claude args", () => {
        const p = buildJailPlan(spec(), claude());
        expect(p.argv.slice(0, 4)).toEqual(["run", "--rm", "--name", "helm-jail-task-t1"]);
        expect(p.argv).toContain("--env-file");
        expect(p.argv[p.argv.indexOf("--env-file") + 1]).toBe("C:/Temp/helm-jail-t1.env");
        // the image precedes the claude invocation
        const imgIdx = p.argv.indexOf("helm-jail:latest");
        expect(imgIdx).toBeGreaterThan(0);
        expect(p.argv[imgIdx + 1]).toBe("claude");
        expect(p.argv.filter((a) => a === "-v")).toHaveLength(3); // exactly three mounts on the command line
    });

    it("NEVER allocates a tty (-t/-it would ANSI-mangle the stream-json)", () => {
        const p = buildJailPlan(spec(), claude());
        expect(p.argv).not.toContain("-t");
        expect(p.argv).not.toContain("-it");
        expect(p.argv).not.toContain("--tty");
    });

    it("jail claude args carry --dangerously-skip-permissions, session-id, stream-json — and NOT --permission-mode auto", () => {
        const p = buildJailPlan(spec(), claude());
        expect(p.argv).toContain("--dangerously-skip-permissions");
        expect(p.argv).not.toContain("--permission-mode"); // the host-mode flag is replaced, never both
        expect(p.argv).toContain("--session-id");
        expect(p.argv[p.argv.indexOf("--session-id") + 1]).toBe("sess-abc");
        expect(p.argv.join(" ")).toContain("--output-format stream-json --verbose");
    });

    it("threads --settings (the deny belt) and --model only when provided", () => {
        const withBoth = buildJailPlan(spec(), claude({ settings: '{"permissions":{"deny":["Bash(git push:*)"]}}', model: "opus" }));
        expect(withBoth.argv[withBoth.argv.indexOf("--settings") + 1]).toContain("git push");
        expect(withBoth.argv[withBoth.argv.indexOf("--model") + 1]).toBe("opus");
        const without = buildJailPlan(spec(), claude());
        expect(without.argv).not.toContain("--settings");
        expect(without.argv).not.toContain("--model");
    });

    it("carries the .ralph files as base64 env-file lines (decodable), + branch, + setup only when set", () => {
        const p = buildJailPlan(spec({ setupCommand: "npm ci" }), claude());
        expect(p.envFileLines).toContain("HELM_TASK_BRANCH=ralph/task-t1");
        expect(p.envFileLines).toContain("HELM_SETUP_CMD=npm ci");
        const task = p.envFileLines.find((l) => l.startsWith("HELM_RALPH_TASK_B64="))!;
        expect(decode(task)).toBe("# task\nDo it.\n"); // round-trips byte-for-byte
        const instr = p.envFileLines.find((l) => l.startsWith("HELM_RALPH_INSTRUCTIONS_B64="))!;
        expect(decode(instr)).toBe("# ritual\n");
        // no setup command → no HELM_SETUP_CMD line
        const noSetup = buildJailPlan(spec({ setupCommand: null }), claude());
        expect(noSetup.envFileLines.some((l) => l.startsWith("HELM_SETUP_CMD="))).toBe(false);
    });

    it("kill args are `docker kill <name>` and the reap prefix is the helm-jail- stem (the abandon-reap contract)", () => {
        const p = buildJailPlan(spec(), claude());
        expect(p.killArgs).toEqual(["kill", "helm-jail-task-t1"]);
        expect(p.reapPrefix).toBe(JAIL_NAME_PREFIX);
        expect(p.reapPrefix).toBe("helm-jail-");
    });

    // Invariant #1 (origin-unreachable-in-jail), at the unit level: the assembled plan carries NO real-origin
    // URL and NO host credential path anywhere — not in argv, not in mounts, not in the env-file lines.
    it("carries no origin URL and no host credential path anywhere in the plan", () => {
        const p = buildJailPlan(spec(), claude({ settings: '{"permissions":{"deny":["Bash(git push:*)"]}}' }));
        const haystack = [...p.argv, ...p.mounts, ...p.envFileLines].join("\n");
        expect(haystack).not.toMatch(/https?:\/\//);        // no remote URL
        expect(haystack).not.toMatch(/git@|ssh:\/\//);       // no ssh remote
        expect(haystack).not.toMatch(/\.git-credentials|_netrc|\.netrc/); // no cred file path
        expect(haystack.toLowerCase()).not.toContain("origin"); // no `origin` remote leaked into the jail
    });
});
