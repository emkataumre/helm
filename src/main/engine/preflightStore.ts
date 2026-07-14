// src/main/engine/preflightStore.ts
// The persisted-run half of the overhauled two-phase approve (design: docs/specs/2026-07-14-preflight-
// overhaul-design.md). plans:preflight runs once and STORES its result here; plans:approve validates the
// human's acks against the STORED run — it never re-executes commands. The trust boundary is unchanged
// (the server only trusts what the server itself ran); what's gone is the silent approve-time re-run that
// doubled wall-clock, let verdicts drift out from under the acks, and raced its own worktree.
//
// Deliberately in-memory, latest-run-per-project: the plan dir itself is transient scratch, so a Helm
// restart honestly reports "stale — re-run" rather than pretending durability. Staleness is DRAFT-HASH
// only — tip movement does not invalidate (pre-flight was always "validated one merge old at worst");
// the report carries the tip sha so the panel can show what it validated against.
import { createHash } from "node:crypto";
import type { PreflightReport } from "../../shared/types";
import { unackedWarnCommands } from "./preflight";

export interface PreflightRun {
    runId: string;
    draftHash: string;       // hash of the tasks.json BYTES the run validated (not the parsed shape)
    integrationSha: string;
    report: PreflightReport;
    createdAt: number;
}

export const hashDraft = (tasksJson: string): string => createHash("sha256").update(tasksJson).digest("hex");

// Latest run per project. `consume` deletes on a successful approve — a second Confirm against the same
// runId finds nothing and fails stale instead of double-inserting (the elektronik-and-pant ×2 lesson).
export interface PreflightRunStore {
    put: (projectId: string, run: PreflightRun) => void;
    peek: (projectId: string) => PreflightRun | undefined;
    consume: (projectId: string, runId: string) => void;
    clear: (projectId: string) => void;
}

export function createPreflightRunStore(): PreflightRunStore {
    const runs = new Map<string, PreflightRun>();
    return {
        put: (projectId, run) => { runs.set(projectId, run); },
        peek: (projectId) => runs.get(projectId),
        consume: (projectId, runId) => { if (runs.get(projectId)?.runId === runId) runs.delete(projectId); },
        clear: (projectId) => { runs.delete(projectId); },
    };
}

// ── The pure approve decision (never executes anything) ─────────────────────────────────────────────
// Takes NO exec/git seam at all — approving is a pure comparison of the stored run against the request.
// That absence is the structural mirror of pre-flight's never-advance: approve CANNOT run commands.
// stale=true means the fix is "re-run pre-flight" (run missing / superseded / draft changed on disk);
// stale=false failures are decision failures (unacked warns; slice ②: a blocked run).
export type ApprovalValidation = { ok: true } | { ok: false; stale: boolean; errors: string[] };

export function validateApproval(
    run: PreflightRun | undefined,
    req: { runId?: string; draftHashNow: string; acks: string[] },
): ApprovalValidation {
    if (!run) return { ok: false, stale: true, errors: ["no pre-flight run on record — run pre-flight again (or Skip pre-flight)"] };
    if (!req.runId || req.runId !== run.runId) {
        return { ok: false, stale: true, errors: ["this approval references a superseded pre-flight run — run pre-flight again"] };
    }
    if (req.draftHashNow !== run.draftHash) {
        return { ok: false, stale: true, errors: ["tasks.json changed since pre-flight ran — the verdicts no longer describe this draft; run pre-flight again"] };
    }
    // BLOCKED is never a pass: a run whose setup failed observed nothing, so there is nothing to consent to.
    // Not stale (a re-run against the same broken setup blocks again) — fix setupCommand or Skip pre-flight.
    if (run.report.blocked) {
        return { ok: false, stale: false, errors: ["pre-flight was BLOCKED — the project setupCommand failed in the throwaway worktree, so nothing was observed; fix setup (or Skip pre-flight)"] };
    }
    const unacked = unackedWarnCommands(run.report, req.acks);
    if (unacked.length) {
        return { ok: false, stale: false, errors: [`pre-flight has ${unacked.length} unacknowledged warning(s) — acknowledge each or Skip pre-flight:`, ...unacked] };
    }
    return { ok: true };
}
