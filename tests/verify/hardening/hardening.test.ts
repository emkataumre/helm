// tests/verify/hardening/hardening.test.ts
// The M6-② verify slice's CI matrix. Positive fixtures drive the REAL buildSpawnSettings + the REAL
// spawnAgent chokepoint and distil a HardeningRecording; probes are hand-crafted broken recordings
// (negative controls). Asserts the two M6-② invariants — agent-push-denied, settings-injected — each
// with a probe that MUST FAIL. Vocabulary from ~/.claude/verification.md. Complementary to, and separate
// from, the untouched M2/M3/M4/M5 slices.
import { describe, it, expect } from "vitest";
import { runHardeningFixture, runAll, type Verdict } from "./runner";
import { HARDENING_INVARIANTS, runHardeningInvariants } from "./invariants";
import { HARDENING_FIXTURES } from "./fixtures";
import { runHardeningScenario, mkProject, type HardeningRecording } from "./surface";

const failed = (r: HardeningRecording) => runHardeningInvariants(r).filter((c) => !c.ok).map((c) => c.name);

describe("verify/hardening: the CI matrix over every fixture", () => {
    it.each(HARDENING_FIXTURES.map((f) => [f.id, f] as const))("fixture %s → PASS (observed and right)", async (_id, fixture) => {
        expect<Verdict>((await runHardeningFixture(fixture)).verdict).toBe("PASS");
    });

    it("declares at least one probe (no all-happy-path replay)", () => {
        expect(HARDENING_FIXTURES.some((f) => f.probe)).toBe(true);
    });

    it("runAll reports a verdict for every fixture, all PASS, none BLOCKED", async () => {
        const results = await runAll();
        expect(results).toHaveLength(HARDENING_FIXTURES.length);
        expect(results.every((r) => r.verdict === "PASS")).toBe(true);
        expect(results.some((r) => r.verdict === "BLOCKED")).toBe(false);
    });
});

describe("verify/hardening: the recording is the real units' behaviour", () => {
    it("the default project carries the never-push deny AND injects it at the chokepoint", async () => {
        const rec = await runHardeningScenario(mkProject(null));
        expect(rec.deny).toContain("Bash(git push:*)");
        expect(rec.injectedSettingsArg).toBe(rec.settingsJson); // reached claude unmangled
        expect(failed(rec)).toEqual([]);
    });

    it("a project with a custom trusted-environment still carries + injects the deny", async () => {
        const rec = await runHardeningScenario(mkProject("**Trusted cloud buckets**: s3://acme-private"));
        expect(rec.deny.some((d) => /git push/.test(d))).toBe(true);
        expect(rec.injectedSettingsArg).toBe(rec.settingsJson);
        expect(failed(rec)).toEqual([]);
    });

    it("the evaluated invariant set equals the declared set", async () => {
        const rec = await runHardeningScenario(mkProject(null));
        expect(runHardeningInvariants(rec).map((r) => r.name).sort()).toEqual(HARDENING_INVARIANTS.map((i) => i.name).sort());
    });
});

describe("verify/hardening: negative controls — each broken recording FAILS its named invariant", () => {
    const base: HardeningRecording = {
        unit: "hardening",
        deny: ["Bash(git push:*)", "Bash(git remote set-url:*)"],
        settingsJson: '{"permissions":{"deny":["Bash(git push:*)"]}}',
        injectedSettingsArg: '{"permissions":{"deny":["Bash(git push:*)"]}}',
    };

    it("settings with no git-push deny FAILS agent-push-denied", () => {
        expect(failed({ ...base, deny: ["Bash(rm:*)"] })).toContain("agent-push-denied");
    });
    it("a dropped --settings (never injected) FAILS settings-injected", () => {
        expect(failed({ ...base, injectedSettingsArg: null })).toContain("settings-injected");
    });
    it("a mangled --settings (injected but altered) FAILS settings-injected", () => {
        expect(failed({ ...base, injectedSettingsArg: '{"permissions":{"deny":[]}}' })).toContain("settings-injected");
    });

    it("a verifier that throws becomes a FAIL, never a silent pass", () => {
        const garbage = null as unknown as HardeningRecording; // property access throws inside predicates
        const results = runHardeningInvariants(garbage);
        expect(results.every((r) => typeof r.ok === "boolean")).toBe(true);
        expect(results.some((r) => !r.ok)).toBe(true);
    });
});
