// M16 acceptance — the blessed CLI over the live named pipe, agent-free. Connects to the app's control
// pipe FROM THE TEST PROCESS (the same one-JSON-request/one-JSON-response transport the `helm` CLI
// speaks — the CLI binary itself is exercised implicitly since both are thin shells over this wire),
// and proves the "one implementation, two transports" contract on the REAL app:
//   · `status` over the pipe agrees with window.helm.listTasks (ids + statuses),
//   · an unknown / deliberately-absent intake verb is rejected with a structured error,
//   · a steer (`abandon` on a seeded needs-human task) produces EXACTLY the transition the cockpit
//     button produces (status → abandoned via the same shared mutex-wrapped path),
//   · `pause` over the pipe flips the same scheduler state window.helm reads.
// AGENT-FREE: the fleet is PAUSED before any steer, the seeded task is needs-human (never
// auto-started), and the scenario try/finally-closes its app. The pipe name is derived from the
// throwaway HELM_USER_DATA via the same pipeNameFor the app uses — a real Helm's pipe is unreachable
// by construction.
import { describe, it, expect } from "vitest";
import { connect } from "node:net";
import type { Page } from "playwright-core";
import { launchHelm, seededNeedsHumanBoard, until } from "./harness";
import { pipeNameFor, type CtlResponse } from "../../src/main/ctl/protocol";

// One request over the wire, exactly like cli.ts: newline-terminated JSON out, one JSON response back.
function ctl(pipe: string, req: { verb: string; args?: Record<string, string>; cwd?: string }): Promise<CtlResponse> {
    return new Promise((resolve, reject) => {
        const sock = connect(pipe);
        let buf = "";
        sock.setEncoding("utf8");
        sock.setTimeout(10_000, () => { sock.destroy(); reject(new Error("ctl request timed out")); });
        sock.on("error", reject);
        sock.on("connect", () => { sock.write(JSON.stringify(req) + "\n"); });
        sock.on("data", (c: string) => { buf += c; });
        sock.on("end", () => {
            try { resolve(JSON.parse(buf.trim()) as CtlResponse); }
            catch (e) { reject(e as Error); }
        });
    });
}

async function pauseFleet(page: Page): Promise<void> {
    await page.evaluate(() => window.helm.setSchedulerPaused(true));
    await until(async () => (await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "scheduler paused" });
}

interface StatusData { paused: boolean; tasks: Array<{ id: string; status: string; costUsd: number }> }

describe("ctl", () => {
    it("status agrees with window.helm; unknown verbs rejected; abandon steers the button's transition", async () => {
        const board = seededNeedsHumanBoard("CtlProj", "Pipe-steered task");
        const helm = await launchHelm({ seed: board.seed });
        const { page } = helm;
        const pipe = pipeNameFor(helm.userData);
        try {
            await pauseFleet(page);

            // The pipe answers (it listens from registerIpc, so it's up before the window even paints —
            // until() only papers over scheduling noise, never a missing server).
            const status = await until(() => ctl(pipe, { verb: "status" }).catch(() => null), { label: "ctl status over the pipe" });
            expect(status.ok).toBe(true);
            const data = (status as { ok: true; data: StatusData }).data;
            expect(data.paused).toBe(true); // the pause window.helm set is the pause the pipe reads

            // READ PARITY: the pipe's board is byte-for-byte the ipc's board (ids + statuses).
            const viaIpc = await page.evaluate(() => window.helm.listTasks());
            expect(data.tasks.map((t) => [t.id, t.status]).sort()).toEqual(viaIpc.map((t) => [t.id, t.status]).sort());
            expect(data.tasks.find((t) => t.id === board.taskId)?.status).toBe("needs-human");

            // The deliberately-absent intake verb: structurally rejected, never routed (spec §3).
            const bad = await ctl(pipe, { verb: "create-task", args: { title: "smuggled" } });
            expect(bad.ok).toBe(false);
            expect((bad as { ok: false; error: string }).error).toContain("unknown verb");
            // ...and nothing was created.
            expect((await page.evaluate(() => window.helm.listTasks())).length).toBe(viaIpc.length);

            // STEER PARITY: abandon over the pipe = the cockpit button's transition (same shared
            // mutex-wrapped handback — worktree reaped, status flips to abandoned).
            const res = await ctl(pipe, { verb: "abandon", args: { id: board.taskId } });
            expect(res.ok).toBe(true);
            await until(async () => {
                const t = (await page.evaluate(() => window.helm.listTasks())).find((x) => x.id === board.taskId);
                return t?.status === "abandoned" ? t : null;
            }, { label: "abandoned via the pipe" });
        } finally {
            await helm.close();
        }
    });

    it("resume over the pipe unpauses the same scheduler the cockpit switch reads", async () => {
        const board = seededNeedsHumanBoard("CtlProj2", "Untouched needs-human task");
        const helm = await launchHelm({ seed: board.seed });
        const { page } = helm;
        const pipe = pipeNameFor(helm.userData);
        try {
            await pauseFleet(page);
            // resume via the pipe → the SAME scheduler state window.helm reads flips. Safe unpaused:
            // the only seeded task is needs-human (retaining), so nothing is eligible to auto-start.
            const res = await until(() => ctl(pipe, { verb: "resume" }).catch(() => null), { label: "ctl resume over the pipe" });
            expect(res.ok).toBe(true);
            await until(async () => !(await page.evaluate(() => window.helm.getSchedulerState())).paused, { label: "unpaused via the pipe" });
            // ...and the pipe's own read agrees.
            const status = await ctl(pipe, { verb: "status" });
            expect(status.ok && (status as { ok: true; data: StatusData }).data.paused).toBe(false);
        } finally {
            await helm.close();
        }
    });
});
