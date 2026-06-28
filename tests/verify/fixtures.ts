// tests/verify/fixtures.ts
// The FIXTURES for the runTaskSinglePass unit: named, reproducible worlds to drop the real
// engine into. Each states only what it bends from the green path, plus the terminal state
// it expects. Some are PROBES — deliberately off-happy-path (a hung check, a merge conflict)
// — because "a checklist that's all happy-path replay hasn't actually been tested"
// (~/.claude/verification.md). These probes are adversarial *inputs* the engine must handle
// correctly (→ PASS); the deliberately-broken-must-FAIL case is the negative-control snapshot
// in engine.test.ts.
import type { DepConfig } from "./surface";
import type { TaskStatus } from "../../src/shared/types";

export interface Fixture {
    id: string;
    probe?: boolean;
    config: DepConfig;
    expect: { finalStatus: TaskStatus; gateVerdict: "green" | "failed" | "hang" };
}

export const FIXTURES: Fixture[] = [
    // Happy path: agent ok, check green, clean squash-merge.
    {
        id: "green-merge",
        config: {},
        expect: { finalStatus: "merged", gateVerdict: "green" },
    },
    // The agent never completes — bail before the check even runs.
    {
        id: "agent-fails",
        config: { agent: { ok: false, output: "claude died" } },
        expect: { finalStatus: "needs-human", gateVerdict: "failed" },
    },
    // The check runs and goes red — no merge, hand off to a human.
    {
        id: "check-fails",
        config: { check: { green: false, output: "1 failing test" } },
        expect: { finalStatus: "needs-human", gateVerdict: "failed" },
    },
    // PROBE: the check hangs and is killed — a distinct "hang" verdict, still needs-human.
    {
        id: "check-hangs",
        probe: true,
        config: { check: { green: false, timedOut: true, output: "no output for 30m" } },
        expect: { finalStatus: "needs-human", gateVerdict: "hang" },
    },
    // PROBE: green work, but the squash-merge conflicts — must NOT report merged.
    {
        id: "merge-conflict",
        probe: true,
        config: { merge: { merged: false, conflict: true } },
        expect: { finalStatus: "needs-human", gateVerdict: "failed" },
    },
];
