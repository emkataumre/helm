// tests/engine/detect.test.ts
import { describe, it, expect } from "vitest";
import { detectFromInputs } from "../../src/main/engine/detect";

describe("detectFromInputs (project-config auto-detect core)", () => {
    it("prefers a `check` script, falls back to `test`, else null", () => {
        expect(detectFromInputs('{"scripts":{"check":"x","test":"y"}}', [], "main").checkCommand).toBe("npm run check");
        expect(detectFromInputs('{"scripts":{"test":"y"}}', [], "main").checkCommand).toBe("npm test");
        expect(detectFromInputs('{"scripts":{}}', [], "main").checkCommand).toBeNull();
    });

    it("guesses the install command from the lockfile present", () => {
        expect(detectFromInputs(null, ["package-lock.json"], null).setupCommand).toBe("npm ci");
        expect(detectFromInputs(null, ["pnpm-lock.yaml"], null).setupCommand).toBe("pnpm install");
        expect(detectFromInputs(null, ["yarn.lock"], null).setupCommand).toBe("yarn install");
        expect(detectFromInputs(null, ["bun.lockb"], null).setupCommand).toBe("bun install");
        expect(detectFromInputs(null, [], null).setupCommand).toBeNull();
    });

    it("uses the current branch as the target and tolerates a malformed package.json", () => {
        expect(detectFromInputs("{ not json", [], "develop")).toEqual({ targetBranch: "develop", checkCommand: null, setupCommand: null });
    });
});
