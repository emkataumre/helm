// tests/verify/preflight/approve.test.ts
// The CI matrix for the overhauled approve decision (2026-07-14): REAL runPreflight → REAL store → REAL
// validateApproval per scenario, all four invariants over every recording, plus one deliberately-forged
// probe per invariant that must FAIL (an all-✅ checklist is just a happy-path replay).
import { describe, expect, it } from "vitest";
import { runApproveScenario, runApproveInvariants, APPROVE_INVARIANTS, type ApproveRecording, type ApproveScenario } from "./approve";
import type { CmdSpec } from "./surface";

const red = (command: string): CmdSpec => ({ command, code: 1, output: "1 failing", staticLevel: "ok" });
const green = (command: string, ack = false): CmdSpec => ({ command, code: 0, output: "all green", staticLevel: "ok", ack });
const missing = (command: string, ack = false): CmdSpec => ({ command, code: 1, output: "npm error Missing script", staticLevel: "warn", ack });

const expectAllHold = (r: ApproveRecording) => {
    for (const res of runApproveInvariants(r)) expect(res, `${res.name}: ${res.detail ?? ""}`).toMatchObject({ ok: true });
};
const invariant = (name: string) => APPROVE_INVARIANTS.find((i) => i.name === name)!;

describe("approve decision scenarios (invariants hold)", () => {
    const CASES: Array<[string, ApproveScenario, { approved: boolean; stale?: boolean }]> = [
        ["all-red draft, matching run → approved", { commands: [red("npm run verify:a")], runIdSent: "match" }, { approved: true }],
        ["warns all acked, matching run → approved", { commands: [red("npm run verify:a"), green("npm run check", true), missing("npm run verify:nope", true)], runIdSent: "match" }, { approved: true }],
        ["unacked warns → refused, NOT stale", { commands: [green("npm run check")], runIdSent: "match" }, { approved: false, stale: false }],
        ["superseded runId → stale", { commands: [red("npm run verify:a")], runIdSent: "superseded" }, { approved: false, stale: true }],
        ["no runId sent → stale", { commands: [red("npm run verify:a")], runIdSent: "none" }, { approved: false, stale: true }],
        ["draft edited on disk since the run → stale", { commands: [red("npm run verify:a")], runIdSent: "match", draftChangedOnDisk: true }, { approved: false, stale: true }],
        ["no stored run (restart) → stale", { commands: [red("npm run verify:a")], runIdSent: "match", noStoredRun: true }, { approved: false, stale: true }],
    ];
    for (const [name, scenario, want] of CASES) {
        it(name, async () => {
            const r = await runApproveScenario(scenario);
            expect(r.approved).toBe(want.approved);
            if (want.stale !== undefined) expect(r.stale).toBe(want.stale);
            expectAllHold(r);
        });
    }

    it("double-Confirm: the consumed run makes the second approval fail stale (never a double-insert)", async () => {
        const r = await runApproveScenario({ commands: [red("npm run verify:a")], runIdSent: "match", doubleConfirm: true });
        expect(r.approved).toBe(true);
        expect(r.secondApproved).toBe(false);
        expect(r.secondStale).toBe(true);
        expectAllHold(r);
    });
});

describe("probes — forged recordings each invariant must catch (must FAIL)", () => {
    const base = (): Promise<ApproveRecording> => runApproveScenario({ commands: [red("npm run verify:a")], runIdSent: "match" });

    it("🔍 an op recorded during the decision → approve-never-executes-commands FAILS", async () => {
        const r = { ...(await base()), ops: ["run:npm run check"] };
        expect(invariant("approve-never-executes-commands").holds(r)).not.toBe(true);
    });
    it("🔍 an async decision → approve-never-executes-commands FAILS", async () => {
        const r = { ...(await base()), decisionSync: false };
        expect(invariant("approve-never-executes-commands").holds(r)).not.toBe(true);
    });
    it("🔍 approved with a mismatched draft hash → stale-run-rejected FAILS", async () => {
        const r = { ...(await base()), hashMatched: false, approved: true };
        expect(invariant("stale-run-rejected").holds(r)).not.toBe(true);
    });
    it("🔍 a stale rejection without stale=true → stale-run-rejected FAILS", async () => {
        const r = { ...(await base()), hadRun: false, approved: false, stale: false };
        expect(invariant("stale-run-rejected").holds(r)).not.toBe(true);
    });
    it("🔍 approved past an unacked warn → approve-requires-acks FAILS", async () => {
        const r = { ...(await base()), declaredUnacked: 2, approved: true };
        expect(invariant("approve-requires-acks").holds(r)).not.toBe(true);
    });
    it("🔍 a second Confirm that approved → consume-prevents-double-approve FAILS", async () => {
        const r = { ...(await base()), secondApproved: true, secondStale: false };
        expect(invariant("consume-prevents-double-approve").holds(r)).not.toBe(true);
    });
});
