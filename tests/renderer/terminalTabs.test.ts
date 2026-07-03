// tests/renderer/terminalTabs.test.ts
// The pure tab-state kernel behind the M8 terminal host. The host's React wiring is a thin shell over
// these three functions; keeping the "which tab is active after an add/close/exit" logic pure means it's
// unit-testable with no DOM (the tab-strip UI itself is render-tested in components.test.tsx).
import { describe, it, expect } from "vitest";
import { upsertTab, removeTab, resolveActive } from "../../src/renderer/terminalTabs";
import type { PtySession, PtySessionInfo } from "../../src/shared/types";

const sess = (id: string, over: Partial<PtySession> = {}): PtySession =>
    ({ id, kind: "free", title: id, cwd: `/wt/${id}`, ...over });
const info = (id: string, over: Partial<PtySessionInfo> = {}): PtySessionInfo =>
    ({ ...sess(id), alive: true, ...over });

describe("resolveActive — which tab is focused after the list changes", () => {
    it("keeps the current active tab when it is still present", () => {
        const tabs = [info("a"), info("b"), info("c")];
        expect(resolveActive(tabs, "b")).toBe("b");
    });

    it("falls back to the LAST tab when the active one is gone (a closed/exited tab)", () => {
        const tabs = [info("a"), info("c")]; // "b" was just closed
        expect(resolveActive(tabs, "b")).toBe("c");
    });

    it("is null when there are no tabs left", () => {
        expect(resolveActive([], "b")).toBeNull();
    });

    it("adopts the last tab when nothing is active yet", () => {
        expect(resolveActive([info("a"), info("b")], null)).toBe("b");
    });
});

describe("upsertTab — opening / re-focusing a session", () => {
    it("appends a newly created session as a (live) tab", () => {
        const next = upsertTab([info("a")], sess("b"));
        expect(next.map((t) => t.id)).toEqual(["a", "b"]);
        expect(next[1].alive).toBe(true);
    });

    it("is idempotent by id — a second open of the same session does not duplicate the tab", () => {
        const tabs = [info("a"), info("b")];
        expect(upsertTab(tabs, sess("b"))).toBe(tabs); // unchanged reference — no-op
    });
});

describe("removeTab — closing / exiting a tab", () => {
    it("drops exactly the closed tab, leaving the order of the rest", () => {
        expect(removeTab([info("a"), info("b"), info("c")], "b").map((t) => t.id)).toEqual(["a", "c"]);
    });

    it("removing an unknown id is a no-op list", () => {
        expect(removeTab([info("a")], "zzz").map((t) => t.id)).toEqual(["a"]);
    });
});
