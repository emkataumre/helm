// tests/verify/preflight/approve.ts
// The overhaul's approve-decision verify SURFACE (2026-07-14): drives the REAL runPreflight (fake deps) to
// produce a report, stores it in the REAL run store, then puts the REAL validateApproval through the
// scenario's request — and distils a flat ApproveRecording the invariants read.
//
// Non-circularity: the scenario DECLARES its ground truth (each command's scripted exit + static level +
// ack; whether the stored run matches the request) independently of the implementation. The invariants
// compare the ACTUAL decision against that declared truth. The headline structural property mirrors
// pre-flight's never-advance: the approve decision has NO exec/git seam at all — `ops` can only ever be
// non-empty in a hand-forged recording, and the probe proves the invariant would catch exactly that lie.
import { runPreflight, type PreflightDeps } from "../../../src/main/engine/preflight";
import { createPreflightRunStore, hashDraft, validateApproval } from "../../../src/main/engine/preflightStore";
import { mkProject, type CmdSpec } from "./surface";
import type { PlanDraft, PreflightVerdict } from "../../../src/shared/types";

export interface ApproveScenario {
    commands: CmdSpec[];
    runIdSent: "match" | "superseded" | "none";
    draftChangedOnDisk?: boolean; // tasks.json bytes at approve time differ from the run's
    noStoredRun?: boolean;        // the store is empty (a restart lost the in-memory run)
    doubleConfirm?: boolean;      // consume then validate again — the second Confirm must fail stale
}

export interface ApproveRecording {
    unit: "preflight-approve";
    ops: string[];            // exec/git ops observed DURING the decision — empty by construction
    decisionSync: boolean;    // the decision returned a plain object, not a Promise (nothing was awaited)
    hadRun: boolean;
    runIdMatched: boolean;
    hashMatched: boolean;
    declaredUnacked: number;  // ground truth: commands the DECLARED table says warn, minus the declared acks
    approved: boolean;
    stale: boolean;
    secondApproved: boolean | null; // doubleConfirm only
    secondStale: boolean | null;
}

// The DECLARED classification table (independent re-statement, same as invariants.ts) — used only to
// compute the ground-truth unacked count, never fed to the implementation.
const declaredWarn = (s: CmdSpec): boolean => (s.code === 0 && !s.timedOut) || s.code < 0 || s.staticLevel === "warn";

export async function runApproveScenario(scenario: ApproveScenario): Promise<ApproveRecording> {
    const specs = scenario.commands;
    const draft: PlanDraft = { planTitle: "d", tasks: [{ slug: "t1", title: "T1", intent: "i", acceptance: specs.map((s) => s.command), scopeHint: null, dependsOn: [] }] };
    const staticVerdicts: PreflightVerdict[] = specs.map((s) => ({ taskSlug: "t1", command: s.command, level: s.staticLevel ?? "ok" }));
    const deps: PreflightDeps = {
        ensureBranch: async () => {},
        revParse: async () => "abcdef0123456789abcdef0123456789abcdef01",
        createWorktree: async () => "/repo/.helm/worktrees/preflight",
        runSetup: async () => ({ ok: true, output: "" }),
        runCommand: async (_wt, command) => {
            const s = specs.find((x) => x.command === command)!;
            return { code: s.code, timedOut: s.timedOut ?? false, output: s.output ?? "" };
        },
        removeWorktree: async () => {},
        checkTimeoutMs: 1000,
    };
    const report = await runPreflight(mkProject(), draft, staticVerdicts, deps);

    const tasksJson = JSON.stringify(draft); // stands in for the on-disk bytes the run validated
    const store = createPreflightRunStore();
    if (!scenario.noStoredRun) {
        store.put("p1", { runId: "run-1", draftHash: hashDraft(tasksJson), integrationSha: report.integrationSha ?? "", report, createdAt: 0 });
    }

    const acks = specs.filter((s) => s.ack).map((s) => s.command);
    const req = {
        runId: scenario.runIdSent === "match" ? "run-1" : scenario.runIdSent === "superseded" ? "run-0" : undefined,
        draftHashNow: hashDraft(scenario.draftChangedOnDisk ? tasksJson + "\n// edited" : tasksJson),
        acks,
    };

    // The decision under test. NOTE: nothing is awaited — validateApproval is synchronous, which is the
    // structural proof that approving cannot execute a command (there is no seam and no async gap).
    const decision = validateApproval(store.peek("p1"), req);
    const decisionSync = !(decision as unknown instanceof Promise);
    const approved = decision.ok;
    const stale = !decision.ok && decision.stale;

    // The consume-on-success path (idempotent approve): a second Confirm against the same runId must find
    // nothing and fail stale — the elektronik-and-pant double-insert lesson.
    let secondApproved: boolean | null = null, secondStale: boolean | null = null;
    if (scenario.doubleConfirm && approved) {
        store.consume("p1", "run-1");
        const second = validateApproval(store.peek("p1"), req);
        secondApproved = second.ok;
        secondStale = !second.ok && second.stale;
    }

    return {
        unit: "preflight-approve",
        ops: [], // by construction: the decision has no exec/git seam (probes forge this to prove the catch)
        decisionSync,
        hadRun: !scenario.noStoredRun,
        runIdMatched: !scenario.noStoredRun && scenario.runIdSent === "match",
        hashMatched: !scenario.noStoredRun && !scenario.draftChangedOnDisk,
        declaredUnacked: specs.filter((s) => declaredWarn(s) && !s.ack).length,
        approved, stale, secondApproved, secondStale,
    };
}

// ── Invariants ──────────────────────────────────────────────────────────────────────────────────────
export interface ApproveInvariant { name: string; holds: (r: ApproveRecording) => true | string }

export const APPROVE_INVARIANTS: ApproveInvariant[] = [
    // The overhaul's headline: approve NEVER executes commands. The decision surface has no exec/git seam
    // and is fully synchronous — any recorded op, or an async decision, is a lie this invariant catches.
    {
        name: "approve-never-executes-commands",
        holds: (r) => {
            if (r.ops.length) return `the approve decision performed op(s): ${r.ops.join(", ")}`;
            if (!r.decisionSync) return "the approve decision was asynchronous — an await is a seam a command could hide behind";
            return true;
        },
    },
    // Staleness is load-bearing: a missing run, a superseded runId, or a draft edited on disk since the run
    // must ALL reject with stale=true (the renderer's cue to offer a re-run) — and never approve.
    {
        name: "stale-run-rejected",
        holds: (r) => {
            const fresh = r.hadRun && r.runIdMatched && r.hashMatched;
            if (fresh) return true;
            if (r.approved) return "approved against a stale run (missing / superseded / draft changed on disk)";
            if (!r.stale) return "a stale run was rejected without stale=true — the renderer cannot offer the re-run";
            return true;
        },
    },
    // The ack gate over the STORED report: approval is only possible with zero declared-unacked warns.
    {
        name: "approve-requires-acks",
        holds: (r) => (r.approved && r.declaredUnacked > 0 ? `approved despite ${r.declaredUnacked} unacknowledged warn(s)` : true),
    },
    // Consume-on-success: after a successful Confirm consumed the run, a second identical Confirm must fail
    // stale — double-clicking can never insert a plan twice.
    {
        name: "consume-prevents-double-approve",
        holds: (r) => {
            if (r.secondApproved == null) return true; // scenario didn't exercise the double-confirm path
            if (r.secondApproved) return "a second Confirm against a consumed run was approved (double-insert)";
            if (!r.secondStale) return "the second Confirm failed but not as stale — the renderer cannot recover";
            return true;
        },
    },
];

export interface ApproveInvariantResult { name: string; ok: boolean; detail?: string }
export function runApproveInvariants(r: ApproveRecording): ApproveInvariantResult[] {
    return APPROVE_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
