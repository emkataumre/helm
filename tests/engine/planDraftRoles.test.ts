// tests/engine/planDraftRoles.test.ts
// The role-tagged acceptance entry contract (2026-07-14 overhaul): entries are legacy strings OR
// {"cmd", "role"} objects, mixed within a task; the parser normalizes into the parallel
// acceptance/acceptanceRoles arrays. Untagged entries stay null so legacy drafts keep legacy semantics.
import { describe, expect, it } from "vitest";
import { parsePlanDraft, planApproval } from "../../src/main/engine/planDraft";

const json = (tasks: unknown[]) => JSON.stringify({ planTitle: "p", tasks });

describe("parsePlanDraft: role-tagged acceptance entries", () => {
    it("parses mixed string + {cmd, role} entries into parallel acceptance/acceptanceRoles", () => {
        const r = parsePlanDraft(json([{
            slug: "t1", title: "T", intent: "i",
            acceptance: ["npm run legacy", { cmd: "npm run check", role: "regression" }, { cmd: " npm run verify:x ", role: "proof" }],
        }]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft.tasks[0].acceptance).toEqual(["npm run legacy", "npm run check", "npm run verify:x"]); // cmd trimmed like legacy strings
        expect(r.draft.tasks[0].acceptanceRoles).toEqual([null, "regression", "proof"]);
    });

    it("rejects a bad role, a missing cmd, and a non-string/non-object entry — with the entry's index", () => {
        const r = parsePlanDraft(json([{
            slug: "t1", title: "T", intent: "i",
            acceptance: [{ cmd: "npm run x", role: "prooof" }, { role: "proof" }, 42],
        }]));
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors.some((e) => e.includes("acceptance[0]"))).toBe(true);
        expect(r.errors.some((e) => e.includes("acceptance[1]"))).toBe(true);
        expect(r.errors.some((e) => e.includes("acceptance[2]"))).toBe(true);
    });

    it("a pure-legacy draft parses with all-null roles (never silently reclassified)", () => {
        const r = parsePlanDraft(json([{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check"] }]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.draft.tasks[0].acceptanceRoles).toEqual([null]);
    });

    it("approve inserts carry the plain command strings — roles live in the draft only (no DB change)", () => {
        const r = parsePlanDraft(json([{
            slug: "t1", title: "T", intent: "i",
            acceptance: [{ cmd: "npm run verify:x", role: "proof" }, { cmd: "npm run check", role: "regression" }],
        }]));
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const inserts = planApproval(r.draft, () => "id-1");
        expect(inserts[0].acceptance).toEqual(["npm run verify:x", "npm run check"]);
        expect("acceptanceRoles" in inserts[0]).toBe(false); // PlanInsert deliberately has no role field
    });
});
