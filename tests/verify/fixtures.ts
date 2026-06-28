// tests/verify/fixtures.ts
// Named, reproducible worlds to drop the real loop into. Each bends only what it must from the
// green path. Some are PROBES — deliberately off-happy-path (cap hit, no-progress, stall, merge
// conflict, empty acceptance) — because an all-green checklist hasn't actually been tested.
import type { DepConfig } from "./surface";
import type { TaskStatus } from "../../src/shared/types";

export interface Fixture { id: string; probe?: boolean; config: DepConfig; expect: { finalStatus: TaskStatus }; }

export const FIXTURES: Fixture[] = [
    { id: "green-first-pass", config: { script: [{}] }, expect: { finalStatus: "merged" } },
    { id: "red-then-green", config: { script: [{ checkGreen: false }, {}] }, expect: { finalStatus: "merged" } },
    { id: "acceptance-red-then-green", config: { script: [{ acceptanceOk: false }, {}] }, expect: { finalStatus: "merged" } },
    { id: "cap-reached", probe: true, config: { config: { iterationCap: 2, noProgressK: 99 }, script: [{ checkGreen: false }, { checkGreen: false }] }, expect: { finalStatus: "needs-human" } },
    { id: "no-progress-breaker", probe: true, config: { config: { noProgressK: 2 }, script: [{ checkGreen: false, newCommit: false }, { checkGreen: false, newCommit: false }] }, expect: { finalStatus: "needs-human" } },
    { id: "stall-recycled", probe: true, config: { script: [{ stalled: true }, {}] }, expect: { finalStatus: "merged" } },
    { id: "merge-conflict", probe: true, config: { mergeConflict: true, script: [{}] }, expect: { finalStatus: "needs-human" } },
    { id: "empty-acceptance", probe: true, config: { acceptance: [] }, expect: { finalStatus: "needs-human" } },
];
