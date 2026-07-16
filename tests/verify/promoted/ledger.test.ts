// tests/verify/promoted/ledger.test.ts
// The promoted-ledger verify slice: work that merged onto integration vs work that GRADUATED to the
// target. Drives the REAL pieces headlessly — openDb/migrate (the nullable ledger columns), the real
// finalizePromotion with the deps wired exactly like ipc (recordPromotion → stampPromoted), and the
// real derived read (isPromoted). Asserts the batch-stamp contract: a LANDED direct advance stamps
// promotedAt + the exact validated sha on EVERY then-merged task of the project — and nothing else.
// Probe (🔍): a task that was needs-human at promote time is NOT stamped. Tasks stay 'merged'
// throughout — 'promoted' is derived (promotedAt != null), never a TaskStatus. Vocabulary from
// ~/.claude/verification.md; runs headless under `npm run check`, zero production footprint.
import { describe, it, expect } from "vitest";
import { openDb, type Db } from "../../../src/main/db/db";
import { insertProject } from "../../../src/main/db/projects";
import { insertTask, updateTask, getTask, stampPromoted, isPromoted } from "../../../src/main/db/tasks";
import { finalizePromotion, type FinalizeDeps } from "../../../src/main/engine/promote";
import type { Project, PromoteReady, TaskStatus } from "../../../src/shared/types";

const SHA1 = "cafe1111cafe1111cafe1111cafe1111cafe1111";
const SHA2 = "beef2222beef2222beef2222beef2222beef2222";

const readyAt = (sha: string): PromoteReady => ({
    outcome: "ready", validatedSha: sha,
    diffstat: "2 files changed, 8 insertions(+)",
    promoteBranch: `helm/promote-p-${sha.slice(0, 12)}`,
});

// A real migrated DB + a project + a task factory that lands each task in the wanted lifecycle state
// through the real status-write chokepoint (updateTask), exactly like the engine does.
function world(promotionMode: "pr" | "direct" | "strict" = "direct") {
    const db = openDb(":memory:");
    const project = insertProject(db, {
        name: "P", repoPath: "C:/repo", targetBranch: "main",
        checkCommand: "npm run check", promotionMode,
    });
    const task = (title: string, status: TaskStatus) => {
        const t = insertTask(db, { projectId: project.id, title, intent: "intent", acceptance: ["npm run check"] });
        if (status !== "queued") updateTask(db, t.id, { status });
        return t;
    };
    return { db, project, task };
}

const read = (db: Db, id: string) => {
    const t = getTask(db, id);
    if (!t) throw new Error(`missing task ${id}`);
    return t;
};

// The finalize deps wired exactly like ipc's buildFinalizeDeps: a recording pushBranch fake (reject to
// simulate a moved target) + the REAL batch stamp as recordPromotion.
function depsFor(db: Db, project: Project, opts: { rejectPush?: boolean } = {}) {
    const pushes: Array<{ localRef: string; remoteRef?: string }> = [];
    const deps: FinalizeDeps = {
        pushBranch: async (_repo, _remote, localRef, remoteRef) => {
            if (opts.rejectPush) throw new Error("non-fast-forward");
            pushes.push({ localRef, remoteRef });
        },
        recordPromotion: (sha) => { stampPromoted(db, project.id, sha); },
    };
    return { deps, pushes };
}

describe("verify/promoted: a landed direct Promote batch-stamps the ledger", () => {
    it("stamps EVERY merged task of the project with promotedAt + the exact validated sha", async () => {
        const { db, project, task } = world("direct");
        const a = task("merged A", "merged");
        const b = task("merged B", "merged");
        const q = task("still queued", "queued");
        const r = task("still running", "running");

        const f = await finalizePromotion(project, readyAt(SHA1), depsFor(db, project).deps);
        expect(f.advancedTarget).toBe(true);

        for (const m of [a, b]) {
            const t = read(db, m.id);
            expect(t.status).toBe("merged"); // tasks STAY merged — promoted is never a status
            expect(t.promotedAt).not.toBeNull();
            expect(t.promotedSha).toBe(SHA1);
        }
        for (const untouched of [q, r]) {
            const t = read(db, untouched.id);
            expect(t.promotedAt).toBeNull();
            expect(t.promotedSha).toBeNull();
        }
    });

    it("🔍 probe: a task that was needs-human at promote time is NOT stamped", async () => {
        const { db, project, task } = world("direct");
        const merged = task("merged", "merged");
        const stuck = task("stuck", "needs-human");

        const f = await finalizePromotion(project, readyAt(SHA1), depsFor(db, project).deps);
        expect(f.advancedTarget).toBe(true);

        expect(read(db, merged.id).promotedSha).toBe(SHA1);
        const s = read(db, stuck.id);
        expect(s.promotedAt).toBeNull();
        expect(s.promotedSha).toBeNull();
        expect(isPromoted(s)).toBe(false);
    });

    it("a rejected advance (the target moved) stamps NOTHING", async () => {
        const { db, project, task } = world("direct");
        const merged = task("merged", "merged");

        const f = await finalizePromotion(project, readyAt(SHA1), depsFor(db, project, { rejectPush: true }).deps);
        expect(f.advancedTarget).toBe(false);
        expect(f.error).toBeDefined();

        const t = read(db, merged.id);
        expect(t.promotedAt).toBeNull();
        expect(t.promotedSha).toBeNull();
    });

    it("pr mode pushes integration but never stamps; strict pushes nothing and never stamps", async () => {
        for (const mode of ["pr", "strict"] as const) {
            const { db, project, task } = world(mode);
            const merged = task("merged", "merged");
            const { deps, pushes } = depsFor(db, project);

            const f = await finalizePromotion(project, readyAt(SHA1), deps);
            expect(f.advancedTarget).toBe(false);
            expect(pushes).toEqual(mode === "pr" ? [{ localRef: project.integrationBranch, remoteRef: undefined }] : []);

            const t = read(db, merged.id);
            expect(t.promotedAt).toBeNull();
            expect(isPromoted(t)).toBe(false);
        }
    });

    it("the ledger is append-only: a re-promote never rewrites an earlier graduation", async () => {
        const { db, project, task } = world("direct");
        const early = task("merged early", "merged");
        await finalizePromotion(project, readyAt(SHA1), depsFor(db, project).deps);
        const firstStamp = read(db, early.id).promotedAt;

        const late = task("merged later", "merged");
        await finalizePromotion(project, readyAt(SHA2), depsFor(db, project).deps);

        const a = read(db, early.id);
        expect(a.promotedSha).toBe(SHA1); // first stamp wins — history is not rewritten
        expect(a.promotedAt).toBe(firstStamp);
        expect(read(db, late.id).promotedSha).toBe(SHA2); // only the newly-merged task picks up the new sha
    });
});

describe("verify/promoted: the derived 'promoted' flag", () => {
    it("reads true iff promotedAt is set (the sha is companion evidence, not the key)", async () => {
        const { db, project, task } = world("direct");
        const merged = task("merged", "merged");

        expect(isPromoted(read(db, merged.id))).toBe(false); // merged ≠ promoted before any Promote
        await finalizePromotion(project, readyAt(SHA1), depsFor(db, project).deps);
        expect(isPromoted(read(db, merged.id))).toBe(true);

        expect(isPromoted({ promotedAt: 1, promotedSha: null })).toBe(true);
        expect(isPromoted({ promotedAt: null, promotedSha: SHA1 })).toBe(false);
        expect(isPromoted({ promotedAt: null, promotedSha: null })).toBe(false);
    });
});

describe("verify/promoted: the ledger columns land via db.ts migrate", () => {
    it("a fresh openDb reaches head with both ledger columns present and nullable", () => {
        const { db, task } = world("direct");
        const cols = db.pragma("table_info(tasks)") as Array<{ name: string; notnull: number }>;
        const byName = new Map(cols.map((c) => [c.name, c]));
        expect(byName.get("promotedAt")?.notnull).toBe(0);
        expect(byName.get("promotedSha")?.notnull).toBe(0);

        // A fresh row reads back NULL/NULL through the real mapping — unpromoted by default.
        const t = read(db, task("fresh", "queued").id);
        expect(t.promotedAt).toBeNull();
        expect(t.promotedSha).toBeNull();
    });
});
