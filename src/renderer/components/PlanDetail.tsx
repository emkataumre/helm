// src/renderer/components/PlanDetail.tsx
// M11 plan detail — PURE, prop-driven (react-dom/server-tested, data-verify stamped). The plans table earns its
// keep: the stored PRD (copied in at approve, so it survives the transient .helm/plan/ dir), the member tasks
// with their live statuses, and an N/M merged progress readout. Data is joined renderer-side (plans:get + the
// existing tasks list filtered by planId) — no new engine queries beyond the two reads.
import type { Plan, TaskListItem, TaskStatus } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const STATUS_COLOR: Record<TaskStatus, string> = {
    queued: "#788C5D", running: "#D97757", merged: "#788C5D", "needs-human": "#b00", abandoned: "#B0AC9F", "handed-off": "#D97757",
};

export function PlanDetail({ plan, tasks, onClose, onSelectTask }: {
    plan: Plan;
    tasks: TaskListItem[];         // the plan's member tasks (already filtered by planId, board order)
    onClose: () => void;
    onSelectTask?: (id: string) => void;
}) {
    const total = tasks.length;
    const merged = tasks.filter((t) => t.status === "merged").length;
    return (
        <div {...verifyAttrs({ unit: "PlanDetail", tasks: total, merged, progress: `${merged}/${total}` })} style={{ display: "grid", gap: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={onClose}>← board</button>
                <h2 style={{ fontFamily: "ui-serif, Georgia, serif", margin: 0 }}>Plan — {plan.title}</h2>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#788C5D" }}>{merged}/{total} merged</span>
            </div>

            <details open>
                <summary style={{ cursor: "pointer", fontFamily: "ui-serif, Georgia, serif" }}>PRD</summary>
                {plan.prdText.trim().length
                    ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "6px 0 0", maxHeight: 320, overflow: "auto", background: "#F0EEE6", padding: "8px 10px", borderRadius: 8 }}>{plan.prdText}</pre>
                    : <div style={{ color: "#888", fontSize: 12, marginTop: 6 }}>No PRD text was captured for this plan.</div>}
            </details>

            <section style={{ display: "grid", gap: 6 }}>
                <h3 style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, textTransform: "uppercase", color: "#788C5D", margin: 0 }}>Member tasks ({total})</h3>
                {total === 0 ? <div style={{ color: "#888", fontSize: 13 }}>This plan has no tasks.</div> : null}
                {tasks.map((t) => (
                    <div key={t.id} className="plan-member" onClick={() => onSelectTask?.(t.id)} style={{ border: "1px solid #E3DACC", borderRadius: 8, padding: 8, cursor: onSelectTask ? "pointer" : "default", display: "flex", justifyContent: "space-between", gap: 10 }}>
                        <span>{t.title}</span>
                        <code style={{ fontSize: 11, color: STATUS_COLOR[t.status] }}>{t.status}</code>
                    </div>
                ))}
            </section>
        </div>
    );
}
