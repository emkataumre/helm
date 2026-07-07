// src/renderer/components/PlanRail.tsx
// The M10 planner side rail — PURE, prop-driven, react-dom/server-tested (data-verify stamped). Three pieces
// composed by PlanRail: the 3-state stage tracker, a read-only collapsible PRD panel, and the draft task cards
// (each acceptance line carries its static pre-flight verdict ✓ / ⚠ + did-you-mean; dependsOn edges by slug).
// Parse errors are listed verbatim when the draft is invalid. Approve is disabled while parse-invalid or empty
// (static warns never disable — a task may legitimately create its own verify script; M11 adds the dynamic gate).
import type { PlanRailState, PlanStage, PreflightVerdict, PlanDraft, PreflightReport, PreflightCommandVerdict, PreflightLevel } from "../../shared/types";
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

// ── M11 dynamic pre-flight verdict panel ────────────────────────────────────────────────────────────
// Presentational (data-verify stamped). One card per draft task; each acceptance command carries its DYNAMIC
// verdict — ok-red ✓ (the expected TDD-red gate), warn-already-green ⚠, warn-missing ⚠ (with the static
// did-you-mean) — plus a short evidence tail. Every ⚠ carries an ack checkbox; Confirm unlocks only when every
// warn is acked. Acks are keyed by COMMAND (the deduped unit), so a command shared across tasks acks once.
const LEVEL_LABEL: Record<PreflightLevel, string> = { "ok-red": "red (expected)", "warn-already-green": "already green", "warn-missing": "missing" };
const isWarnLevel = (l: PreflightLevel): boolean => l === "warn-missing" || l === "warn-already-green";
const previewTail = (s: string): string => (s.length > 400 ? s.slice(-400) : s);

export function PreflightVerdictPanel({ draft, report, acks, onToggleAck }: {
    draft: PlanDraft;
    report: PreflightReport;
    acks: string[];
    onToggleAck: (command: string) => void;
}) {
    const byCommand = new Map<string, PreflightCommandVerdict>();
    for (const v of report.verdicts) byCommand.set(v.command, v);
    const acked = new Set(acks);
    const warnCommands = report.verdicts.filter((v) => isWarnLevel(v.level)).map((v) => v.command);
    const ackedWarns = warnCommands.filter((c) => acked.has(c)).length;
    const canConfirm = report.warnCount === 0 || warnCommands.every((c) => acked.has(c));
    return (
        <div {...verifyAttrs({ unit: "PreflightVerdictPanel", verdicts: report.verdicts.length, warns: report.warnCount, acked: ackedWarns, "can-confirm": canConfirm })} style={{ display: "grid", gap: 8 }}>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, textTransform: "uppercase", color: "#788C5D" }}>
                Pre-flight — {report.warnCount === 0 ? "no warnings" : `${ackedWarns}/${warnCommands.length} warnings acknowledged`}
            </div>
            {draft.tasks.map((t) => (
                <div key={t.slug} className="preflight-task-card" style={{ border: "1.5px solid #E3DACC", borderRadius: 10, padding: 10 }}>
                    <div><b>{t.title}</b> <code style={{ fontSize: 11, color: "#788C5D" }}>{t.slug}</code></div>
                    <ul style={{ margin: "4px 0", paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
                        {t.acceptance.map((cmd, i) => {
                            const v = byCommand.get(cmd);
                            if (!v) return null;
                            const warn = isWarnLevel(v.level);
                            return (
                                <li key={i} style={{ fontSize: 12, color: warn ? "#b00" : "#788C5D" }}>
                                    <div>{warn ? "⚠" : "✓"} <b>{LEVEL_LABEL[v.level]}</b> <code>{cmd}</code></div>
                                    {v.level === "warn-missing" && v.suggestion ? <div style={{ color: "#555" }}>— did you mean <code>npm run {v.suggestion}</code>?</div> : null}
                                    {v.level === "warn-missing" && !v.suggestion && v.reason ? <div style={{ color: "#555" }}>— {v.reason}</div> : null}
                                    {v.tail ? <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, margin: "3px 0 0", maxHeight: 96, overflow: "auto", color: "#3D3D3A", background: "#F0EEE6", padding: "4px 6px", borderRadius: 6 }}>{previewTail(v.tail)}</pre> : null}
                                    {warn ? (
                                        <label style={{ display: "flex", gap: 6, alignItems: "center", color: "#141413", marginTop: 2 }}>
                                            <input type="checkbox" checked={acked.has(cmd)} onChange={() => onToggleAck(cmd)} />
                                            {v.level === "warn-already-green" ? "I accept this gate is weak (passes before any work)" : "I accept this — the task will create it"}
                                        </label>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
        </div>
    );
}

// The composite rail — now TWO-PHASE (M11). Phase 1: a valid draft shows [Run pre-flight] (+ a small Skip
// escape). Phase 2: once a report lands, the verdict panel replaces the draft cards and [Confirm → queue]
// unlocks only when every warn is acked. `preflight` is null (pending) | "loading" | the report. Parse-invalid
// still hard-blocks (Run pre-flight is disabled). `data-verify-phase` makes the phase readable in render tests.
export function PlanRail({ state, preflight, acks, onRunPreflight, onSkip, onToggleAck, onConfirm }: {
    state: PlanRailState;
    preflight: PreflightReport | "loading" | null;
    acks: string[];
    onRunPreflight: () => void;
    onSkip: () => void;
    onToggleAck: (command: string) => void;
    onConfirm: () => void;
}) {
    const taskCount = state.parse?.ok ? state.parse.draft.tasks.length : 0;
    const canApprove = state.parse?.ok === true && taskCount > 0;
    const hasReport = preflight !== null && preflight !== "loading";
    const report = hasReport ? (preflight as PreflightReport) : null;
    const phase = !hasReport ? (preflight === "loading" ? "loading" : "pending") : "ready";
    const warnCommands = report ? report.verdicts.filter((v) => isWarnLevel(v.level)).map((v) => v.command) : [];
    const canConfirm = report !== null && (report.warnCount === 0 || warnCommands.every((c) => acks.includes(c)));
    return (
        <div {...verifyAttrs({ unit: "PlanRail", stage: state.stage, "can-approve": canApprove, tasks: taskCount, phase })} style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <PlanStageTracker stage={state.stage} />
            <PlanPrdPanel prdText={state.prdText} />
            {report && state.parse?.ok
                ? <PreflightVerdictPanel draft={state.parse.draft} report={report} acks={acks} onToggleAck={onToggleAck} />
                : <PlanDraftCards parse={state.parse} verdicts={state.verdicts} />}

            {preflight === "loading" ? <div style={{ fontSize: 12, color: "#788C5D" }}>Running pre-flight in a throwaway worktree off the integration tip…</div> : null}

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {report ? (
                    <button disabled={!canConfirm} onClick={onConfirm} title={canConfirm ? "Queue these tasks (resolving dependency edges)" : "Acknowledge every ⚠ warning to confirm"}>
                        Confirm → queue{taskCount ? ` (${taskCount})` : ""}
                    </button>
                ) : (
                    <button disabled={!canApprove || preflight === "loading"} onClick={onRunPreflight} title={canApprove ? "Execute each acceptance command once in a throwaway worktree" : "Pre-flight is disabled until tasks.json parses with at least one task"}>
                        Run pre-flight{taskCount ? ` (${taskCount})` : ""}
                    </button>
                )}
                <button disabled={!canApprove || preflight === "loading"} onClick={onSkip} style={{ fontSize: 12, color: "#788C5D" }} title="Queue without running pre-flight (you stay in control)">
                    Skip pre-flight
                </button>
            </div>
        </div>
    );
}
