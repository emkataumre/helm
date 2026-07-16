// src/renderer/views/helpers.tsx
// Shared cockpit atoms + the operator verb list — ported from the Claude Design handoff
// (app/helpers.jsx) onto the real window.helm data plane. The design's derived flags
// (blocked / waitingOn) come straight off TaskListItem (the ipc computes them); `stuck`
// is derived here exactly like the engine's cockpit rule: a parent needs-human/abandoned.
import { createContext, Fragment, useContext, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ActivityEntry, EngineSnapshot, TaskListItem, TaskStatus } from "../../shared/types";
import { Button, Dialog, Icon, IconButton, Input, StatusDot, StatusPill, Tooltip } from "../ds";
import type { IconName, LedStatus } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";

/* ---------- the per-task view model: the DB row + its live/rebuilt snapshot ---------- */
export interface TaskVM extends TaskListItem {
    snap: EngineSnapshot | null;
    validating: boolean; // renderer-local: a verify-&-merge is in flight for this task
    // The promoted ledger riding the ipc list items beyond the shared TaskListItem shape: `promoted` is
    // DERIVED main-side (promotedAt != null) — a merged task a landed direct Promote graduated to the
    // target. Optional: tasks:create returns a bare Task without the augmentations.
    promoted?: boolean;
    promotedAt?: number | null;
    promotedSha?: string | null;
}

export const stuckOf = (t: Pick<TaskListItem, "status" | "blocked" | "waitingOn">): boolean =>
    t.status === "queued" && t.blocked && t.waitingOn.some((w) => w.status === "needs-human" || w.status === "abandoned");

// The card/row/header chip in one rule: blocked wins (a queued task held behind parents), then the derived
// promoted view of a merged task (graduated past integration — never a stored TaskStatus), then the
// engine-owned status verbatim.
export const chipStatusOf = (t: Pick<TaskVM, "status" | "blocked" | "promoted">): LedStatus =>
    t.blocked ? "blocked" : t.status === "merged" && t.promoted ? "promoted" : t.status;

/* ---------- operator actions (the verb list, nothing else) ---------- */
export interface CockpitActions {
    openTask: (id: string) => void;
    openPlan: (projectId: string, planId: string) => void;
    startNow: (t: TaskVM) => void;
    dropIn: (t: TaskVM) => void;
    startFresh: (t: TaskVM) => void;
    resume: (t: TaskVM) => void;
    verifyMerge: (t: TaskVM) => void;
    abandon: (t: TaskVM) => void;
    clearDeps: (t: TaskVM) => void;
    openShell: (t: TaskVM) => void;
}
export const ActionCtx = createContext<CockpitActions>(null as unknown as CockpitActions);

/* ---------- formatters ---------- */
export function fmtUsd(n: number): string { return "$" + (Math.round(n * 100) / 100).toFixed(2); }
export function fmtTok(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
}
export function fmtDur(ms: number): string {
    const m = Math.round(ms / 60000);
    if (m < 1) return "<1m";
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
export function timeAgo(ts: number): string {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
}

// Best-effort parse of git's diffstat line ("3 files changed, 120 insertions(+), 8 deletions(-)")
// into the design's +N −N · F files readout; null = show the raw string instead.
export function parseDiffstat(raw: string): { files: number; plus: number; minus: number } | null {
    const files = /(\d+)\s+files?\s+changed/.exec(raw);
    if (!files) return null;
    const plus = /(\d+)\s+insertions?\(\+\)/.exec(raw);
    const minus = /(\d+)\s+deletions?\(-\)/.exec(raw);
    return { files: Number(files[1]), plus: Number(plus?.[1] ?? 0), minus: Number(minus?.[1] ?? 0) };
}
export function fmtDiffstat(raw: string): string {
    const d = parseDiffstat(raw);
    return d ? `+${d.plus} −${d.minus} · ${d.files} files` : raw;
}

/* ---------- tiny text atoms ---------- */
export function Overline({ children, style }: { children: ReactNode; style?: CSSProperties }) {
    return <div style={{ font: "var(--role-overline)", letterSpacing: "var(--tracking-caps)", textTransform: "uppercase", color: "var(--text-muted)", ...style }}>{children}</div>;
}
export function Mono({ children, dim, size, style }: { children: ReactNode; dim?: boolean; size?: string; style?: CSSProperties }) {
    return <span style={{ fontFamily: "var(--font-mono)", fontSize: size || "var(--text-xs)", color: dim ? "var(--text-muted)" : "inherit", ...style }}>{children}</span>;
}

/* ---------- status chip (the DS pill, colour-coded to the lifecycle) ---------- */
export function StatusChip({ status, label }: { status: LedStatus; label?: string }) {
    return <StatusPill status={status}>{label}</StatusPill>;
}

/* ---------- phase indicator (spawning/working/checking/accepting) ---------- */
const PHASE_META: Record<string, { icon: IconName; text: string }> = {
    spawning: { icon: "Loader", text: "spawning claude" },
    working: { icon: "Bot", text: "agent working" },
    checking: { icon: "ShieldCheck", text: "check running" },
    accepting: { icon: "ShieldCheck", text: "acceptance running" },
};
export function PhaseChip({ phase }: { phase: "spawning" | "working" | "checking" | "accepting" }) {
    const m = PHASE_META[phase] ?? PHASE_META.working;
    const color = phase === "working" || phase === "spawning" ? "var(--green-400)" : "var(--cyan-400)";
    return (
        <span {...verifyAttrs({ unit: "PhaseChip", phase })} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color, whiteSpace: "nowrap" }}>
            <Icon name={m.icon} size={12} />{m.text}
        </span>
    );
}

/* ---------- merge-stage treatment (presentation-only — derived from the engine's gate feed) ---------- */
// The engine marks the merge stage with gate feed entries; no TaskStatus exists for it (the task stays
// running/handed-off until the ref advances). A task is IN the merge stage iff its latest feed entry is
// one of the live merge labels — the merge stage emits nothing else, and any later event (a terminal
// merge label, agent output of a recycled retry, a loop gate) ends the phase.
export type MergePhase = "waiting" | "merging" | "re-check";
const MERGE_LIVE: Record<string, MergePhase> = {
    "merge: waiting": "waiting",             // queued behind the project's merge mutex
    "merge: merging": "merging",             // squashing onto the fresh integration tip
    "merge re-check: running": "re-check",   // check ∧ acceptance against the fresh tip
    "merge re-check: passed": "re-check",    // advancing the ref (moments from merged)
};
export function mergePhaseOf(t: Pick<TaskVM, "status" | "snap">): MergePhase | null {
    if (t.status !== "running" && t.status !== "handed-off") return null;
    const feed = t.snap?.feed;
    const last = feed && feed.length ? feed[feed.length - 1] : null;
    if (!last || last.kind !== "gate") return null;
    return MERGE_LIVE[last.text] ?? null;
}

const MERGE_TEXT: Record<MergePhase, string> = {
    waiting: "merge: waiting on the lane",
    merging: "merging onto integration",
    "re-check": "merge re-check running",
};
export function MergeChip({ phase }: { phase: MergePhase }) {
    return (
        <span {...verifyAttrs({ unit: "MergeChip", phase })} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: "var(--text-2xs)", color: "var(--violet-400)", whiteSpace: "nowrap" }}>
            <Icon name="GitMerge" size={12} />{MERGE_TEXT[phase]}
        </span>
    );
}

/* ---------- failure reason box (verbatim engine reasons — §4.2) ---------- */
export function FailureBox({ reason, quiet }: { reason: string | null | undefined; quiet?: boolean }) {
    if (!reason) return null;
    return (
        <div className={"helm-failure" + (quiet ? " quiet" : "")}>
            <Icon name="OctagonAlert" size={14} style={{ flex: "none", marginTop: 1 }} />
            <span className={quiet ? "helm-clamp2" : undefined}>{reason}</span>
        </div>
    );
}

/* ---------- waiting-on (blocked queued tasks; WAITING vs STUCK) ---------- */
export function WaitingOn({ task }: { task: TaskVM }) {
    const { openTask } = useContext(ActionCtx);
    if (!task.blocked || !task.waitingOn.length) return null;
    const stuck = stuckOf(task);
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <Overline style={{ color: stuck ? "var(--amber-400)" : "var(--text-muted)" }}>
                {stuck ? "stuck — a parent needs a human" : "waiting on"}
            </Overline>
            {task.waitingOn.map((p) => (
                <a key={p.id} onClick={(e) => { e.stopPropagation(); openTask(p.id); }}
                    style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--text-xs)", color: "var(--text-secondary)", cursor: "pointer", textDecoration: "none" }}>
                    <StatusDot status={p.status} size={6} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</span>
                </a>
            ))}
        </div>
    );
}

/* ---------- verb bar — THE operator verb list, nothing else (§5.2) ---------- */
export type TaskVerbId = "startNow" | "dropIn" | "startFresh" | "resume" | "verifyMerge" | "abandon" | "clearDeps" | "openShell";
export interface Verb { id: TaskVerbId; label: string; icon: IconName; danger?: boolean }
export function verbsFor(task: TaskVM): Verb[] {
    const v: Verb[] = [];
    const st: TaskStatus = task.status;
    const hasWorktree = !!task.worktreePath;
    if (st === "queued") {
        if (stuckOf(task)) v.push({ id: "clearDeps", label: "Clear dependencies", icon: "Unlink" });
        else if (!task.blocked) v.push({ id: "startNow", label: "Start now", icon: "Play" });
    } else if (st === "running") {
        if (task.resumable) v.push({ id: "dropIn", label: "Drop in", icon: "Terminal" });
        v.push({ id: "startFresh", label: "Start fresh", icon: "TerminalSquare" });
    } else if (st === "needs-human") {
        if (task.resumable) v.push({ id: "dropIn", label: "Drop in", icon: "Terminal" });
        v.push({ id: "startFresh", label: "Start fresh", icon: "TerminalSquare" });
        if (hasWorktree) v.push({ id: "openShell", label: "Open shell", icon: "SquareChevronRight" });
        v.push({ id: "abandon", label: "Abandon", icon: "Trash2", danger: true });
    } else if (st === "handed-off") {
        v.push({ id: "resume", label: "Resume", icon: "RefreshCw" });
        v.push({ id: "verifyMerge", label: "Verify & merge", icon: "ShieldCheck" });
        if (hasWorktree) v.push({ id: "openShell", label: "Open shell", icon: "SquareChevronRight" });
        v.push({ id: "abandon", label: "Abandon", icon: "Trash2", danger: true });
    }
    return v;
}

export function VerbBar({ task, compact, size }: { task: TaskVM; compact?: boolean; size?: "sm" | "md" }) {
    const actions = useContext(ActionCtx);
    const verbs = verbsFor(task);
    if (!verbs.length) return null;
    const shown = compact ? verbs.slice(0, 2) : verbs;
    return (
        <div
            {...verifyAttrs({ unit: "VerbBar", status: task.status, resumable: task.resumable, verbs: verbs.map((v) => v.id).join(",") })}
            style={{ display: "flex", gap: 6, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}
        >
            {shown.map((v) => (
                <Button key={v.id} size={size || "sm"} variant={v.danger ? "danger" : v.id === "verifyMerge" ? "secondary" : "ghost"}
                    iconLeft={<Icon name={v.icon} size={13} />}
                    loading={v.id === "verifyMerge" && task.validating}
                    onClick={() => actions[v.id](task)}>
                    {v.id === "verifyMerge" && task.validating ? "Validating…" : v.label}
                </Button>
            ))}
            {compact && verbs.length > 2 && (
                <Tooltip label="More actions in the task view">
                    <IconButton size="sm" label="More" onClick={() => actions.openTask(task.id)}><Icon name="Ellipsis" size={14} /></IconButton>
                </Tooltip>
            )}
        </div>
    );
}

/* ---------- merged-activity heatmap (weeks × weekdays, from real merge timestamps) ---------- */
const HEAT_LEVELS = [
    "rgba(255,255,255,0.045)",
    "color-mix(in oklab, var(--violet-400) 22%, transparent)",
    "color-mix(in oklab, var(--violet-400) 42%, transparent)",
    "color-mix(in oklab, var(--violet-400) 66%, transparent)",
    "var(--violet-400)",
];
const DAY_MS = 86_400_000;
// Monday-first weekday index for a timestamp.
const dayIdx = (ts: number): number => { const d = new Date(ts).getDay(); return d === 0 ? 6 : d - 1; };

export function Heatmap({ mergedAt, weeks = 26 }: { mergedAt: number[]; weeks?: number }) {
    const { grid, monthLabels } = useMemo(() => {
        const now = Date.now();
        // The grid's last column ends this week; anchor week starts on the most recent Monday.
        const thisMonday = now - dayIdx(now) * DAY_MS;
        const counts: number[][] = Array.from({ length: weeks }, () => Array<number>(7).fill(0));
        for (const ts of mergedAt) {
            const weeksBack = Math.floor((thisMonday - ts) / (7 * DAY_MS)) + (ts >= thisMonday ? 0 : 1);
            const w = weeks - 1 - (ts >= thisMonday ? 0 : weeksBack);
            if (w < 0 || w >= weeks) continue;
            counts[w][dayIdx(ts)] += 1;
        }
        const labels: string[] = [];
        let lastMonth = -1;
        for (let w = 0; w < weeks; w++) {
            const d = new Date(now - (weeks - 1 - w) * 7 * DAY_MS);
            const m = d.getMonth();
            labels.push(m !== lastMonth ? d.toLocaleString("en", { month: "short" }) : "");
            lastMonth = m;
        }
        return { grid: counts, monthLabels: labels };
    }, [mergedAt, weeks]);

    const dayLabel = ["Mon", "", "Wed", "", "Fri", "", ""];
    const level = (n: number) => (n <= 0 ? 0 : Math.min(4, n));
    // CSS grid with fixed-size tracks keeps every cell a perfect square — the month
    // labels ride a separate `auto` header row and overflow to the right without ever
    // widening a week column (the <table> layout let "Jan"/"Feb" stretch the columns).
    return (
        <div className="helm-heatmap" {...verifyAttrs({ unit: "Heatmap", merged: mergedAt.length })}>
            <div
                className="helm-heatmap-grid"
                style={{ gridTemplateColumns: `auto repeat(${weeks}, var(--heat-cell))`, gridTemplateRows: `auto repeat(7, var(--heat-cell))` }}
            >
                <span className="helm-heat-corner" />
                {monthLabels.map((m, i) => <span key={"m" + i} className="helm-heat-mon">{m}</span>)}
                {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                    <Fragment key={d}>
                        <span className="helm-heat-lab">{dayLabel[d]}</span>
                        {grid.map((col, w) => {
                            const lvl = level(col[d]);
                            return <span key={w} className="helm-heat-cell" title={col[d] ? `${col[d]} merged` : ""} style={lvl ? { background: HEAT_LEVELS[lvl] } : undefined} />;
                        })}
                    </Fragment>
                ))}
            </div>
            <div className="helm-heatmap-legend">
                <span>Less</span>
                {HEAT_LEVELS.map((c, i) => <span key={i} className="helm-heat-cell" style={{ background: c }} />)}
                <span>More</span>
                <span style={{ marginLeft: "auto", color: "var(--text-faint)" }}>merged tasks · last 6 months</span>
            </div>
        </div>
    );
}

/* ---------- activity panel — fleet stats + the heatmap (fills the wide activity strip) ---------- */
function StatTile({ value, label, sub }: { value: ReactNode; label: string; sub?: ReactNode }) {
    return (
        <div className="helm-stat">
            <b>{value}</b>
            <span>{label}</span>
            {sub != null && <small>{sub}</small>}
        </div>
    );
}

const dayStart = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

export function ActivityPanel({ tasks }: { tasks: TaskVM[] }) {
    const s = useMemo(() => {
        const merged = tasks.filter((t) => t.status === "merged");
        const mergedAt = merged.map((t) => t.updatedAt);
        const abandoned = tasks.filter((t) => t.status === "abandoned").length;
        let costUsd = 0, tokens = 0, sessions = 0;
        for (const t of tasks) {
            const tot = t.snap?.totals;
            if (tot) { costUsd += tot.costUsd; tokens += tot.input + tot.output + tot.cacheRead + tot.cacheCreation; }
            sessions += t.snap?.iterations.length ?? 0;
        }
        // Per-day merge counts drive the streaks and the busiest-day stat.
        const perDay = new Map<number, number>();
        for (const ts of mergedAt) { const k = dayStart(ts); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
        const busiest = perDay.size ? Math.max(...perDay.values()) : 0;
        const days = [...perDay.keys()].sort((a, b) => a - b);
        let best = 0, run = 0, prev = 0;
        for (const d of days) { run = prev && d - prev === DAY_MS ? run + 1 : 1; best = Math.max(best, run); prev = d; }
        let current = 0;
        for (let d = dayStart(Date.now()); perDay.has(d); d -= DAY_MS) current++;
        return { merged: merged.length, mergedAt, abandoned, costUsd, tokens, sessions, busiest, best, current };
    }, [tasks]);

    return (
        <div className="helm-activity-panel">
            <div className="helm-actstats">
                <StatTile value={s.merged} label="merged" sub={s.abandoned ? `${s.abandoned} abandoned` : "all-time"} />
                <StatTile value={fmtUsd(s.costUsd)} label="spent" />
                <StatTile value={fmtTok(s.tokens)} label="tokens" />
                <StatTile value={s.sessions} label="sessions" sub="claude runs" />
                <StatTile value={`${s.current}d`} label="streak" sub={`best ${s.best}d`} />
                <StatTile value={s.busiest} label="busiest day" sub={s.busiest ? "merges/day" : "—"} />
            </div>
            <div className="helm-activity-cal"><Heatmap mergedAt={s.mergedAt} /></div>
        </div>
    );
}

/* ---------- confirm dialog (destructive acts confirm — §8.6) ---------- */
export function ConfirmDialog({ open, title, body, confirmLabel, danger, matchText, onConfirm, onClose }: {
    open: boolean;
    title: ReactNode;
    body: ReactNode;
    confirmLabel: string;
    danger?: boolean;
    matchText?: string; // type-to-confirm for the irreversible cascade (project delete)
    onConfirm: () => void;
    onClose: () => void;
}) {
    const [typed, setTyped] = useState("");
    useEffect(() => { if (open) setTyped(""); }, [open]);
    if (!open) return null;
    const locked = !!matchText && typed !== matchText;
    return (
        <Dialog open onClose={onClose} title={title} width={440}
            footer={
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant={danger ? "danger" : "primary"} disabled={locked} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Button>
                </div>
            }>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <div>{body}</div>
                {matchText && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <Overline>type <span style={{ color: "var(--text-primary)" }}>{matchText}</span> to confirm</Overline>
                        <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={matchText} />
                    </div>
                )}
            </div>
        </Dialog>
    );
}

/* ---------- copyable command (load-bearing UI — §8.1) ---------- */
export function CopyCmd({ cmd }: { cmd: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="helm-cmd">
            <code>{cmd}</code>
            <IconButton size="sm" label={copied ? "Copied" : "Copy command"} onClick={() => {
                try { void navigator.clipboard.writeText(cmd); } catch { /* clipboard unavailable */ }
                setCopied(true); setTimeout(() => setCopied(false), 1600);
            }}>
                <Icon name={copied ? "Check" : "Copy"} size={13} />
            </IconButton>
        </div>
    );
}

/* ---------- feed line ---------- */
const FEED_ICON: Record<ActivityEntry["kind"], IconName> = { assistant: "MessageSquare", "tool-use": "Wrench", gate: "ShieldCheck" };
const FEED_COLOR: Record<ActivityEntry["kind"], string> = { assistant: "var(--text-secondary)", "tool-use": "var(--cyan-400)", gate: "var(--amber-300)" };
// Gate verdict tone, shared by FeedLine and the grouped feed's dominant gate treatment
// (TaskDetail). fail wins over pass: "merge: lost race — recycled (merge-conflict)" is a failure.
export type GateTone = "pass" | "fail" | "info";
export const gateToneOf = (text: string): GateTone =>
    /fail|denied|conflict|stopping|stall|hang/.test(text) ? "fail"
        : /passed|green|merged/.test(text) ? "pass"
            : "info";
export const GATE_TONE_COLOR: Record<GateTone, string> = {
    pass: "var(--green-400)", fail: "var(--red-400)", info: "var(--amber-300)",
};
export function FeedLine({ entry }: { entry: ActivityEntry }) {
    const color = entry.kind === "gate" ? GATE_TONE_COLOR[gateToneOf(entry.text)] : FEED_COLOR[entry.kind];
    return (
        <div className="helm-feed-line helm-fade-in">
            <Icon name={FEED_ICON[entry.kind] ?? "Dot"} size={12} style={{ flex: "none", color, transform: "translateY(1px)" }} />
            <span style={{ color: entry.kind === "assistant" ? "var(--text-secondary)" : color, minWidth: 0 }}>{entry.text}</span>
            <span style={{ marginLeft: "auto", color: "var(--text-faint)", flex: "none" }}>it {entry.iterationIndex}</span>
        </div>
    );
}

/* ---------- empty state ---------- */
export function EmptyState({ icon, line, action }: { icon?: IconName; line: ReactNode; action?: ReactNode }) {
    return (
        <div className="helm-empty">
            <Icon name={icon || "Inbox"} size={22} style={{ color: "var(--text-faint)" }} />
            <div>{line}</div>
            {action}
        </div>
    );
}
