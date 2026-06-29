// tests/renderer/progress.test.ts
import { describe, it, expect } from "vitest";
import { parseProgress } from "../../src/renderer/progress";

describe("parseProgress", () => {
    it("parses the four known headings into sections", () => {
        const md = [
            "# Progress — Build it",
            "",
            "## Current focus",
            "doing X",
            "",
            "## Done",
            "- a",
            "",
            "## Remaining",
            "- b",
            "",
            "## Tried & ruled out",
            "- c",
            "",
        ].join("\n");
        const p = parseProgress(md);
        expect(p.ok).toBe(true);
        expect(p.sections?.currentFocus).toContain("doing X");
        expect(p.sections?.done).toContain("- a");
        expect(p.sections?.remaining).toContain("- b");
        expect(p.sections?.triedAndRuledOut).toContain("- c");
    });

    it("falls back to raw for off-schema input (never hard-requires the structure)", () => {
        const p = parseProgress("just freeform notes\nno headings at all");
        expect(p.ok).toBe(false);
        expect(p.sections).toBeUndefined();
        expect(p.raw).toContain("freeform");
    });

    it("falls back to raw when only some headings are present", () => {
        const p = parseProgress("## Current focus\nonly one heading");
        expect(p.ok).toBe(false);
        expect(p.raw).toContain("only one heading");
    });
});
