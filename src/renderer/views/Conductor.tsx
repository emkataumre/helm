// src/renderer/views/Conductor.tsx
// Conductor tab (M16 — the M10 planner pane absorbed): the project's ONE persistent interactive
// claude session (real TerminalPane over the conductor PTY) beside the live rail — stage tracker,
// PRD, draft cards with static verdicts, and the M11 two-phase approval (run pre-flight → ack every
// ⚠ → confirm; Skip is an explicit, confirmed escape). Any plan:changed resets the gate so a stale
// report can't be confirmed; the ipc re-validates everything from disk anyway — the gate is UX
// honesty (§8.7). New in M16: without a live session the pane offers [Resume conductor] (enabled iff
// the recorded session is actually resumable — the M5 guard, re-checked main-side) beside
// [Fresh session]; persistence is the CONVERSATION (via --resume), not the PTY process.
import { useEffect, useState } from "react";
import type { PlanDraftTask, PlanRailState, PlanStage, PreflightCommandVerdict, PreflightReport, PreflightVerdict, Project, PtySession } from "../../shared/types";
import { Badge, Button, Checkbox, Icon, IconButton, ProgressBar } from "../ds";
import type { IconName } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { TerminalPane } from "../components/TerminalPane";
import { ConfirmDialog, EmptyState, Mono, Overline } from "./helpers";

/* ---------- stage indicator ---------- */
const STAGES: Array<{ id: PlanStage; label: string }> = [
    { id: "conversing", label: "conversing" },
    { id: "prd", label: "prd drafted" },
    { id: "tasks", label: "tasks drafted" },
];
export function StageRail({ stage }: { stage: PlanStage }) {
    const idx = STAGES.findIndex((s) => s.id === stage);
    return (
        <div className="helm-stage" {...verifyAttrs({ unit: "StageRail", stage })}>
            {STAGES.map((s, i) => (
                <span key={s.id} style={{ display: "contents" }}>
                    {i > 0 && <span className="bar"></span>}
                    <span className={"seg " + (i < idx ? "done" : i === idx ? "now" : "")}>
                        <Icon name={i < idx ? "CircleCheck" : i === idx ? "CircleDot" : "Circle"} size={12} />
                        {s.label}
                    </span>
                </span>
            ))}
        </div>
    );
}

/* ---------- verdict line for a draft acceptance command (static pre-flight) ---------- */
function VerdictLine({ cmd, verdict }: { cmd: string; verdict?: PreflightVerdict }) {
    const warn = verdict?.level === "warn";
    return (
        <div style={{ display: "flex", gap: 7, alignItems: "flex-start", fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", lineHeight: 1.5 }}>
            <Icon name={warn ? "TriangleAlert" : "Check"} size={12} style={{ color: warn ? "var(--amber-400)" : "var(--green-400)", flex: "none", marginTop: 1 }} />
            <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--ink-160)", overflowWrap: "anywhere" }}>{cmd}</div>
                {warn && <div style={{ color: "var(--amber-300)" }}>{verdict?.reason}{verdict?.suggestion ? <span> — did you mean <b>npm run {verdict.suggestion}</b>? fix it in the session</span> : null}</div>}
            </div>
        </div>
    );
}

/* ---------- draft task card ---------- */
function DraftCard({ card, verdicts }: { card: PlanDraftTask; verdicts: PreflightVerdict[] }) {
    return (
        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 10, boxShadow: "var(--elev-card)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <Mono dim size="var(--text-2xs)">{card.slug}</Mono>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, flex: 1 }}>{card.title}</span>
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>{card.intent}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {card.acceptance.map((a) => <VerdictLine key={a} cmd={a} verdict={verdicts.find((v) => v.taskSlug === card.slug && v.command === a)} />)}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {card.scopeHint && <Badge variant="neutral">{card.scopeHint}</Badge>}
                {card.dependsOn.map((d) => <Badge key={d} variant="outline"><Icon name="GitBranch" size={10} style={{ display: "inline-block", marginRight: 4, verticalAlign: -1 }} />{d}</Badge>)}
            </div>
        </div>
    );
}

/* ---------- dynamic pre-flight report (§3.10) ---------- */
const PRE_META: Record<PreflightCommandVerdict["level"], { color: string; icon: IconName; label: string; hint: string }> = {
    "ok-red": { color: "var(--green-400)", icon: "CircleCheck", label: "expected red", hint: "fails before any work exists — this proof can gate the task" },
    "warn-already-green": { color: "var(--amber-400)", icon: "TriangleAlert", label: "already green", hint: "passes before any work — it cannot prove the task" },
    "warn-missing": { color: "var(--amber-400)", icon: "TriangleAlert", label: "could not run", hint: "missing script/tool — the task may legitimately create it" },
};
// The confirm gate's one number: warn verdicts not yet acknowledged. Exported so the panel,
// the Confirm button, and the verify slice all read the same rule.
export function unackedWarns(report: PreflightReport, acks: string[]): number {
    return report.verdicts.filter((r) => r.level !== "ok-red" && !acks.includes(r.command)).length;
}

export function PreflightReportPanel({ report, acks, onAck }: {
    report: PreflightReport;
    acks: string[];
    onAck: (command: string) => void;
}) {
    const [openCmd, setOpenCmd] = useState<string | null>(null);
    const unacked = unackedWarns(report, acks);
    return (
        <div {...verifyAttrs({ unit: "PreflightReport", commands: report.verdicts.length, warns: report.warnCount, unacked })} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {report.verdicts.map((row) => {
                const m = PRE_META[row.level];
                const isWarn = row.level !== "ok-red";
                return (
                    <div key={row.command} style={{ border: "1px solid " + (isWarn ? "color-mix(in oklab, var(--amber-500) 30%, transparent)" : "var(--border-subtle)"), borderRadius: 8, background: isWarn ? "var(--tint-warning)" : "var(--surface-card)", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Icon name={m.icon} size={13} style={{ color: m.color, flex: "none" }} />
                            <Mono style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{row.command}</Mono>
                            <Mono dim size="var(--text-2xs)" style={{ color: m.color, whiteSpace: "nowrap" }}>{m.label} · exit {row.exitCode ?? "—"}</Mono>
                            <IconButton size="sm" label="Show output tail" onClick={() => setOpenCmd(openCmd === row.command ? null : row.command)}>
                                <Icon name={openCmd === row.command ? "ChevronUp" : "ChevronDown"} size={12} />
                            </IconButton>
                        </div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>
                            {m.hint} · used by {row.taskSlugs.join(", ")}
                        </div>
                        {openCmd === row.command && <div className="helm-well">{row.tail || "(no output)"}</div>}
                        {isWarn && (
                            <Checkbox checked={acks.includes(row.command)} onChange={() => onAck(row.command)}
                                label={<span style={{ fontSize: "var(--text-xs)" }}>I understand — {row.reason ?? m.hint}{row.suggestion ? ` (did you mean npm run ${row.suggestion}?)` : ""}</span>} />
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ---------- conductor launch panel (no live session) ---------- */
// The two-button launch contract (spec §4): [Resume conductor] enabled IFF the recorded session is
// actually resumable (main re-checks the guard on launch — this enablement is UX honesty), beside the
// always-available [Fresh session]. Pure + prop-driven so the render tests probe both states.
export function ConductorLaunch({ project, resumable, onLaunch }: {
    project: Project;
    resumable: boolean;
    onLaunch: (fresh: boolean) => void;
}) {
    return (
        <div {...verifyAttrs({ unit: "ConductorLaunch", resumable })} style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <EmptyState icon="Anchor"
                line={`The conductor is ${project.name}'s single persistent claude session — plan (including from GitHub issues), ask "where are we?" (it reads the fleet via helm status), and steer, all in conversation. Resume continues the recorded conversation; Fresh starts a new one.`}
                action={
                    <div style={{ display: "flex", gap: 8 }}>
                        <Button variant="primary" disabled={!resumable} iconLeft={<Icon name="Play" size={14} />} onClick={() => onLaunch(false)}>Resume conductor</Button>
                        <Button variant="secondary" iconLeft={<Icon name="Plus" size={14} />} onClick={() => onLaunch(true)}>Fresh session</Button>
                    </div>
                } />
        </div>
    );
}

/* ---------- conductor tab ---------- */
export function ConductorTab({ project, session, rail, resumable, onHydrate, onLaunch, onApproved }: {
    project: Project;
    session: PtySession | null;
    rail: PlanRailState | undefined;
    resumable: boolean;
    onHydrate: () => void;        // read-only conductor:open — refresh session/rail/resumable; spawns nothing
    onLaunch: (fresh: boolean) => void;
    onApproved: (count: number, warnings: string[], skipped: boolean) => void;
}) {
    const [preflight, setPreflight] = useState<PreflightReport | "loading" | null>(null);
    const [acks, setAcks] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [confirmSkip, setConfirmSkip] = useState(false);

    // Hydrate on mount / project switch: pick up a still-alive session, the rail state, and the
    // resume-guard verdict. Read-only (conductor:open never spawns), so mounting the tab is free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { onHydrate(); }, [project.id]);

    // Any plan:changed (a fresh rail-state object per fire) means the draft may have changed —
    // reset the gate so a stale report/ack set can't be confirmed (the M11 rule).
    useEffect(() => { setPreflight(null); setAcks([]); setError(null); }, [rail]);

    if (!session || !rail) {
        return <ConductorLaunch project={project} resumable={resumable} onLaunch={onLaunch} />;
    }

    const draft = rail.parse?.ok ? rail.parse.draft : null;
    const parseErrors = rail.parse && !rail.parse.ok ? rail.parse.errors : null;
    const report = preflight !== null && preflight !== "loading" ? preflight : null;
    const unacked = report ? unackedWarns(report, acks) : 0;
    const uniqueCommands = draft ? new Set(draft.tasks.flatMap((c) => c.acceptance)).size : 0;

    const runPreflight = async () => {
        setPreflight("loading"); setError(null);
        try {
            const r = await window.helm.preflightPlan(project.id);
            if (r.ok) setPreflight(r.report);
            else { setPreflight(null); setError(r.errors.join(" · ")); }
        } catch (err) {
            setPreflight(null); setError(`pre-flight failed: ${(err as Error)?.message ?? String(err)}`);
        }
    };
    const approve = async (skip: boolean) => {
        try {
            const r = await window.helm.approvePlan(project.id, skip ? { skipPreflight: true } : { acks, skipPreflight: false });
            if (r.ok) { setPreflight(null); setAcks([]); onApproved(r.count, r.warnings, skip); }
            else setError(r.errors.join(" · "));
        } catch (err) { setError(`approve failed: ${(err as Error)?.message ?? String(err)}`); }
    };

    return (
        <div {...verifyAttrs({ unit: "ConductorTab", stage: rail.stage, "parse-ok": rail.parse ? rail.parse.ok : null, unacked: report ? unacked : null })} style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            {/* the live conductor session */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Overline>conductor — {project.repoPath}</Overline>
                    <span style={{ flex: 1 }}></span>
                    <Mono dim size="var(--text-2xs)">closing the tab keeps it alive</Mono>
                </div>
                <div style={{ flex: 1, minHeight: 320 }}>
                    <TerminalPane key={session.id} session={session} />
                </div>
            </div>

            {/* the rail */}
            <div style={{ width: 400, flex: "none", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", minHeight: 0, paddingBottom: 8 }}>
                <StageRail stage={rail.stage} />
                {error ? <div className="helm-failure">{error}</div> : null}

                {rail.prdText ? (
                    <details open={!draft} style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 10, boxShadow: "var(--elev-card)" }}>
                        <summary style={{ padding: "10px 12px", cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                            <Icon name="FileText" size={14} style={{ display: "inline-block", color: "var(--amber-400)" }} /> PRD draft
                        </summary>
                        <div className="helm-well" style={{ margin: "0 12px 12px", maxHeight: 220, overflowY: "auto" }}>{rail.prdText}</div>
                    </details>
                ) : (
                    <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>The session is still conversing — the PRD and task drafts appear here as files land.</div>
                )}

                {parseErrors && (
                    <div {...verifyAttrs({ unit: "DraftErrors", errors: parseErrors.length })}>
                        <div style={{ color: "var(--red-400)", fontWeight: 600, fontSize: "var(--text-sm)" }}>tasks.json has {parseErrors.length} problem{parseErrors.length === 1 ? "" : "s"} — fix it in the session:</div>
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {parseErrors.map((e, i) => <li key={i} style={{ color: "var(--red-400)", fontSize: "var(--text-xs)" }}>{e}</li>)}
                        </ul>
                    </div>
                )}

                {draft && (
                    <>
                        <Overline>draft tasks — {draft.tasks.length} · fix problems in the session, not here</Overline>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {draft.tasks.map((c) => <DraftCard key={c.slug} card={c} verdicts={rail.verdicts} />)}
                        </div>

                        {/* two-phase approval */}
                        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: 10, boxShadow: "var(--elev-card)", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                            <Overline>approval</Overline>
                            {preflight === null && (
                                <>
                                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                        Pre-flight runs every unique acceptance command once in a throwaway worktree, proving each proof can actually gate its task.
                                    </div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <Button variant="primary" iconLeft={<Icon name="ShieldCheck" size={14} />} onClick={() => void runPreflight()}>Run pre-flight</Button>
                                        <Button variant="ghost" onClick={() => setConfirmSkip(true)}>Skip pre-flight &amp; queue</Button>
                                    </div>
                                </>
                            )}
                            {preflight === "loading" && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <ProgressBar indeterminate size="sm" tone="primary" />
                                    <Mono dim size="var(--text-2xs)">executing {uniqueCommands} unique command{uniqueCommands === 1 ? "" : "s"} in a throwaway worktree…</Mono>
                                </div>
                            )}
                            {report && (
                                <>
                                    <PreflightReportPanel report={report} acks={acks} onAck={(cmd) => setAcks((a) => (a.includes(cmd) ? a.filter((c) => c !== cmd) : [...a, cmd]))} />
                                    <Button variant="primary" disabled={unacked > 0} iconLeft={<Icon name="Check" size={14} />} onClick={() => void approve(false)}>
                                        {unacked > 0 ? `Confirm & queue — ${unacked} warning${unacked > 1 ? "s" : ""} unacknowledged` : `Confirm & queue ${draft.tasks.length} tasks`}
                                    </Button>
                                </>
                            )}
                        </div>
                    </>
                )}

                <ConfirmDialog open={confirmSkip} title="Skip pre-flight?"
                    body="The proofs will not be exercised before queueing. Unrunnable or already-green acceptance commands will only surface once agents start burning budget."
                    confirmLabel="Skip & queue" danger onConfirm={() => void approve(true)} onClose={() => setConfirmSkip(false)} />
            </div>
        </div>
    );
}
