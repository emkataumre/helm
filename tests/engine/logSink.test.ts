// tests/engine/logSink.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogSink } from "../../src/main/engine/logSink";

describe("createLogSink", () => {
    let base: string;
    beforeEach(() => { base = mkdtempSync(join(tmpdir(), "helm-logsink-")); });
    afterEach(() => { rmSync(base, { recursive: true, force: true }); });

    it("appends NDJSON lines to <baseDir>/<taskId>/iter-<index>.ndjson, creating the directory", () => {
        const sink = createLogSink(base, "task-7", 0);
        sink('{"a":1}');
        sink('{"b":2}');
        const file = join(base, "task-7", "iter-0.ndjson");
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    });

    it("keys the file by taskId and iteration index", () => {
        createLogSink(base, "abc", 3)("x");
        expect(existsSync(join(base, "abc", "iter-3.ndjson"))).toBe(true);
    });

    it("accumulates multiple lines in order", () => {
        const sink = createLogSink(base, "t", 1);
        for (const l of ["one", "two", "three"]) sink(l);
        expect(readFileSync(join(base, "t", "iter-1.ndjson"), "utf8")).toBe("one\ntwo\nthree\n");
    });
});
