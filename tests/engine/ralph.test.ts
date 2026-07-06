// tests/engine/ralph.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRalphExcluded, ensureHelmExcluded, writeRalphFiles } from "../../src/main/engine/ralph";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "helm-ralph-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("ensureRalphExcluded", () => {
    it("adds .ralph/ to .git/info/exclude exactly once (idempotent)", () => {
        mkdirSync(join(root, ".git", "info"), { recursive: true });
        writeFileSync(join(root, ".git", "info", "exclude"), "# existing\n");
        ensureRalphExcluded(root);
        ensureRalphExcluded(root);
        const body = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
        expect(body.split(/\r?\n/).filter((l) => l.trim() === ".ralph/").length).toBe(1);
    });
});

describe("ensureHelmExcluded", () => {
    it("adds .helm/ to .git/info/exclude exactly once (idempotent), tolerant of a missing file", () => {
        mkdirSync(join(root, ".git", "info"), { recursive: true }); // no exclude file yet
        ensureHelmExcluded(root);
        ensureHelmExcluded(root);
        const body = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
        expect(body.split(/\r?\n/).filter((l) => l.trim() === ".helm/").length).toBe(1);
    });
});

describe("writeRalphFiles", () => {
    it("seeds both files, then never clobbers an agent-updated progress.md", () => {
        const wt = join(root, "wt");
        mkdirSync(wt, { recursive: true });
        writeRalphFiles(wt, { instructions: "RITUAL", progress: "SEED" });
        expect(readFileSync(join(wt, ".ralph", "INSTRUCTIONS.md"), "utf8")).toBe("RITUAL");
        expect(readFileSync(join(wt, ".ralph", "progress.md"), "utf8")).toBe("SEED");

        // agent edits progress; a later seed must NOT overwrite it
        writeFileSync(join(wt, ".ralph", "progress.md"), "AGENT EDITED");
        writeRalphFiles(wt, { instructions: "RITUAL", progress: "SEED" });
        expect(readFileSync(join(wt, ".ralph", "progress.md"), "utf8")).toBe("AGENT EDITED");
        expect(existsSync(join(wt, ".ralph", "INSTRUCTIONS.md"))).toBe(true);
    });
});
