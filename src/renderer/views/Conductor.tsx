// src/renderer/views/Conductor.tsx
// Conductor tab (M16 — the M10 planner pane absorbed): the project's ONE persistent interactive
// claude session (real TerminalPane over the conductor PTY) beside the live rail — stage tracker,
// PRD, draft cards with static verdicts, and the M11 two-phase approval (run pre-flight → ack every
// ⚠ → confirm; Skip is an explicit, confirmed escape). Any plan:changed resets the gate so a stale
// report can't be confirmed; the ipc re-validates everything from disk anyway — the gate is UX
// honesty (§8.7). New in M16: without a live session the pane offers [Resume conductor] (enabled iff
// the recorded session is actually resumable — the M5 guard, re-checked main-side) beside
// [Fresh session]; persistence is the CONVERSATION (via --resume), not the PTY process.
import { useEffect, useRef, useState } from "react";
import type { PlanDraftTask, PlanRailState, PlanStage, PreflightCommandVerdict, PreflightProgress, PreflightReport, PreflightVerdict, Project, PtySession } from "../../shared/types";
import { isWarnLevel } from "../../shared/types";
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

/* ---------- parse-failure list (one draft's tasks.json problems, verbatim) ---------- */
function DraftErrors({ errors }: { errors: string[] }) {
    return (
        <div {...verifyAttrs({ unit: "DraftErrors", errors: errors.length })}>
            <div style={{ color: "var(--red-400)", fontWeight: 600, fontSize: "var(--text-sm)" }}>tasks.json has {errors.length} problem{errors.length === 1 ? "" : "s"} — fix it in the session:</div>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {errors.map((e, i) => <li key={i} style={{ color: "var(--red-400)", fontSize: "var(--text-xs)" }}>{e}</li>)}
            </ul>
        </div>
    );
}

/* ---------- plan-queue rail (the multi-draft seam) ---------- */
// The renderer's twin of main's NamedPlanRailState (planWatcher.buildPlanQueueState): the SAME rail
// contract, once per draft — name null = the anonymous loose-root draft, a string = a <slug>/ subdir
// draft. Structural copy because shared/types is outside this slice; the queue-push ipc slice hoists it.
export type NamedPlanRailState = PlanRailState & { name: string | null };

// Approve-all's order: the parse-ok drafts, in SET ORDER (the order drafts arrive from the multi-draft
// read — loose root first, then <slug>/ drafts sorted). A draft that doesn't parse is skipped, never
// blocking its siblings. Exported for the render tests (the order is behavior, not markup).
export function queueApproveOrder(drafts: NamedPlanRailState[]): Array<string | null> {
    return drafts.filter((d) => d.parse?.ok).map((d) => d.name);
}

// One draft of the set: its own tasks (with THEIR static verdicts), its own parse errors, its own
// Approve. A draft that doesn't parse offers NO approval path — same rule as the single face.
function QueuedDraftCard({ draft, approving, onApprove }: {
    draft: NamedPlanRailState;
    approving: boolean;
    onApprove: (name: string | null) => void;
}) {
    const parsed = draft.parse?.ok ? draft.parse.draft : null;
    const errors = draft.parse && !draft.parse.ok ? draft.parse.errors : null;
    const warns = draft.verdicts.filter((v) => v.level === "warn").length;
    return (
        <div {...verifyAttrs({ unit: "QueuedDraftCard", name: draft.name ?? "(root)", "parse-ok": draft.parse ? draft.parse.ok : null, tasks: parsed ? parsed.tasks.length : null, warns })}
            style={{ background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: 10, boxShadow: "var(--elev-card)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <Mono dim size="var(--text-2xs)">{draft.name ?? "(root)"}</Mono>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 500, flex: 1 }}>{parsed ? parsed.planTitle : errors ? "tasks.json invalid" : "still drafting"}</span>
            </div>
            {errors && <DraftErrors errors={errors} />}
            {parsed && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {parsed.tasks.map((c) => <DraftCard key={c.slug} card={c} verdicts={draft.verdicts} />)}
                </div>
            )}
            {!parsed && !errors && <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>waiting for this draft's tasks.json…</div>}
            {parsed && (
                <Button variant="primary" disabled={approving} iconLeft={<Icon name="Check" size={14} />} onClick={() => onApprove(draft.name)}>
                    Approve — queue {parsed.tasks.length} task{parsed.tasks.length === 1 ? "" : "s"}
                </Button>
            )}
        </div>
    );
}

// The side rail's draft area, multi-draft (plan-queue). One card per draft, each with its own static
// verdicts and its own Approve (THE authority); [Approve all (in set order)] is a convenience that just
// invokes the per-draft approvals in set order. Back-compat is a rendering rule, not a wiring rule: a
// single anonymous loose-root draft — the only shape main pushes pre-queue — renders EXACTLY as today
// (errors list / task cards, no per-draft chrome), so shipping the seam changes nothing live.
export function PlanQueueRail({ drafts, approving, onApprove }: {
    drafts: NamedPlanRailState[];  // in set order: the loose root first, then <slug>/ drafts sorted
    approving: boolean;
    onApprove: (name: string | null) => void;
}) {
    if (!drafts.length) return null;
    if (drafts.length === 1 && drafts[0].name === null) {
        const d = drafts[0];
        const parsed = d.parse?.ok ? d.parse.draft : null;
        const errors = d.parse && !d.parse.ok ? d.parse.errors : null;
        if (!parsed && !errors) return null; // still conversing — nothing drafted, nothing to render
        return (
            <div {...verifyAttrs({ unit: "PlanQueueRail", drafts: 1, single: true })} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {errors && <DraftErrors errors={errors} />}
                {parsed && (
                    <>
                        <Overline>draft tasks — {parsed.tasks.length} · fix problems in the session, not here</Overline>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {parsed.tasks.map((c) => <DraftCard key={c.slug} card={c} verdicts={d.verdicts} />)}
                        </div>
                    </>
                )}
            </div>
        );
    }
    const order = queueApproveOrder(drafts);
    return (
        <div {...verifyAttrs({ unit: "PlanQueueRail", drafts: drafts.length, single: false, approvable: order.length, order: order.map((n) => n ?? "(root)").join("¦") })}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Overline>draft set — {drafts.length} drafts · per-draft Approve is the authority</Overline>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {drafts.map((d) => <QueuedDraftCard key={d.name ?? "(root)"} draft={d} approving={approving} onApprove={onApprove} />)}
            </div>
            {drafts.length >= 2 && (
                <Button variant="secondary" disabled={approving || order.length === 0} iconLeft={<Icon name="ListTodo" size={14} />}
                    onClick={() => { for (const name of queueApproveOrder(drafts)) onApprove(name); }}>
                    Approve all (in set order)
                </Button>
            )}
        </div>
    );
}

/* ---------- dynamic pre-flight report (§3.10; role-aware vocabulary 2026-07-14) ---------- */
const PRE_META: Record<PreflightCommandVerdict["level"], { color: string; icon: IconName; label: string; hint: string }> = {
    "ok-red": { color: "var(--green-400)", icon: "CircleCheck", label: "expected red", hint: "fails before any work exists — this proof can gate the task" },
    "ok-pass": { color: "var(--green-400)", icon: "CircleCheck", label: "suite green", hint: "a standing regression gate — green before the work is exactly right" },
    "ok-planned": { color: "var(--green-400)", icon: "CircleDot", label: "planned proof", hint: "doesn't exist yet — this task declares it will create it" },
    "warn-already-green": { color: "var(--amber-400)", icon: "TriangleAlert", label: "already green", hint: "passes before any work — it cannot prove the task" },
    "warn-missing": { color: "var(--amber-400)", icon: "TriangleAlert", label: "could not run", hint: "missing script/tool — the task may legitimately create it" },
    "warn-tip-red": { color: "var(--amber-400)", icon: "TriangleAlert", label: "tip is red", hint: "a standing suite FAILS on the integration tip — the tip itself is broken" },
    "warn-no-proof": { color: "var(--amber-400)", icon: "TriangleAlert", label: "no proof", hint: "no command can prove this task — done and not-started look identical to the gate" },
};
// The confirm gate's one number: warn verdicts not yet acknowledged. Reads the SHARED isWarnLevel rule
// (types.ts) so this counter can never disagree with the engine's ack gate. Exported for the render tests.
export function unackedWarns(report: PreflightReport, acks: string[]): number {
    return report.verdicts.filter((r) => isWarnLevel(r.level) && !acks.includes(r.command)).length;
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
                const isWarn = isWarnLevel(row.level);
                return (
                    <div key={row.command} style={{ border: "1px solid " + (isWarn ? "color-mix(in oklab, var(--amber-500) 30%, transparent)" : "var(--border-subtle)"), borderRadius: 8, background: isWarn ? "var(--tint-warning)" : "var(--surface-card)", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <Icon name={m.icon} size={13} style={{ color: m.color, flex: "none" }} />
                            <Mono style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{row.level === "warn-no-proof" ? `${row.taskSlugs[0]} — no proof command` : row.command}</Mono>
                            <Mono dim size="var(--text-2xs)" style={{ color: m.color, whiteSpace: "nowrap" }}>{m.label} · exit {row.exitCode ?? "—"}{row.timedOut ? " · timed out" : ""}</Mono>
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

/* ---------- always-on in-pane restart (issue #1 — the dead-session wedge) ---------- */
// The `pwsh -NoExit` wrapper (the M5 resilient-shell contract) keeps the conductor pwsh alive after
// `claude` exits, so the pane never falls back to the launch panel — the user is stranded at a dead shell
// showing claude's "Resume this session with…" message, with no button. This IS the button: always present
// in the live pane's header, a compact ⟳ menu that KILLS the pwsh and respawns — Resume (continue the
// recorded conversation; disabled unless the guard holds, mirroring the launch panel's Resume) or Fresh
// (a new conversation). Opening the menu is itself the two-step guard against an accidental restart of a
// healthy session. Pure + prop-driven; the menu markup is ALWAYS rendered (hidden when closed) so the
// render tests can probe the guard's face on the Resume item without driving interaction.
export function RestartControl({ resumable, onRestart }: {
    resumable: boolean;
    onRestart: (fresh: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const pick = (fresh: boolean) => { setOpen(false); onRestart(fresh); };
    // Close on outside-click / Escape via a document listener (the Dialog's pattern). A fixed-position
    // click-away backdrop was tried first and did NOT work: an ancestor (`.helm-fade-in` on the ProjectView
    // root) animates `transform`, which establishes a containing block + stacking context that buries the
    // backdrop so it never receives the click — the menu was un-closeable. A window listener is
    // stacking-context-agnostic. Only mounted while open; the ref scopes "inside" to the trigger + menu.
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
    }, [open]);
    return (
        <div ref={ref} {...verifyAttrs({ unit: "RestartControl", resumable, open })} style={{ position: "relative", flex: "none" }}>
            <IconButton size="sm" label="Restart conductor" active={open} onClick={() => setOpen((o) => !o)}>
                <Icon name="RefreshCw" size={13} /><Icon name="ChevronDown" size={10} style={{ marginLeft: 1 }} />
            </IconButton>
            {/* Visibility is driven by inline `display`, NOT the `hidden` attribute: an inline `display`
                overrides the UA `[hidden]{display:none}` rule, so `hidden` here would be a no-op and the
                menu would show permanently (the "not closeable" bug). display:none still leaves the markup
                in the DOM, so the render tests can probe the guard's face on the Resume item. */}
            <div role="menu" style={{ display: open ? "flex" : "none", position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 50, minWidth: 210, flexDirection: "column", gap: 2, padding: 4, background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: 10, boxShadow: "var(--elev-card)" }}>
                <Button variant="ghost" fullWidth disabled={!resumable} iconLeft={<Icon name="Play" size={13} />} style={{ justifyContent: "flex-start" }} onClick={() => pick(false)}>
                    Resume conductor{resumable ? "" : " — no persisted session"}
                </Button>
                <Button variant="ghost" fullWidth iconLeft={<Icon name="Plus" size={13} />} style={{ justifyContent: "flex-start" }} onClick={() => pick(true)}>
                    Fresh session
                </Button>
            </div>
        </div>
    );
}

/* ---------- conductor tab ---------- */
export function ConductorTab({ project, session, rail, resumable, onHydrate, onLaunch, onRestart, onApproved }: {
    project: Project;
    session: PtySession | null;
    rail: PlanRailState | undefined;
    resumable: boolean;
    onHydrate: () => void;        // read-only conductor:open — refresh session/rail/resumable; spawns nothing
    onLaunch: (fresh: boolean) => void;
    onRestart: (fresh: boolean) => void; // kill the live conductor pwsh + respawn (the dead-session escape)
    onApproved: (count: number, warnings: string[], skipped: boolean) => void;
}) {
    const [preflight, setPreflight] = useState<PreflightReport | "loading" | null>(null);
    const [runId, setRunId] = useState<string | null>(null);
    const [progress, setProgress] = useState<PreflightProgress | null>(null);
    const [approving, setApproving] = useState(false);
    const [acks, setAcks] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [confirmSkip, setConfirmSkip] = useState(false);

    // Hydrate on mount / project switch: pick up a still-alive session, the rail state, and the
    // resume-guard verdict. Read-only (conductor:open never spawns), so mounting the tab is free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { onHydrate(); }, [project.id]);

    // Reset the gate when the draft CONTENT changes (overhaul, 2026-07-14). The old effect keyed on the
    // rail OBJECT — a fresh object per plan:changed fire — so watcher noise / tab-switch hydration wiped
    // the report, the acks, AND the error explaining what happened. Content-keyed, a no-op fire keeps
    // your acked panel; a real edit still resets it. Staleness is enforced server-side regardless (the
    // stored run's draft hash) — this reset is UX honesty, not the safety mechanism.
    const draftKey = rail?.parse ? (rail.parse.ok ? "ok:" + JSON.stringify(rail.parse.draft) : "err:" + rail.parse.errors.join("¦")) : "none";
    const draftEpoch = useRef(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { draftEpoch.current++; setPreflight(null); setRunId(null); setProgress(null); setAcks([]); setError(null); }, [draftKey]);

    // Per-command progress while a run grinds (filtered to this project; unsubscribes on unmount).
    useEffect(() => window.helm.onPreflightProgress((pid, p) => { if (pid === project.id) setProgress(p); }), [project.id]);

    if (!session || !rail) {
        return <ConductorLaunch project={project} resumable={resumable} onLaunch={onLaunch} />;
    }

    const draft = rail.parse?.ok ? rail.parse.draft : null;
    const report = preflight !== null && preflight !== "loading" ? preflight : null;
    const unacked = report ? unackedWarns(report, acks) : 0;
    const uniqueCommands = draft ? new Set(draft.tasks.flatMap((c) => c.acceptance)).size : 0;

    const runPreflight = async () => {
        setPreflight("loading"); setProgress(null); setError(null);
        // If the draft changes while the run is in flight, the reset effect bumps the epoch — a report for
        // a draft that no longer exists is dropped rather than rendered (approve would reject it anyway).
        const epoch = draftEpoch.current;
        try {
            const r = await window.helm.preflightPlan(project.id);
            if (epoch !== draftEpoch.current) return;
            if (r.ok) { setPreflight(r.report); setRunId(r.runId); }
            else { setPreflight(null); setError(r.errors.join(" · ")); }
        } catch (err) {
            if (epoch !== draftEpoch.current) return;
            setPreflight(null); setError(`pre-flight failed: ${(err as Error)?.message ?? String(err)}`);
        } finally { setProgress(null); }
    };
    const approve = async (skip: boolean) => {
        setApproving(true); setError(null);
        try {
            const r = await window.helm.approvePlan(project.id, skip ? { skipPreflight: true } : { runId: runId ?? undefined, acks, skipPreflight: false });
            if (r.ok) { setPreflight(null); setRunId(null); setAcks([]); onApproved(r.count, r.warnings, skip); }
            else if (r.stale) { setPreflight(null); setRunId(null); setAcks([]); setError(r.errors.join(" · ")); }
            else setError(r.errors.join(" · "));
        } catch (err) { setError(`approve failed: ${(err as Error)?.message ?? String(err)}`); }
        finally { setApproving(false); }
    };

    return (
        <div {...verifyAttrs({ unit: "ConductorTab", stage: rail.stage, "parse-ok": rail.parse ? rail.parse.ok : null, unacked: report ? unacked : null })} style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
            {/* the live conductor session */}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Overline>conductor — {project.repoPath}</Overline>
                    <span style={{ flex: 1 }}></span>
                    <Mono dim size="var(--text-2xs)">closing the tab keeps it alive</Mono>
                    <RestartControl resumable={resumable} onRestart={onRestart} />
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

                {/* the draft area, via the multi-draft seam (plan-queue). Main still pushes ONE anonymous
                    rail state, so live this is always the single loose-root face — today's errors list /
                    task cards, byte-for-byte, with no per-draft chrome. The queue-push ipc slice hands the
                    full NamedPlanRailState[] straight through and routes onApprove per draft name; until
                    then the root draft's authority stays the two-phase box below (the single face renders
                    no per-draft Approve button, so this onApprove is unreachable live). */}
                <PlanQueueRail drafts={[{ name: null, ...rail }]} approving={approving} onApprove={() => void approve(false)} />

                {draft && (
                    <>
                        {/* two-phase approval */}
                        <div style={{ background: "var(--surface-card)", border: "1px solid var(--border-default)", borderRadius: 10, boxShadow: "var(--elev-card)", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                            <Overline>approval</Overline>
                            {preflight === null && (
                                <>
                                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", lineHeight: 1.5 }}>
                                        Pre-flight runs every unique acceptance command once in a throwaway worktree, proving each proof can actually gate its task.
                                    </div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <Button variant="primary" disabled={approving} iconLeft={<Icon name="ShieldCheck" size={14} />} onClick={() => void runPreflight()}>Run pre-flight</Button>
                                        <Button variant="ghost" disabled={approving} onClick={() => setConfirmSkip(true)}>{approving ? "Queueing…" : "Skip pre-flight & queue"}</Button>
                                    </div>
                                </>
                            )}
                            {preflight === "loading" && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <ProgressBar indeterminate size="sm" tone="primary" />
                                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <Mono dim size="var(--text-2xs)" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                                            {progress ? `command ${progress.index + 1}/${progress.total} — ${progress.command}` : `executing ${uniqueCommands} unique command${uniqueCommands === 1 ? "" : "s"} in a throwaway worktree…`}
                                        </Mono>
                                        <Button variant="ghost" onClick={() => void window.helm.cancelPreflight(project.id)}>Cancel</Button>
                                    </div>
                                </div>
                            )}
                            {report && report.blocked && (
                                <>
                                    {/* BLOCKED is never a pass: setup failed, nothing was observed, no ack path exists. */}
                                    <div className="helm-failure" {...verifyAttrs({ unit: "PreflightBlocked" })}>
                                        pre-flight BLOCKED — the project setupCommand failed in the throwaway worktree, so nothing was observed. Fix setup, or Skip pre-flight.
                                    </div>
                                    <div className="helm-well">{report.blocked.setupTail || "(no output)"}</div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <Button variant="primary" disabled={approving} iconLeft={<Icon name="ShieldCheck" size={14} />} onClick={() => void runPreflight()}>Run pre-flight again</Button>
                                        <Button variant="ghost" disabled={approving} onClick={() => setConfirmSkip(true)}>Skip pre-flight &amp; queue</Button>
                                    </div>
                                </>
                            )}
                            {report && !report.blocked && (
                                <>
                                    {report.integrationSha && <Mono dim size="var(--text-2xs)">validated against integration tip {report.integrationSha.slice(0, 12)}</Mono>}
                                    <PreflightReportPanel report={report} acks={acks} onAck={(cmd) => setAcks((a) => (a.includes(cmd) ? a.filter((c) => c !== cmd) : [...a, cmd]))} />
                                    <Button variant="primary" disabled={unacked > 0 || approving} iconLeft={<Icon name="Check" size={14} />} onClick={() => void approve(false)}>
                                        {approving ? "Queueing…" : unacked > 0 ? `Confirm & queue — ${unacked} warning${unacked > 1 ? "s" : ""} unacknowledged` : `Confirm & queue ${draft.tasks.length} tasks`}
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
