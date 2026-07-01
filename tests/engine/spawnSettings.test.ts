// tests/engine/spawnSettings.test.ts
// The pure --settings composer (M6-② Task 3). Asserts the Task-1-spike-confirmed shape: the never-push
// permissions.deny belt (colon form, what /permissions emits) + the autoMode.environment string[] with
// the "$defaults" sentinel always present (built-in safety never lost). Leaf module — no engine imports.
import { describe, it, expect } from "vitest";
import { buildSpawnSettings, NEVER_PUSH_DENY } from "../../src/main/engine/spawnSettings";
import type { Project } from "../../src/shared/types";

const mkProject = (autoModeEnvironment: string | null): Project => ({
    id: "p1", name: "P", repoPath: "/repo", integrationBranch: "integration/ralph", targetBranch: "main",
    branchPrefix: "ralph", checkCommand: "npm test", worktreeDir: ".helm/worktrees",
    setupCommand: null, iterationCap: null, noProgressK: null, stallTimeoutMin: null, model: null,
    concurrencyCap: null, terminalCommand: null, autoModeEnvironment, promotionMode: "pr",
});
const parse = (p: Project) => JSON.parse(buildSpawnSettings(p)) as { permissions: { deny: string[] }; autoMode: { environment: string[] } };

describe("buildSpawnSettings", () => {
    it("returns valid JSON whose permissions.deny hard-blocks git push (the never-push belt)", () => {
        const s = parse(mkProject(null));
        expect(s.permissions.deny).toContain("Bash(git push:*)");
        // The exported constant is the single source of truth for the deny list.
        expect(s.permissions.deny).toEqual(NEVER_PUSH_DENY);
    });

    it("also denies rewriting a remote URL (can't smuggle a push via `git remote set-url`)", () => {
        expect(parse(mkProject(null)).permissions.deny).toContain("Bash(git remote set-url:*)");
    });

    it("NULL autoModeEnvironment → environment is exactly [\"$defaults\"] (trusts repo + origin natively)", () => {
        expect(parse(mkProject(null)).autoMode.environment).toEqual(["$defaults"]);
    });

    it("a single free-text trust line → appended after $defaults", () => {
        const env = parse(mkProject("**Trusted internal domains**: registry.acme.internal")).autoMode.environment;
        expect(env).toEqual(["$defaults", "**Trusted internal domains**: registry.acme.internal"]);
    });

    it("multiline text → each non-blank line appended after $defaults (blank lines dropped)", () => {
        const env = parse(mkProject("  line one  \n\n line two \n")).autoMode.environment;
        expect(env).toEqual(["$defaults", "line one", "line two"]);
    });

    it("a JSON-array value → its entries used, $defaults ensured present (built-in safety never dropped)", () => {
        const env = parse(mkProject('["**Trusted cloud buckets**: s3://acme"]')).autoMode.environment;
        expect(env).toEqual(["$defaults", "**Trusted cloud buckets**: s3://acme"]);
    });

    it("a JSON array that already includes $defaults is not duplicated (respects the caller's ordering)", () => {
        const env = parse(mkProject('["$defaults","**Key internal services**: vault.acme"]')).autoMode.environment;
        expect(env).toEqual(["$defaults", "**Key internal services**: vault.acme"]);
    });

    it("a blank/whitespace-only value behaves like NULL → [\"$defaults\"]", () => {
        expect(parse(mkProject("   \n  ")).autoMode.environment).toEqual(["$defaults"]);
    });
});
