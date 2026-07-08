// src/renderer/views/Plans.tsx
// Plans browser: a project's approved plans (newest first) with their durable PRDs and
// member tasks (joined renderer-side by planId). Ported from the design's PlansTab.
import { useContext, useEffect, useState } from "react";
import type { Plan, Project } from "../../shared/types";
import { Button, Icon } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { ActionCtx, EmptyState, Mono, Overline, StatusChip, fmtDiffstat, timeAgo, type TaskVM } from "./helpers";

export function PlansTab({ project, plans, tasks, initialPlanId, onFilterBoard }: {
    project: Project;
    plans: Plan[];
    tasks: TaskVM[];
    initialPlanId?: string | null; // deep-link from a task's inspector plan link
    onFilterBoard: (planId: string) => void;
}) {
    const actions = useContext(ActionCtx);
    const myPlans = plans.filter((p) => p.projectId === project.id).sort((a, b) => b.createdAt - a.createdAt);
    const [sel, setSel] = useState<string | null>(initialPlanId ?? null);
    useEffect(() => { if (initialPlanId) setSel(initialPlanId); }, [initialPlanId]);
    const selected = myPlans.find((p) => p.id === (sel ?? myPlans[0]?.id));

    if (!myPlans.length) return <EmptyState icon="Map" line="No plans yet. Approve a planner draft and it lands here with its PRD." />;
    const members = selected ? tasks.filter((t) => t.planId === selected.id) : [];
    return (
        <div {...verifyAttrs({ unit: "PlansTab", plans: myPlans.length, selected: selected?.id ?? null, members: members.length, merged: members.filter((t) => t.status === "merged").length })} style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            <div style={{ width: 250, flex: "none", display: "flex", flexDirection: "column", gap: 8 }}>
                {myPlans.map((p) => (
                    <div key={p.id} onClick={() => setSel(p.id)}
                        style={{ padding: "10px 12px", borderRadius: 10, cursor: "pointer", border: "1px solid " + (selected && p.id === selected.id ? "color-mix(in oklab, var(--amber-500) 35%, transparent)" : "var(--border-subtle)"), background: selected && p.id === selected.id ? "var(--surface-selected)" : "var(--surface-card)" }}>
                        <div style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>{p.title}</div>
                        <Mono dim size="var(--text-2xs)">{timeAgo(p.createdAt)} · {tasks.filter((t) => t.planId === p.id).length} tasks</Mono>
                    </div>
                ))}
            </div>
            {selected && (
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0, paddingBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <h2 style={{ margin: 0, font: "var(--role-heading)" }}>{selected.title}</h2>
                        <span style={{ flex: 1 }}></span>
                        <Button size="sm" variant="ghost" iconLeft={<Icon name="Filter" size={13} />} onClick={() => onFilterBoard(selected.id)}>Narrow board to this plan</Button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {members.map((t) => (
                            <div key={t.id} onClick={() => actions.openTask(t.id)}
                                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 8, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", cursor: "pointer", fontSize: "var(--text-sm)" }}>
                                <StatusChip status={t.blocked ? "blocked" : t.status} />
                                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                                {t.diffstat && <Mono dim size="var(--text-2xs)">{fmtDiffstat(t.diffstat)}</Mono>}
                            </div>
                        ))}
                    </div>
                    <Overline>prd — stored durably at approval</Overline>
                    <div className="helm-well" style={{ flex: "none" }}>{selected.prdText || "(empty PRD — none was drafted at approval)"}</div>
                </div>
            )}
        </div>
    );
}
