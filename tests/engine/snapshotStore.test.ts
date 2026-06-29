// tests/engine/snapshotStore.test.ts
import { describe, it, expect } from "vitest";
import { createSnapshotStore } from "../../src/main/engine/snapshotStore";

describe("createSnapshotStore", () => {
    it("dispatch creates and advances a per-task snapshot via the real reducer", () => {
        const store = createSnapshotStore();
        const s = store.dispatch("t", { type: "iteration-start", index: 0 });
        expect(s.taskId).toBe("t");
        expect(s.iterations).toHaveLength(1);
        store.dispatch("t", { type: "status", status: "merged" });
        expect(store.get("t")?.status).toBe("merged");
    });

    it("calls onChange with the taskId of the advanced snapshot", () => {
        const seen: string[] = [];
        const store = createSnapshotStore((id) => seen.push(id));
        store.dispatch("t", { type: "iteration-start", index: 0 });
        store.dispatch("t", { type: "iteration-end", index: 0, verdict: "green", commitSha: "a" });
        expect(seen).toEqual(["t", "t"]);
    });

    it("keeps separate snapshots per task", () => {
        const store = createSnapshotStore();
        store.dispatch("a", { type: "iteration-start", index: 0 });
        store.dispatch("b", { type: "iteration-start", index: 0 });
        expect(store.get("a")).not.toBe(store.get("b"));
        expect(store.get("a")?.taskId).toBe("a");
    });

    it("get returns undefined for an unknown task", () => {
        expect(createSnapshotStore().get("nope")).toBeUndefined();
    });
});
