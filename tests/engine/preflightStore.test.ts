// tests/engine/preflightStore.test.ts
// Unit tests for the persisted-run store + the pure approve decision (the 2026-07-14 pre-flight overhaul:
// approve validates acks against the STORED run — it never re-executes commands).
import { describe, expect, it } from "vitest";
import { createPreflightRunStore, hashDraft, validateApproval, type PreflightRun } from "../../src/main/engine/preflightStore";
import type { PreflightReport } from "../../src/shared/types";

const report = (levels: Array<"ok-red" | "warn-already-green" | "warn-missing">): PreflightReport => ({
    ran: true,
    integrationSha: "abcdef0123456789",
    verdicts: levels.map((level, i) => ({ command: `cmd-${i}`, taskSlugs: ["t1"], level, exitCode: level === "ok-red" ? 1 : 0, tail: "" })),
    warnCount: levels.filter((l) => l !== "ok-red").length,
});
const mkRun = (over: Partial<PreflightRun> = {}): PreflightRun => ({
    runId: "run-1", draftHash: hashDraft("{}"), integrationSha: "abcdef0123456789",
    report: report(["ok-red"]), createdAt: 0, ...over,
});

describe("hashDraft", () => {
    it("is stable for identical bytes and differs on any change", () => {
        expect(hashDraft('{"a":1}')).toBe(hashDraft('{"a":1}'));
        expect(hashDraft('{"a":1}')).not.toBe(hashDraft('{"a":1} '));
    });
});

describe("createPreflightRunStore", () => {
    it("stores the latest run per project (a new run supersedes)", () => {
        const store = createPreflightRunStore();
        store.put("p1", mkRun({ runId: "run-1" }));
        store.put("p1", mkRun({ runId: "run-2" }));
        expect(store.peek("p1")?.runId).toBe("run-2");
    });
    it("consume deletes only when the runId matches (a superseded consume is a no-op)", () => {
        const store = createPreflightRunStore();
        store.put("p1", mkRun({ runId: "run-2" }));
        store.consume("p1", "run-1"); // stale id — must not delete the newer run
        expect(store.peek("p1")?.runId).toBe("run-2");
        store.consume("p1", "run-2");
        expect(store.peek("p1")).toBeUndefined();
    });
    it("clear removes the project's run", () => {
        const store = createPreflightRunStore();
        store.put("p1", mkRun());
        store.clear("p1");
        expect(store.peek("p1")).toBeUndefined();
    });
});

describe("validateApproval", () => {
    const draft = '{"planTitle":"d"}';
    const run = mkRun({ draftHash: hashDraft(draft) });

    it("is synchronous — a pure decision with no seam to execute anything", () => {
        const v = validateApproval(run, { runId: "run-1", draftHashNow: hashDraft(draft), acks: [] });
        expect(v).not.toBeInstanceOf(Promise);
        expect(validateApproval.length).toBe(2); // (run, req) — no deps parameter exists to smuggle an exec through
    });
    it("approves a matching run with no warns", () => {
        expect(validateApproval(run, { runId: "run-1", draftHashNow: hashDraft(draft), acks: [] })).toEqual({ ok: true });
    });
    it("rejects STALE when no run is on record (e.g. a restart)", () => {
        const v = validateApproval(undefined, { runId: "run-1", draftHashNow: hashDraft(draft), acks: [] });
        expect(v).toMatchObject({ ok: false, stale: true });
    });
    it("rejects STALE on a missing or superseded runId", () => {
        expect(validateApproval(run, { draftHashNow: hashDraft(draft), acks: [] })).toMatchObject({ ok: false, stale: true });
        expect(validateApproval(run, { runId: "run-0", draftHashNow: hashDraft(draft), acks: [] })).toMatchObject({ ok: false, stale: true });
    });
    it("rejects STALE when tasks.json changed on disk since the run", () => {
        const v = validateApproval(run, { runId: "run-1", draftHashNow: hashDraft(draft + "\n"), acks: [] });
        expect(v).toMatchObject({ ok: false, stale: true });
        expect((v as { errors: string[] }).errors.join(" ")).toMatch(/changed since pre-flight/);
    });
    it("rejects (NOT stale) while any warn is unacked, and lists the commands", () => {
        const warned = mkRun({ draftHash: hashDraft(draft), report: report(["ok-red", "warn-already-green", "warn-missing"]) });
        const v = validateApproval(warned, { runId: "run-1", draftHashNow: hashDraft(draft), acks: ["cmd-1"] });
        expect(v).toMatchObject({ ok: false, stale: false });
        expect((v as { errors: string[] }).errors).toContain("cmd-2");
        const ok = validateApproval(warned, { runId: "run-1", draftHashNow: hashDraft(draft), acks: ["cmd-1", "cmd-2"] });
        expect(ok).toEqual({ ok: true });
    });
});
