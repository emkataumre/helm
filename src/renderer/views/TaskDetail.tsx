// src/renderer/views/TaskDetail.tsx
// Task detail: Feed / Iterations / progress.md tabs + the 340px inspector rail.
// Ported from the Claude Design handoff (app/detail.jsx) onto TaskVM + window.helm:
// the feed and iteration series come off the task's EngineSnapshot (live, or rebuilt
// from DB rows with an empty feed after a restart), progress.md is fetched on demand.
import { useContext, useEffect, useRef, useState } from "react";
import type { ActivityEntry, Plan, Project } from "../../shared/types";
import { Icon, IconButton, MetricStat, ProgressBar, StatusDot, Tabs } from "../ds";
import type { IconName } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { parseProgress } from "../progress";
import {
    ActionCtx, CopyCmd, EmptyState, FailureBox, FeedLine, GATE_TONE_COLOR, MergeChip, Mono, Overline, PhaseChip,
    StatusChip, VerbBar, chipStatusOf, fmtDur, fmtTok, fmtUsd, gateToneOf, mergePhaseOf, parseDiffstat, stuckOf, timeAgo, type TaskVM,
} from "./helpers";
import { Button } from "../ds";

/* ---------- progress.md (four known headings, raw fallback — src/renderer/progress.ts) ---------- */
export function ProgressView({ md }: { md: string | null }) {
    if (md == null) return <EmptyState icon="FileText" line="No progress file — the worktree is gone." />;
    const parsed = parseProgress(md);
    if (!parsed.ok || !parsed.sections) {
        return <div {...verifyAttrs({ unit: "ProgressView", ok: false })} className="helm-well" style={{ margin: 16 }}>{parsed.raw}</div>;
    }
    const iconFor: Record<string, IconName> = { "Current focus": "Crosshair", "Done": "Check", "Remaining": "ListTodo", "Tried & ruled out": "Ban" };
    const cards: Array<[string, string]> = [
        ["Current focus", parsed.sections.currentFocus],
        ["Done", parsed.sections.done],
        ["Remaining", parsed.sections.remaining],
        ["Tried & ruled out", parsed.sections.triedAndRuledOut],
    ];
    return (
        <div {...verifyAttrs({ unit: "ProgressView", ok: true })} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, padding: 16 }}>
            {cards.map(([head, body]) => (
                <div key={head} style={{ background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 10, boxShadow: "var(--elev-card)", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                    <Overline style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Icon name={iconFor[head] ?? "FileText"} size={12} /> {head}
                    </Overline>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                        {body.replace(/^- /gm, "· ")}
                    </div>
                </div>
            ))}
        </div>
    );
}

/* ---------- iterations table ---------- */
export function IterationsTable({ task }: { task: TaskVM }) {
    const [openIdx, setOpenIdx] = useState<number | null>(null);
    const snap = task.snap;
    const iterations = snap?.iterations ?? [];
    // History = every settled attempt (a verdict landed); the in-flight one renders as the live row.
    const settled = iterations.filter((it) => it.verdict != null);
    const cur = snap?.currentIteration ?? null;
    if (!settled.length && !cur) return <EmptyState icon="RefreshCw" line="No iterations yet." />;
    return (
        <table className="helm-ittable" {...verifyAttrs({ unit: "IterationsTable", count: settled.length, live: !!cur })}>
            <thead>
                <tr><th style={{ width: 36 }}>#</th><th style={{ width: 130 }}>verdict</th><th>commit</th><th>tokens</th><th>cost</th><th>duration</th><th style={{ width: 30 }}></th></tr>
            </thead>
            <tbody>
                {cur && (
                    <tr>
                        <td>{cur.index}</td>
                        <td><PhaseChip phase={cur.phase} /></td>
                        <td colSpan={4}><span className="helm-activity" style={{ color: "var(--text-secondary)" }}>{cur.latestActivity || "…"}<span className="helm-live-caret"></span></span></td>
                        <td></td>
                    </tr>
                )}
                {[...settled].reverse().flatMap((it) => {
                    const row = (
                        <tr key={it.index} className={it.outputTail ? "expandable" : ""} onClick={() => it.outputTail && setOpenIdx(openIdx === it.index ? null : it.index)}>
                            <td>{it.index}</td>
                            <td>{it.verdict ? <StatusChip status={it.verdict} /> : null}</td>
                            <td>{it.commitSha ? it.commitSha.slice(0, 10) : "—"}</td>
                            <td>{fmtTok(it.tokens.input)} in · {fmtTok(it.tokens.output)} out</td>
                            <td>{fmtUsd(it.tokens.costUsd)}</td>
                            <td>{it.durationMs != null ? fmtDur(it.durationMs) : "—"}</td>
                            <td>{it.outputTail && <Icon name={openIdx === it.index ? "ChevronUp" : "ChevronDown"} size={13} style={{ color: "var(--text-faint)" }} />}</td>
                        </tr>
                    );
                    if (openIdx !== it.index || !it.outputTail) return [row];
                    return [row, (
                        <tr key={it.index + "-tail"}><td colSpan={7} style={{ padding: "4px 12px 12px" }}>
                            <div className="helm-well">{it.outputTail}</div>
                            {it.sessionId === null && <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-faint)" }}>no persisted session — this turn cannot be resumed</div>}
                        </td></tr>
                    )];
                })}
            </tbody>
        </table>
    );
}

/* ---------- live feed — grouped by iteration, gate verdicts dominant ---------- */
// Consecutive-run grouping (not a global bucket): the feed is chronological, and if an
// iteration index ever reappears the on-screen order must stay the order it happened.
export interface FeedGroup { iteration: number; entries: ActivityEntry[] }
export function groupFeed(feed: ActivityEntry[]): FeedGroup[] {
    const groups: FeedGroup[] = [];
    for (const e of feed) {
        const last = groups[groups.length - 1];
        if (last && last.iteration === e.iterationIndex) last.entries.push(e);
        else groups.push({ iteration: e.iterationIndex, entries: [e] });
    }
    return groups;
}

// Split one group's entries into gate lines (always visible) and the chatter runs
// between them (assistant + tool-use — dimmed, drill-in).
type FeedSegment = { gate: ActivityEntry } | { chatter: ActivityEntry[] };
function feedSegments(entries: ActivityEntry[]): FeedSegment[] {
    const segs: FeedSegment[] = [];
    for (const e of entries) {
        if (e.kind === "gate") { segs.push({ gate: e }); continue; }
        const last = segs[segs.length - 1];
        if (last && "chatter" in last) last.chatter.push(e);
        else segs.push({ chatter: [e] });
    }
    return segs;
}

// A gate verdict (check ✓/✗, acceptance, merge) — the feed's dominant element.
export function FeedGateLine({ entry }: { entry: ActivityEntry }) {
    const tone = gateToneOf(entry.text);
    const color = GATE_TONE_COLOR[tone];
    const icon: IconName = entry.text.startsWith("merge") ? "GitMerge" : tone === "fail" ? "OctagonAlert" : "ShieldCheck";
    return (
        <div className="helm-fade-in" {...verifyAttrs({ unit: "FeedGateLine", tone })} style={{
            display: "flex", alignItems: "center", gap: 8, margin: "3px 14px", padding: "6px 10px",
            border: `1px solid color-mix(in oklab, ${color} 45%, transparent)`,
            background: `color-mix(in oklab, ${color} 10%, transparent)`,
            borderRadius: 8, color, fontSize: "var(--text-xs)", fontWeight: 600,
        }}>
            <Icon name={icon} size={14} style={{ flex: "none" }} />
            <span style={{ minWidth: 0 }}>{entry.text}</span>
        </div>
    );
}

// A run of assistant/tool-use chatter — collapsed by default (drill-in); only the live
// tail of a running task starts open, and it folds shut when the next verdict lands.
export function FeedChatter({ entries, live }: { entries: ActivityEntry[]; live?: boolean }) {
    const tools = entries.filter((e) => e.kind === "tool-use").length;
    return (
        <details open={live || undefined} {...verifyAttrs({ unit: "FeedChatter", count: entries.length, collapsed: !live, dimmed: true })}>
            <summary style={{ cursor: "pointer", padding: "3px 14px", color: "var(--text-faint)", fontSize: "var(--text-2xs)" }}>
                {entries.length} step{entries.length === 1 ? "" : "s"} · {tools} tool call{tools === 1 ? "" : "s"}
            </summary>
            <div style={{ opacity: 0.7 }}>
                {entries.map((e, i) => <FeedLine key={i} entry={e} />)}
            </div>
        </details>
    );
}

function FeedIterationSection({ group, liveTail }: { group: FeedGroup; liveTail: boolean }) {
    const segs = feedSegments(group.entries);
    const gates = group.entries.filter((e) => e.kind === "gate").length;
    return (
        <section {...verifyAttrs({ unit: "FeedGroup", iteration: group.iteration, gates, chatter: group.entries.length - gates })}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px 4px" }}>
                <Overline style={{ color: "var(--text-faint)", whiteSpace: "nowrap" }}>iteration {group.iteration}</Overline>
                <div style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
            </div>
            {segs.map((s, i) => "gate" in s
                ? <FeedGateLine key={i} entry={s.gate} />
                : <FeedChatter key={i} entries={s.chatter} live={liveTail && i === segs.length - 1} />)}
        </section>
    );
}

export function FeedView({ task }: { task: TaskVM }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const feed = task.snap?.feed ?? [];
    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [feed.length]);
    if (!feed.length) {
        return (
            <EmptyState icon="ScrollText"
                line={task.status === "running" ? "Feed is filling as the agent works." : "The live feed does not survive restarts — history lives in Iterations."} />
        );
    }
    const groups = groupFeed(feed);
    return (
        <div ref={ref} className="helm-feed helm-scroll" {...verifyAttrs({ unit: "FeedView", count: feed.length, groups: groups.length })} style={{ flex: 1 }}>
            {groups.map((g, i) => <FeedIterationSection key={i} group={g} liveTail={task.status === "running" && i === groups.length - 1} />)}
        </div>
    );
}

/* ---------- inspector ---------- */
export function Inspector({ task, project, tasksById, plans }: {
    task: TaskVM;
    project: Project;
    tasksById: Record<string, TaskVM>;
    plans: Plan[];
}) {
    const actions = useContext(ActionCtx);
    const plan = task.planId ? plans.find((p) => p.id === task.planId) : undefined;
    const deps = task.dependsOn.map((id) => tasksById[id]).filter(Boolean);
    const cap = project.iterationCap ?? 8;
    const snap = task.snap;
    const totals = snap?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
    // The token-accounting invariant (M3): the displayed totals must equal the sum of the
    // iteration series — stamped machine-readably so a drift is verifiable off the DOM.
    const sumOut = (snap?.iterations ?? []).reduce((a, it) => a + it.tokens.output, 0);
    const consistent = totals.output === sumOut;
    const attempt = snap?.currentIteration ? snap.currentIteration.index + 1 : snap?.iterations.length ?? 0;
    const d = task.diffstat ? parseDiffstat(task.diffstat) : null;
    return (
        <div className="helm-inspector helm-scroll" {...verifyAttrs({ unit: "Inspector", output: totals.output, consistent })}>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 18 }}>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                    <MetricStat label="iterations" value={String(attempt)} unit={"/ " + cap} />
                    <MetricStat label="cost" value={fmtUsd(totals.costUsd)} unit={"/ $" + (project.costCapUsd ?? 25)} />
                    <MetricStat label="tokens" value={fmtTok(totals.input + totals.output)} />
                </div>

                <section style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <Overline>intent</Overline>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{task.intent}</div>
                </section>

                <section style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    <Overline>acceptance — the per-task gate</Overline>
                    {task.acceptance.map((a, i) => <CopyCmd key={i} cmd={a} />)}
                    {task.scopeHint && <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--text-muted)" }}>scope: {task.scopeHint}</div>}
                </section>

                {deps.length > 0 && (
                    <section style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                        <Overline>depends on</Overline>
                        {deps.map((p) => (
                            <a key={p.id} onClick={() => actions.openTask(p.id)} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--text-sm)", cursor: "pointer", color: "var(--text-secondary)", textDecoration: "none" }}>
                                <StatusDot status={p.status} size={6} /> {p.title}
                            </a>
                        ))}
                        {stuckOf(task) && (
                            <Button size="sm" variant="outline" iconLeft={<Icon name="Unlink" size={13} />} onClick={() => actions.clearDeps(task)}>Clear dependencies</Button>
                        )}
                    </section>
                )}

                <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <Overline style={{ marginBottom: 4 }}>plumbing</Overline>
                    <dl className="helm-kv">
                        <dt>project</dt><dd><Mono>{project.name}</Mono></dd>
                        {task.branchName && <><dt>branch</dt><dd><Mono>{task.branchName}</Mono></dd></>}
                        {task.worktreePath && <><dt>worktree</dt><dd><Mono>{task.worktreePath}</Mono></dd></>}
                        {task.diffstat && (
                            <><dt>diffstat</dt><dd><Mono>{d
                                ? <><span style={{ color: "var(--green-400)" }}>+{d.plus}</span> <span style={{ color: "var(--red-400)" }}>−{d.minus}</span> · {d.files} files</>
                                : task.diffstat}</Mono></dd></>
                        )}
                        <dt>plan</dt>
                        <dd>{plan
                            ? <a onClick={() => actions.openPlan(plan.projectId, plan.id)} style={{ cursor: "pointer", fontSize: "var(--text-sm)" }}>{plan.title}</a>
                            : <Mono dim>hand-made</Mono>}</dd>
                        {project.jailImage && <><dt>jail</dt><dd><Mono>{project.jailImage}</Mono></dd></>}
                        <dt>created</dt><dd><Mono dim>{timeAgo(task.createdAt)}</Mono></dd>
                        <dt>updated</dt><dd><Mono dim>{timeAgo(task.updatedAt)}</Mono></dd>
                    </dl>
                </section>

                <section style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <Overline style={{ marginBottom: 4 }}>bounds</Overline>
                    <dl className="helm-kv">
                        <dt>iter cap</dt><dd><Mono dim>{cap}</Mono></dd>
                        <dt>no-progress</dt><dd><Mono dim>{project.noProgressK ?? 2} iterations</Mono></dd>
                        <dt>stall</dt><dd><Mono dim>{project.stallTimeoutMin ?? 40} min</Mono></dd>
                        <dt>cost cap</dt><dd><Mono dim>${project.costCapUsd ?? 25}</Mono></dd>
                        <dt>model</dt><dd><Mono dim>{project.model ?? "cli default"}</Mono></dd>
                    </dl>
                </section>
            </div>
        </div>
    );
}

/* ---------- task detail ---------- */
export function TaskDetail({ task, project, tasksById, plans, onBack }: {
    task: TaskVM;
    project: Project;
    tasksById: Record<string, TaskVM>;
    plans: Plan[];
    onBack: () => void;
}) {
    const [tab, setTab] = useState("feed");
    const [progressMd, setProgressMd] = useState<string | null>(null);
    // progress.md is a worktree file — fetch when the tab opens, and refresh per task.
    useEffect(() => {
        if (tab !== "progress") return;
        let live = true;
        void window.helm.getProgress(task.id).then((md) => { if (live) setProgressMd(md); });
        return () => { live = false; };
    }, [tab, task.id, task.updatedAt]);
    useEffect(() => { setTab("feed"); setProgressMd(null); }, [task.id]);

    const feedCount = task.snap?.feed.length ?? 0;
    const iterCount = task.snap?.iterations.filter((i) => i.verdict != null).length ?? 0;
    const mergePhase = mergePhaseOf(task);
    return (
        <div className="helm-content helm-fade-in" {...verifyAttrs({ unit: "TaskDetail", id: task.id, status: task.status, "merge-phase": mergePhase })} style={{ height: "100%" }}>
            <div style={{ padding: "14px var(--pad-view) 0", display: "flex", flexDirection: "column", gap: 12, borderBottom: "1px solid var(--border-subtle)", background: "var(--surface-app)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <IconButton size="sm" label="Back" onClick={onBack}><Icon name="ArrowLeft" size={15} /></IconButton>
                    <h1 style={{ margin: 0, font: "var(--role-title)", letterSpacing: "var(--tracking-tight)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</h1>
                    {mergePhase && <MergeChip phase={mergePhase} />}
                    <StatusChip status={chipStatusOf(task)} />
                    <VerbBar task={task} size="md" />
                </div>
                {/* needs-human always explains itself; handed-off can carry a surfaced launch error
                    (e.g. "terminal launch failed: …") that must not be swallowed. */}
                {(task.status === "needs-human" || task.status === "handed-off") && <FailureBox reason={task.failureReason} />}
                {task.validating && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1 }}><ProgressBar indeterminate size="sm" tone="primary" /></div>
                        <Mono dim size="var(--text-2xs)">verify &amp; merge — re-validating against integration tip…</Mono>
                    </div>
                )}
                <Tabs value={tab} onChange={setTab} items={[
                    { id: "feed", label: "Feed", icon: <Icon name="ScrollText" size={14} />, count: feedCount || undefined },
                    { id: "iterations", label: "Iterations", icon: <Icon name="RefreshCw" size={14} />, count: iterCount || undefined },
                    { id: "progress", label: "progress.md", icon: <Icon name="FileText" size={14} /> },
                ]} />
            </div>
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, overflowY: tab === "feed" ? "hidden" : "auto" }}>
                    {tab === "feed" && <FeedView task={task} />}
                    {tab === "iterations" && <IterationsTable task={task} />}
                    {tab === "progress" && <ProgressView md={progressMd} />}
                </div>
                <Inspector task={task} project={project} tasksById={tasksById} plans={plans} />
            </div>
        </div>
    );
}
