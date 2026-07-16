// tests/verify/planqueue/read.test.ts
// The multi-draft read seam's proof (plan-queue slice 1). .helm/plan/ now holds MANY drafts at once: every
// <slug>/ subdir is a named draft (its own prd.md + tasks.json), while loose files directly under the dir keep
// working as the single anonymous N=1 draft (back-compat). Drives the REAL readPlanDrafts + buildPlanQueueState
// through the injected-fs seam (same idiom as tests/engine/planWatcher.test.ts — the fs edge stays thin).
// PROBE: a malformed subdir must surface its OWN parse error without dropping its siblings.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readPlanDrafts, buildPlanQueueState } from "../../../src/main/engine/planWatcher";
import type { PreflightCtx } from "../../../src/main/engine/planDraft";

const PLAN = join("C:", "repo", ".helm", "plan");
const ctx: PreflightCtx = { npmScripts: ["check", "test"], fileExists: () => true };

// A minimal draft that parses clean (planTitle + one task with mandatory acceptance).
const validTasksJson = (title: string): string =>
    JSON.stringify({ planTitle: title, tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check"] }] });

// The injected fs: a fixed subdir listing + a path→content map (missing path → null, like the real reader).
function fakeFs(subdirs: string[], files: Record<string, string>) {
    return {
        listSubdirs: (dir: string) => (dir === PLAN ? subdirs : []),
        readFile: (p: string) => (p in files ? files[p] : null),
    };
}

describe("verify/planqueue: readPlanDrafts — the multi-draft read", () => {
    it("N subdirs (each with prd.md + tasks.json) parse to N named drafts", () => {
        const fs = fakeFs(["alpha", "beta"], {
            [join(PLAN, "alpha", "prd.md")]: "# alpha prd",
            [join(PLAN, "alpha", "tasks.json")]: validTasksJson("alpha"),
            [join(PLAN, "beta", "prd.md")]: "# beta prd",
            [join(PLAN, "beta", "tasks.json")]: validTasksJson("beta"),
        });
        const drafts = readPlanDrafts(PLAN, fs);
        expect(drafts).toHaveLength(2);
        expect(drafts.map((d) => d.name)).toEqual(["alpha", "beta"]);
        expect(drafts.every((d) => d.prdText != null && d.tasksJson != null)).toBe(true);
    });

    it("loose files directly under the dir keep working as the single anonymous N=1 draft", () => {
        const fs = fakeFs([], {
            [join(PLAN, "prd.md")]: "# loose prd",
            [join(PLAN, "tasks.json")]: validTasksJson("loose"),
        });
        const drafts = readPlanDrafts(PLAN, fs);
        expect(drafts).toHaveLength(1);
        expect(drafts[0].name).toBeNull();
        expect(drafts[0].prdText).toBe("# loose prd");
        expect(drafts[0].tasksJson).toBe(validTasksJson("loose"));
    });

    it("loose root draft and named subdir drafts coexist — anonymous first, subdirs in sorted order", () => {
        const fs = fakeFs(["zeta", "alpha"], {
            [join(PLAN, "prd.md")]: "# loose prd",
            [join(PLAN, "zeta", "tasks.json")]: validTasksJson("zeta"),
            [join(PLAN, "alpha", "prd.md")]: "# alpha prd",
        });
        expect(readPlanDrafts(PLAN, fs).map((d) => d.name)).toEqual([null, "alpha", "zeta"]);
    });

    it("an empty plan dir reads as zero drafts (no phantom anonymous draft)", () => {
        expect(readPlanDrafts(PLAN, fakeFs([], {}))).toEqual([]);
    });

    it("a missing dir is tolerated by the REAL fs defaults (ENOENT → zero drafts, never a throw)", () => {
        expect(readPlanDrafts(join(PLAN, "does-not-exist-xyz"))).toEqual([]);
    });

    it("a half-written subdir (blank tasks.json) reads as its own draft with nulls — siblings untouched", () => {
        const fs = fakeFs(["done", "half"], {
            [join(PLAN, "done", "prd.md")]: "# done",
            [join(PLAN, "done", "tasks.json")]: validTasksJson("done"),
            [join(PLAN, "half", "tasks.json")]: "   \n",
        });
        const drafts = readPlanDrafts(PLAN, fs);
        expect(drafts.map((d) => d.name)).toEqual(["done", "half"]);
        expect(drafts[1]).toMatchObject({ name: "half", prdText: null, tasksJson: null });
        expect(drafts[0].tasksJson).toBe(validTasksJson("done"));
    });
});

describe("verify/planqueue: buildPlanQueueState — per-draft parse isolation", () => {
    // PROBE 🔍 (the malformed-sibling negative control): one poisoned subdir must FAIL alone.
    it("a malformed subdir surfaces its own parse error without dropping its siblings", () => {
        const fs = fakeFs(["alpha", "broken", "gamma"], {
            [join(PLAN, "alpha", "tasks.json")]: validTasksJson("alpha"),
            [join(PLAN, "broken", "tasks.json")]: "{not json",
            [join(PLAN, "gamma", "tasks.json")]: validTasksJson("gamma"),
        });
        const states = buildPlanQueueState(readPlanDrafts(PLAN, fs), ctx);
        expect(states.map((s) => s.name)).toEqual(["alpha", "broken", "gamma"]);

        const broken = states[1];
        expect(broken.parse?.ok).toBe(false);
        expect(broken.parse && !broken.parse.ok ? broken.parse.errors.length : 0).toBeGreaterThan(0);

        for (const sibling of [states[0], states[2]]) {
            expect(sibling.parse?.ok).toBe(true);
            expect(sibling.stage).toBe("tasks");
        }
    });

    it("each draft carries its own stage/prd/verdicts — the same rail contract, once per name", () => {
        const fs = fakeFs(["talking", "specced"], {
            [join(PLAN, "prd.md")]: "# loose prd",
            [join(PLAN, "specced", "prd.md")]: "# specced prd",
            [join(PLAN, "specced", "tasks.json")]: validTasksJson("specced"),
        });
        const states = buildPlanQueueState(readPlanDrafts(PLAN, fs), ctx);
        expect(states.map((s) => [s.name, s.stage])).toEqual([
            [null, "prd"],
            ["specced", "tasks"],
            ["talking", "conversing"],
        ]);
        const specced = states[1];
        expect(specced.prdText).toBe("# specced prd");
        expect(specced.parse?.ok).toBe(true);
        expect(specced.verdicts.length).toBeGreaterThan(0);
        expect(specced.verdicts.every((v) => v.level === "ok")).toBe(true);
    });
});
