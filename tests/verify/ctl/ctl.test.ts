// tests/verify/ctl/ctl.test.ts
// The M16 verify slice's CI matrix (spec §7). The positive fixture drives the REAL ctl kernel —
// buildCtlVerbs/dispatchCtl over recording actions, the real spawnAgent with a recording exec (no
// claude ever runs), buildCtlEnv over a captured base, and the real conductor resume-guard — and
// distils a recording; probes are hand-crafted broken recordings (negative controls). Asserts the
// four invariants — ctl-verbs-are-blessed, ctl-absent-in-agent-spawns, mutations-route-through-mutex,
// conductor-resume-respects-guard — each with a probe that MUST FAIL. Vocabulary from
// ~/.claude/verification.md. The live pipe is covered by tests/accept/ctl.accept.ts; the real
// conductor conversation (skill + gh + a live session) stays manual acceptance.
import { describe, it, expect } from "vitest";
import { runCtlFixture, runAll, type Verdict } from "./runner";
import { CTL_INVARIANTS, runCtlInvariants } from "./invariants";
import { CTL_FIXTURES } from "./fixtures";
import { runCtlScenario, BASELINE, type CtlRecording } from "./surface";
import { parseCliArgs, pipeNameFor, buildShims, buildCtlEnv } from "../../../src/main/ctl/protocol";
import { claudeSessionFile } from "../../../src/main/engine/conductor";

const failed = (r: CtlRecording) => runCtlInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/ctl: the CI matrix over every fixture", () => {
    it.each(CTL_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runCtlFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(CTL_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("has a probe for EVERY declared invariant (each must be catchable)", () => {
        const covered = new Set(CTL_FIXTURES.filter((f) => f.probe).map((f) => (f as { mustFail: string }).mustFail));
        expect([...covered].sort()).toEqual(CTL_INVARIANTS.map((i) => i.name).sort());
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(CTL_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/ctl: the recording is the real kernel's behaviour", () => {
    it("the real kernel run satisfies all four invariants", async () => {
        expect(failed(await runCtlScenario())).toEqual([]);
    });

    it("the real registry is exactly the blessed set — and rejects an intake verb structurally", async () => {
        const rec = await runCtlScenario();
        expect(rec.registeredVerbs.sort()).toEqual([...rec.blessedVerbs].sort());
        expect(rec.unknownVerbRejected).toBe(true);
    });

    it("the real spawn chokepoint hands exec NO env override (agents inherit plain process.env)", async () => {
        expect((await runCtlScenario()).agentEnvKeys).toBeNull();
    });

    it("the real env builder scopes the pipe to the PTY overlay without touching its base", async () => {
        const rec = await runCtlScenario();
        expect(rec.baseEnvMutated).toBe(false);
        expect(rec.ptyEnvHasPipe).toBe(true);
        expect(rec.ptyPathPrepended).toBe(true);
    });

    it("every steer verb fires exactly its shared (button-path) action", async () => {
        const rec = await runCtlScenario();
        expect(rec.steerCalls).toHaveLength(4);
        expect(rec.steerCalls.every((c) => c.sharedActionInvoked)).toBe(true);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        expect(runCtlInvariants(await runCtlScenario()).map((r) => r.name).sort())
            .toEqual(CTL_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/ctl: negative controls — each broken recording FAILS its named invariant", () => {
    it("a registered createTask verb FAILS ctl-verbs-are-blessed", () => {
        expect(failed({ ...BASELINE, registeredVerbs: [...BASELINE.registeredVerbs, "createTask"] })).toContain("ctl-verbs-are-blessed");
    });
    it("a blessed set that ITSELF sneaks in an intake verb FAILS ctl-verbs-are-blessed", () => {
        expect(failed({ ...BASELINE, blessedVerbs: [...BASELINE.blessedVerbs, "create-task"], registeredVerbs: [...BASELINE.registeredVerbs, "create-task"] }))
            .toContain("ctl-verbs-are-blessed");
    });
    it("an agent env carrying HELM_CTL_PIPE FAILS ctl-absent-in-agent-spawns", () => {
        expect(failed({ ...BASELINE, agentEnvKeys: ["PATH", "HELM_CTL_PIPE"] })).toContain("ctl-absent-in-agent-spawns");
    });
    it("a missing human-PTY overlay FAILS ctl-absent-in-agent-spawns (the separation must EXIST)", () => {
        expect(failed({ ...BASELINE, ptyEnvHasPipe: false })).toContain("ctl-absent-in-agent-spawns");
    });
    it("a steer verb bypassing its shared action FAILS mutations-route-through-mutex", () => {
        expect(failed({
            ...BASELINE,
            steerCalls: BASELINE.steerCalls.map((c) => (c.verb === "abandon" ? { ...c, sharedActionInvoked: false } : c)),
        })).toContain("mutations-route-through-mutex");
    });
    it("--resume for a null-session project FAILS conductor-resume-respects-guard", () => {
        expect(failed({
            ...BASELINE,
            conductorCases: [{ recorded: null, persisted: false, argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume ghost"] }],
        })).toContain("conductor-resume-respects-guard");
    });
    it("a resumable case MISSING --resume FAILS conductor-resume-respects-guard", () => {
        expect(failed({
            ...BASELINE,
            conductorCases: [{ recorded: "sess-live", persisted: true, argv: ["pwsh.exe", "-NoExit", "-Command", "claude"] }],
        })).toContain("conductor-resume-respects-guard");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as CtlRecording; // property access throws inside predicates
        const results = runCtlInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});

describe("verify/ctl: the pure protocol pieces (grammar, pipe name, shims, env)", () => {
    it("the CLI grammar folds `plan status` to plan-status and demands ids where required", () => {
        expect(parseCliArgs(["status"])).toEqual({ ok: true, request: { verb: "status", args: {} } });
        expect(parseCliArgs(["status", "--project", "helm"])).toEqual({ ok: true, request: { verb: "status", args: { project: "helm" } } });
        expect(parseCliArgs(["plan", "status"])).toEqual({ ok: true, request: { verb: "plan-status", args: {} } });
        expect(parseCliArgs(["abandon", "t-9"])).toEqual({ ok: true, request: { verb: "abandon", args: { id: "t-9" } } });
        expect(parseCliArgs(["abandon"]).ok).toBe(false);       // id required
        expect(parseCliArgs(["create-task"]).ok).toBe(false);   // not in the grammar at all
        expect(parseCliArgs([]).ok).toBe(false);                // bare `helm` → usage
    });

    it("pipeNameFor is deterministic and normalizes slashes + case (same dir → same pipe)", () => {
        const a = pipeNameFor("C:\\Users\\x\\AppData\\Roaming\\helm");
        expect(a).toBe(pipeNameFor("c:/users/x/appdata/roaming/helm"));
        expect(a).toMatch(/^\\\\\.\\pipe\\helm-ctl-[0-9a-f]{16}$/);
        expect(pipeNameFor("C:\\other")).not.toBe(a); // a throwaway HELM_USER_DATA gets its own pipe
    });

    it("buildShims emits helm.cmd + helm.ps1, both delegating to node <cli.js> with args forwarded", () => {
        const shims = buildShims("C:\\app\\out\\main\\cli.js");
        expect(shims.map((s) => s.name).sort()).toEqual(["helm.cmd", "helm.ps1"]);
        for (const s of shims) expect(s.content).toContain('"C:\\app\\out\\main\\cli.js"');
        expect(shims.find((s) => s.name === "helm.cmd")!.content).toContain("%*");
        expect(shims.find((s) => s.name === "helm.ps1")!.content).toContain("@args");
    });

    it("buildCtlEnv prepends PATH case-insensitively in place (no duplicate PATH key)", () => {
        const env = buildCtlEnv({ PATH: "/usr/bin" }, "\\\\.\\pipe\\p", "/ud/ctl");
        expect(env.PATH).toBe("/ud/ctl;/usr/bin");
        expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toHaveLength(1);
        const winEnv = buildCtlEnv({ Path: "C:\\Windows" }, "\\\\.\\pipe\\p", "C:\\ud\\ctl");
        expect(winEnv.Path).toBe("C:\\ud\\ctl;C:\\Windows");
        expect("PATH" in winEnv).toBe(false);
    });

    it("claudeSessionFile munges the repo path the way claude does (I:\\Personal\\helm → I--Personal-helm)", () => {
        const p = claudeSessionFile("C:\\Users\\x", "I:\\Personal\\helm", "abc");
        expect(p.replace(/\\/g, "/")).toBe("C:/Users/x/.claude/projects/I--Personal-helm/abc.jsonl");
    });
});
