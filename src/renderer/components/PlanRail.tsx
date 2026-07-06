// src/renderer/components/PlanRail.tsx
// The M10 planner side rail — PURE, prop-driven, react-dom/server-tested (data-verify stamped). Three pieces
// composed by PlanRail: the 3-state stage tracker, a read-only collapsible PRD panel, and the draft task cards
// (each acceptance line carries its static pre-flight verdict ✓ / ⚠ + did-you-mean; dependsOn edges by slug).
// Parse errors are listed verbatim when the draft is invalid. Approve is disabled while parse-invalid or empty
// (static warns never disable — a task may legitimately create its own verify script; M11 adds the dynamic gate).
import type { PlanRailState, PlanStage, PreflightVerdict } from "../../shared/types";
import { verifyAttrs } from "./verifyAttrs";

const STAGES: PlanStage[] = ["conversing", "prd", "tasks"];
const STAGE_LABELS: Record<PlanStage, string> = { conversing: "Conversing", prd: "PRD drafted", tasks: "Tasks drafted" };

// The three observable states, in order; the active one is marked with a distinct visible suffix ("◂ now") so
// it's unambiguously readable (the accept harness reads the flip conversing → prd → tasks off the DOM text).
export function PlanStageTracker({ stage }: { stage: PlanStage }) {
    const idx = STAGES.indexOf(stage);
    return (
        <div {...verifyAttrs({ unit: "PlanStageTracker", stage })} style={{ display: "flex", gap: 14, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
            {STAGES.map((s, i) => (
                <span key={s} style={{ fontWeight: s === stage ? 700 : 400, color: i <= idx ? "#141413" : "#B0AC9F" }}>
                    {i <= idx ? "●" : "○"} {STAGE_LABELS[s]}{s === stage ? " ◂ now" : ""}
                </span>
            ))}
        </div>
    );
}

// Read-only PRD, collapsed by default (native <details> so the SSR render test needs no React state). Raw
// markdown fallback (the M3 progress.md approach — this is not the place to parse markdown).
function PlanPrdPanel({ prdText }: { prdText: string | null }) {
    return (
        <details {...verifyAttrs({ unit: "PlanPrdPanel", available: prdText != null })}>
            <summary style={{ cursor: "pointer", fontFamily: "ui-serif, Georgia, serif" }}>PRD {prdText == null ? "(none drafted yet)" : ""}</summary>
            {prdText != null
                ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: "6px 0 0", maxHeight: 220, overflow: "auto" }}>{prdText}</pre>
                : <div style={{ color: "#888", fontSize: 12, marginTop: 6 }}>No PRD drafted yet — run the pipeline in the session, or write .helm/plan/prd.md.</div>}
        </details>
    );
}

const intentPreview = (s: string): string => (s.length > 160 ? s.slice(0, 157) + "…" : s);

// The draft task cards (valid draft) OR the verbatim parse errors (invalid) OR a placeholder (no tasks.json).
export function PlanDraftCards({ parse, verdicts }: { parse: PlanRailState["parse"]; verdicts: PreflightVerdict[] }) {
    if (parse == null) {
        return <div {...verifyAttrs({ unit: "PlanDraftCards", state: "none" })} style={{ color: "#888", fontSize: 13 }}>No tasks drafted yet.</div>;
    }
    if (!parse.ok) {
        return (
            <div {...verifyAttrs({ unit: "PlanDraftCards", state: "invalid", errors: parse.errors.length })}>
                <div style={{ color: "#b00", fontWeight: 600, fontSize: 13 }}>tasks.json has {parse.errors.length} problem{parse.errors.length === 1 ? "" : "s"} — fix it in the session:</div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {parse.errors.map((e, i) => <li key={i} style={{ color: "#b00", fontSize: 12 }}>{e}</li>)}
                </ul>
            </div>
        );
    }
    const byTask = new Map<string, PreflightVerdict[]>();
    for (const v of verdicts) (byTask.get(v.taskSlug) ?? byTask.set(v.taskSlug, []).get(v.taskSlug)!).push(v);
    const warnCount = verdicts.filter((v) => v.level === "warn").length;
    return (
        <div {...verifyAttrs({ unit: "PlanDraftCards", state: "valid", tasks: parse.draft.tasks.length, warns: warnCount })} style={{ display: "grid", gap: 8 }}>
            {parse.draft.tasks.map((t) => {
                const vs = byTask.get(t.slug) ?? [];
                return (
                    <div key={t.slug} className="plan-draft-card" style={{ border: "1.5px solid #E3DACC", borderRadius: 10, padding: 10 }}>
                        <div><b>{t.title}</b> <code style={{ fontSize: 11, color: "#788C5D" }}>{t.slug}</code></div>
                        <div style={{ fontSize: 12, color: "#555", margin: "3px 0" }}>{intentPreview(t.intent)}</div>
                        <ul style={{ margin: "4px 0", paddingLeft: 18, listStyle: "none" }}>
                            {t.acceptance.map((cmd, i) => {
                                const v = vs.find((x) => x.command === cmd);
                                const warn = v?.level === "warn";
                                return (
                                    <li key={i} style={{ color: warn ? "#b00" : "#788C5D", fontSize: 12 }}>
                                        {warn ? "⚠" : "✓"} <code>{cmd}</code>
                                        {warn && v?.suggestion ? <span> — did you mean <code>npm run {v.suggestion}</code>?</span> : null}
                                        {warn && v && !v.suggestion && v.reason ? <span> — {v.reason}</span> : null}
                                    </li>
                                );
                            })}
                        </ul>
                        {t.dependsOn.length ? <div style={{ fontSize: 12, color: "#788C5D" }}>depends on: {t.dependsOn.join(", ")}</div> : null}
                    </div>
                );
            })}
        </div>
    );
}

// The composite rail. Approve is enabled iff the draft parses AND has ≥1 task; static warns never disable it.
export function PlanRail({ state, onApprove }: { state: PlanRailState; onApprove: () => void }) {
    const taskCount = state.parse?.ok ? state.parse.draft.tasks.length : 0;
    const canApprove = state.parse?.ok === true && taskCount > 0;
    return (
        <div {...verifyAttrs({ unit: "PlanRail", stage: state.stage, "can-approve": canApprove, tasks: taskCount })} style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <PlanStageTracker stage={state.stage} />
            <PlanPrdPanel prdText={state.prdText} />
            <PlanDraftCards parse={state.parse} verdicts={state.verdicts} />
            <button disabled={!canApprove} onClick={onApprove} title={canApprove ? "Queue these tasks (resolving dependency edges)" : "Approve is disabled until tasks.json parses with at least one task"}>
                Approve → queue{taskCount ? ` (${taskCount})` : ""}
            </button>
        </div>
    );
}
