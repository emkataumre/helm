// tests/verify/planqueue/wire.test.ts
// The queue-push wiring's GATE proof (plan-queue slice — "wire multi-draft read + approve-by-subdir"). The
// ipc-facing plan-rail read is now ONE pure seam, composePlanQueueState(repoPath, ctx, fs): it lists every
// draft under a repo's .helm/plan/ (the loose-root anonymous draft first when it has files, then each
// <slug>/ subdir sorted) and composes each into its own named rail state — the exact list ipc pushes over the
// plan channel. resolveDraftFiles(dir, name, fs) is the approve-by-name seam: a null name is the loose root
// (back-compat), a <slug> name is THAT subdir's files, and an UNKNOWN name reads as nulls, never silently
// falling back to the root. Drives both through the injected-fs seam (the read.test.ts / planWatcher.test.ts
// idiom — the fs edge stays thin). PROBES 🔍: root-only → exactly one anonymous draft; an unknown draft name
// → no files (not a root fallback). Vocabulary from ~/.claude/verification.md.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { composePlanQueueState, resolveDraftFiles } from "../../../src/main/engine/planWatcher";
import type { PreflightCtx } from "../../../src/main/engine/planDraft";

const REPO = join("C:", "repo");
const PLAN = join(REPO, ".helm", "plan");
const ctx: PreflightCtx = { npmScripts: ["check", "test"], fileExists: () => true };

// A minimal draft that parses clean (planTitle + one task with mandatory acceptance).
const validTasksJson = (title: string): string =>
    JSON.stringify({ planTitle: title, tasks: [{ slug: "t1", title: "T", intent: "i", acceptance: ["npm run check"] }] });

// The injected fs: a fixed subdir listing (only for the plan dir) + a path→content map (missing path → null,
// like the real reader). Same shape composePlanQueueState/readPlanDrafts expect via DraftReadDeps.
function fakeFs(subdirs: string[], files: Record<string, string>) {
    return {
        listSubdirs: (dir: string) => (dir === PLAN ? subdirs : []),
        readFile: (p: string) => (p in files ? files[p] : null),
    };
}
// A bare readFile over a path→content map, for the resolveDraftFiles seam (which only reads, never lists).
const readFileFrom = (files: Record<string, string>) => (p: string) => (p in files ? files[p] : null);

describe("verify/planqueue: composePlanQueueState — the ipc-facing multi-draft read", () => {
    it("N subdirs → N named rail states in SET ORDER (the exact list ipc pushes)", () => {
        const fs = fakeFs(["alpha", "beta"], {
            [join(PLAN, "alpha", "prd.md")]: "# alpha",
            [join(PLAN, "alpha", "tasks.json")]: validTasksJson("alpha"),
            [join(PLAN, "beta", "tasks.json")]: validTasksJson("beta"),
        });
        const states = composePlanQueueState(REPO, ctx, fs);
        expect(states.map((s) => s.name)).toEqual(["alpha", "beta"]);
        expect(states.every((s) => s.parse?.ok === true && s.stage === "tasks")).toBe(true);
    });

    it("the loose-root anonymous draft comes FIRST, then <slug>/ subdirs sorted", () => {
        const fs = fakeFs(["zeta", "alpha"], {
            [join(PLAN, "tasks.json")]: validTasksJson("root"),
            [join(PLAN, "alpha", "tasks.json")]: validTasksJson("alpha"),
            [join(PLAN, "zeta", "tasks.json")]: validTasksJson("zeta"),
        });
        expect(composePlanQueueState(REPO, ctx, fs).map((s) => s.name)).toEqual([null, "alpha", "zeta"]);
    });

    // A malformed subdir surfaces its own parse-FAIL entry without dropping its siblings (buildPlanQueueState's
    // per-draft isolation, now reached through the compose seam ipc actually calls).
    it("a malformed subdir is its own parse-FAIL entry — never drops a sibling", () => {
        const fs = fakeFs(["alpha", "broken"], {
            [join(PLAN, "alpha", "tasks.json")]: validTasksJson("alpha"),
            [join(PLAN, "broken", "tasks.json")]: "{not json",
        });
        const states = composePlanQueueState(REPO, ctx, fs);
        expect(states.map((s) => s.name)).toEqual(["alpha", "broken"]);
        expect(states[0].parse?.ok).toBe(true);
        expect(states[1].parse?.ok).toBe(false);
    });

    // PROBE 🔍 (root-only): loose files with NO subdirs must be exactly one anonymous draft — no phantom
    // subdir entries, and the anonymous draft is name:null (the pre-queue single face).
    it("🔍 root-only → EXACTLY ONE anonymous draft", () => {
        const fs = fakeFs([], {
            [join(PLAN, "prd.md")]: "# root",
            [join(PLAN, "tasks.json")]: validTasksJson("root"),
        });
        const states = composePlanQueueState(REPO, ctx, fs);
        expect(states).toHaveLength(1);
        expect(states[0].name).toBeNull();
        expect(states[0].parse?.ok).toBe(true);
    });

    it("an empty plan dir → zero drafts (no phantom anonymous draft)", () => {
        expect(composePlanQueueState(REPO, ctx, fakeFs([], {}))).toEqual([]);
    });
});

describe("verify/planqueue: resolveDraftFiles — approve resolves the right draft's files by name", () => {
    it("a <slug> name resolves THAT subdir's files (approve-by-name)", () => {
        const files = readFileFrom({
            [join(PLAN, "beta", "prd.md")]: "# beta",
            [join(PLAN, "beta", "tasks.json")]: validTasksJson("beta"),
        });
        const resolved = resolveDraftFiles(PLAN, "beta", files);
        expect(resolved.prdText).toBe("# beta");
        expect(resolved.tasksJson).toBe(validTasksJson("beta"));
    });

    it("a null name resolves the loose root (back-compat)", () => {
        const files = readFileFrom({
            [join(PLAN, "prd.md")]: "# root",
            [join(PLAN, "tasks.json")]: validTasksJson("root"),
        });
        expect(resolveDraftFiles(PLAN, null, files).tasksJson).toBe(validTasksJson("root"));
    });

    // PROBE 🔍 (unknown name): a name with no matching subdir must read as NULLS — the approve gate then fails
    // "no tasks.json", never silently approving the ROOT's files under the wrong name.
    it("🔍 an unknown draft name → no files, NOT a silent fallback to the root", () => {
        const files = readFileFrom({
            [join(PLAN, "prd.md")]: "# root",
            [join(PLAN, "tasks.json")]: validTasksJson("root"),
        });
        expect(resolveDraftFiles(PLAN, "ghost", files)).toEqual({ prdText: null, tasksJson: null });
    });
});
