// tests/engine/planDraft.test.ts — the pure validation brain of M10 (no I/O). parsePlanDraft does the shape
// + slug + acyclic checks over raw tasks.json; staticPreflight flags hallucinated commands against a supplied
// npmScripts list + fileExists probe. Both fully unit-tested here (the plan's TDD unit).
import { describe, it, expect } from "vitest";
import { parsePlanDraft, staticPreflight, planApproval } from "../../src/main/engine/planDraft";
import type { PlanDraft } from "../../src/shared/types";

// A minimal well-formed tasks.json (one task, one acceptance command, no edges).
const valid = () => JSON.stringify({
    planTitle: "tray-planner",
    tasks: [{ slug: "t1", title: "Foundation", intent: "build it", acceptance: ["npm run check"], scopeHint: null, dependsOn: [] }],
});

describe("parsePlanDraft — shape", () => {
    it("parses a well-formed draft", () => {
        const r = parsePlanDraft(valid());
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.draft.planTitle).toBe("tray-planner");
            expect(r.draft.tasks).toHaveLength(1);
            expect(r.draft.tasks[0].slug).toBe("t1");
            expect(r.draft.tasks[0].dependsOn).toEqual([]);
        }
    });

    it("rejects non-JSON with a parse error", () => {
        const r = parsePlanDraft("{not json");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/json/i);
    });

    it("rejects an empty planTitle", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "  ", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["x"] }] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/planTitle/i);
    });

    it("rejects zero tasks", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/at least one task|no tasks/i);
    });

    it("rejects a task missing acceptance (the §6 mandatory gate)", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: [] }] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/acceptance/i);
    });

    it("rejects a task whose acceptance holds a blank command", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["  "] }] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/acceptance/i);
    });

    it("rejects a task with a blank slug/title/intent", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [{ slug: "", title: "T", intent: "i", acceptance: ["x"] }] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/slug/i);
    });

    it("defaults optional scopeHint/dependsOn when absent", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["x"] }] }));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.draft.tasks[0].scopeHint).toBeNull();
            expect(r.draft.tasks[0].dependsOn).toEqual([]);
        }
    });
});

describe("parsePlanDraft — slugs + edges", () => {
    it("rejects duplicate slugs", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [
            { slug: "t1", title: "A", intent: "i", acceptance: ["x"] },
            { slug: "t1", title: "B", intent: "i", acceptance: ["x"] },
        ] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/duplicate|unique/i);
    });

    it("rejects a dependsOn referencing a non-existent sibling", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [
            { slug: "t1", title: "A", intent: "i", acceptance: ["x"], dependsOn: ["ghost"] },
        ] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.join(" ")).toMatch(/ghost/);
    });

    it("accepts a valid DAG (child after parent)", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [
            { slug: "t1", title: "A", intent: "i", acceptance: ["x"] },
            { slug: "t2", title: "B", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
        ] }));
        expect(r.ok).toBe(true);
    });

    it("rejects a cycle, naming the members", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [
            { slug: "a", title: "A", intent: "i", acceptance: ["x"], dependsOn: ["b"] },
            { slug: "b", title: "B", intent: "i", acceptance: ["x"], dependsOn: ["a"] },
        ] }));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.errors.join(" ")).toMatch(/cycle/i);
            expect(r.errors.join(" ")).toMatch(/a/);
            expect(r.errors.join(" ")).toMatch(/b/);
        }
    });
});

describe("staticPreflight", () => {
    const ctx = { npmScripts: ["check", "build", "verify:tray"], fileExists: (_p: string) => false };
    const draftWith = (commands: string[]) => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: commands }] }));
        if (!r.ok) throw new Error("fixture draft did not parse: " + r.errors.join("; "));
        return r.draft;
    };

    it("marks a known npm script ok", () => {
        const v = staticPreflight(draftWith(["npm run check"]), ctx);
        expect(v).toHaveLength(1);
        expect(v[0]).toMatchObject({ taskSlug: "t1", command: "npm run check", level: "ok" });
    });

    it("warns on an unknown npm script with a did-you-mean suggestion", () => {
        const v = staticPreflight(draftWith(["npm run verify:trays"]), ctx);
        expect(v[0].level).toBe("warn");
        expect(v[0].suggestion).toBe("verify:tray");
    });

    it("warns on an unknown npm script even with no close match (no suggestion)", () => {
        const v = staticPreflight(draftWith(["npm run zzz-nothing-like-this"]), ctx);
        expect(v[0].level).toBe("warn");
        expect(v[0].suggestion).toBeUndefined();
    });

    it("warns on a missing script path (node scripts/x.mjs)", () => {
        const v = staticPreflight(draftWith(["node scripts/x.mjs"]), { npmScripts: [], fileExists: () => false });
        expect(v[0].level).toBe("warn");
        expect(v[0].reason).toMatch(/scripts\/x\.mjs/);
    });

    it("marks a present script path ok (./run.ps1 that exists)", () => {
        const v = staticPreflight(draftWith(["./run.ps1"]), { npmScripts: [], fileExists: (p) => p === "./run.ps1" });
        expect(v[0].level).toBe("ok");
    });

    it("does not false-warn on an opaque command it can't statically judge", () => {
        const v = staticPreflight(draftWith(["pytest -q"]), { npmScripts: [], fileExists: () => false });
        expect(v[0].level).toBe("ok");
    });

    it("emits one verdict per task × command, across tasks", () => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks: [
            { slug: "t1", title: "A", intent: "i", acceptance: ["npm run check", "npm run nope"] },
            { slug: "t2", title: "B", intent: "i", acceptance: ["npm run build"], dependsOn: ["t1"] },
        ] }));
        if (!r.ok) throw new Error("bad fixture");
        const v = staticPreflight(r.draft, ctx);
        expect(v).toHaveLength(3);
        expect(v.filter((x) => x.level === "warn").map((x) => x.command)).toEqual(["npm run nope"]);
    });
});

describe("planApproval — topo sort + slug→id resolution", () => {
    const parse = (tasks: unknown[]): PlanDraft => {
        const r = parsePlanDraft(JSON.stringify({ planTitle: "p", tasks }));
        if (!r.ok) throw new Error("bad fixture: " + r.errors.join("; "));
        return r.draft;
    };
    // A deterministic id generator: id-1, id-2, … one per task, in call order.
    const gen = () => { let n = 0; return () => `id-${++n}`; };

    it("emits one insert per task, assigning a fresh id, preserving fields", () => {
        const draft = parse([{ slug: "t1", title: "T", intent: "build", acceptance: ["npm run check"], scopeHint: "src/**" }]);
        const inserts = planApproval(draft, gen());
        expect(inserts).toHaveLength(1);
        expect(inserts[0]).toMatchObject({ id: "id-1", slug: "t1", title: "T", intent: "build", acceptance: ["npm run check"], scopeHint: "src/**", dependsOn: [] });
    });

    it("orders a child after its parent and resolves the edge slug to the parent's id", () => {
        const draft = parse([
            { slug: "t1", title: "A", intent: "i", acceptance: ["x"] },
            { slug: "t2", title: "B", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
        ]);
        const inserts = planApproval(draft, gen());
        expect(inserts.map((i) => i.slug)).toEqual(["t1", "t2"]);
        const [t1, t2] = inserts;
        expect(t2.dependsOn).toEqual([t1.id]);
    });

    it("reorders parent-first even when the draft lists the child first", () => {
        const draft = parse([
            { slug: "child", title: "C", intent: "i", acceptance: ["x"], dependsOn: ["parent"] },
            { slug: "parent", title: "P", intent: "i", acceptance: ["x"] },
        ]);
        const inserts = planApproval(draft, gen());
        expect(inserts.map((i) => i.slug)).toEqual(["parent", "child"]);
        expect(inserts[1].dependsOn).toEqual([inserts[0].id]);
    });

    it("resolves a diamond (t4 waits on t2+t3, both on t1) with every edge pointing at a real id", () => {
        const draft = parse([
            { slug: "t1", title: "1", intent: "i", acceptance: ["x"] },
            { slug: "t2", title: "2", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
            { slug: "t3", title: "3", intent: "i", acceptance: ["x"], dependsOn: ["t1"] },
            { slug: "t4", title: "4", intent: "i", acceptance: ["x"], dependsOn: ["t2", "t3"] },
        ]);
        const inserts = planApproval(draft, gen());
        const order = inserts.map((i) => i.slug);
        expect(order[0]).toBe("t1");
        expect(order.at(-1)).toBe("t4");
        const idOf = Object.fromEntries(inserts.map((i) => [i.slug, i.id]));
        // Every emitted edge points at a real sibling id, and appears earlier in the list (a valid topo order).
        inserts.forEach((ins, idx) => {
            for (const dep of ins.dependsOn) {
                const parentIdx = inserts.findIndex((x) => x.id === dep);
                expect(parentIdx).toBeGreaterThanOrEqual(0);
                expect(parentIdx).toBeLessThan(idx);
            }
        });
        expect(inserts.find((i) => i.slug === "t4")!.dependsOn.sort()).toEqual([idOf.t2, idOf.t3].sort());
    });
});
