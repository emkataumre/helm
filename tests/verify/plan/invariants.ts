// tests/verify/plan/invariants.ts
// The three M10 safety invariants — pure predicates over the PlanApprovalRecording. Each returns `true` or a
// human-readable violation string; runPlanInvariants wraps them so a predicate that THROWS becomes a failed
// check, never a silent pass ("when in doubt, FAIL").
import type { PlanApprovalRecording } from "./surface";

export interface PlanInvariant { name: string; holds: (r: PlanApprovalRecording) => true | string; }
export interface InvariantResult { name: string; ok: boolean; detail?: string }

export const PLAN_INVARIANTS: PlanInvariant[] = [
    // No task/plan rows are ever produced from a parse-invalid draft — the whole point of re-validating at
    // approve. A failed parse ⟹ no plan row AND no task inserts.
    {
        name: "approve-only-valid",
        holds: (r) => {
            if (r.parseOk) return true;
            if (r.planInserted) return "parse failed but a plan row was inserted";
            if (r.inserts.length > 0) return `parse failed but ${r.inserts.length} task insert(s) were produced`;
            return true;
        },
    },
    // Every emitted dependency edge points at a REAL sibling id, and that parent appears STRICTLY EARLIER in
    // the insert list — i.e. the inserts are a valid topological order. A cyclic draft cannot satisfy this
    // (some edge must point forward), so a "parsed ok" cycle is caught here.
    {
        name: "dep-slugs-resolve-acyclic",
        holds: (r) => {
            const idAt = new Map(r.inserts.map((ins, idx) => [ins.id, idx]));
            for (let idx = 0; idx < r.inserts.length; idx++) {
                for (const dep of r.inserts[idx].dependsOn) {
                    const parentIdx = idAt.get(dep);
                    if (parentIdx === undefined) return `task ${r.inserts[idx].id} depends on ${dep}, which is not an emitted task id`;
                    if (parentIdx >= idx) return `task ${r.inserts[idx].id} (pos ${idx}) depends on ${dep} (pos ${parentIdx}) — not a valid topological order (cycle?)`;
                }
            }
            return true;
        },
    },
    // §6 extended to the planner entry path: every inserted task carries a non-empty acceptance array of
    // non-empty commands (proof commands are mandatory, never optional).
    {
        name: "acceptance-mandatory-preserved",
        holds: (r) => {
            for (const ins of r.inserts) {
                if (!Array.isArray(ins.acceptance) || ins.acceptance.length === 0) return `task ${ins.id} has no acceptance commands`;
                if (!ins.acceptance.every((c) => typeof c === "string" && c.trim().length > 0)) return `task ${ins.id} has a blank acceptance command`;
            }
            return true;
        },
    },
];

export function runPlanInvariants(r: PlanApprovalRecording): InvariantResult[] {
    return PLAN_INVARIANTS.map((inv) => {
        try {
            const verdict = inv.holds(r);
            return verdict === true ? { name: inv.name, ok: true } : { name: inv.name, ok: false, detail: verdict };
        } catch (err) {
            return { name: inv.name, ok: false, detail: `threw: ${(err as Error)?.message ?? String(err)}` };
        }
    });
}
