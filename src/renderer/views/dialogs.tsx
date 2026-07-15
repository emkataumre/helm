// src/renderer/views/dialogs.tsx
// New task · Promote · Register project dialogs + the project Config tab. Ported from
// the design handoff (app/dialogs.jsx) onto the real window.helm surface. Promote runs
// the REAL projects:promote (a full re-validation — minutes, not a spinner-flash) and
// renders the whole PromoteResponse union incl. conflict / recheck-failed, which the
// mock never modelled; the design's `unlanded` commit-count has no API read, so the
// dialog explains and validates instead of pre-counting.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { NewProjectInput, NewTaskInput, Project, ProjectConfigPatch, PromoteResponse } from "../../shared/types";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, ProgressBar, Select, type SelectOption, Textarea } from "../ds";
import { verifyAttrs } from "../components/verifyAttrs";
import { ConfirmDialog, CopyCmd, FailureBox, Mono, Overline, type TaskVM } from "./helpers";

export function Field({ label, hint, children, required }: { label: ReactNode; hint?: ReactNode; children: ReactNode; required?: boolean }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <Overline>{label}{required && <span style={{ color: "var(--amber-400)" }}> *</span>}</Overline>
            {children}
            {hint && <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>{hint}</div>}
        </div>
    );
}

/* ---------- new task (§5.2.1 — Layer B mandatory) ---------- */
export function NewTaskDialog({ open, projects, tasks, defaultProjectId, onCreate, onClose }: {
    open: boolean;
    projects: Project[];
    tasks: TaskVM[];
    defaultProjectId?: string | null;
    onCreate: (input: NewTaskInput) => void;
    onClose: () => void;
}) {
    const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? "");
    const [title, setTitle] = useState("");
    const [intent, setIntent] = useState("");
    const [acceptance, setAcceptance] = useState<string[]>([""]);
    const [scopeHint, setScopeHint] = useState("");
    const [deps, setDeps] = useState<string[]>([]);
    useEffect(() => {
        if (open) { setProjectId(defaultProjectId ?? projects[0]?.id ?? ""); setTitle(""); setIntent(""); setAcceptance([""]); setScopeHint(""); setDeps([]); }
    }, [open, defaultProjectId]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!open) return null;

    // Valid dependency candidates: same-project tasks that are not merged/abandoned (§5.2.1).
    const candidates = tasks.filter((t) => t.projectId === projectId && t.status !== "merged" && t.status !== "abandoned");
    const cleanAcceptance = acceptance.map((a) => a.trim()).filter(Boolean);
    const valid = !!projectId && !!title.trim() && !!intent.trim() && cleanAcceptance.length >= 1;

    return (
        <Dialog open onClose={onClose} title="New task" width={560}
            description="Queued on create; auto-starts when a slot frees (unless the scheduler is paused).">
            <div {...verifyAttrs({ unit: "NewTaskDialog", valid, acceptance: cleanAcceptance.length })} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 10 }}>
                    <Field label="project" required>
                        <Select value={projectId} onChange={(e) => { setProjectId(e.target.value); setDeps([]); }}
                            options={projects.map((p) => ({ value: p.id, label: p.name }))} />
                    </Field>
                    <Field label="title" required>
                        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short name for the board" autoFocus />
                    </Field>
                </div>
                <Field label="intent" required hint="what to build — the agent's directive">
                    <Textarea rows={4} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Well-specified prose. The agent sees exactly this." />
                </Field>
                <Field label="acceptance commands" required hint="executable proofs — each must pass for a green verdict">
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {acceptance.map((a, i) => (
                            <div key={i} style={{ display: "flex", gap: 6 }}>
                                <div style={{ flex: 1 }}>
                                    <Input mono value={a} onChange={(e) => setAcceptance((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))} placeholder="npm run test:thing" />
                                </div>
                                {acceptance.length > 1 && (
                                    <IconButton label="Remove command" size="md" onClick={() => setAcceptance((arr) => arr.filter((_, j) => j !== i))}><Icon name="X" size={14} /></IconButton>
                                )}
                            </div>
                        ))}
                        <Button size="sm" variant="ghost" iconLeft={<Icon name="Plus" size={13} />} onClick={() => setAcceptance((arr) => [...arr, ""])}>Add command</Button>
                    </div>
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="scope hint" hint="optional — e.g. src/widgets/**">
                        <Input mono value={scopeHint} onChange={(e) => setScopeHint(e.target.value)} placeholder="(none)" />
                    </Field>
                    <Field label="depends on" hint={candidates.length ? "starts only after every parent merges" : "no eligible tasks in this project"}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 110, overflowY: "auto" }}>
                            {candidates.map((c) => (
                                <Checkbox key={c.id} checked={deps.includes(c.id)}
                                    onChange={() => setDeps((d) => (d.includes(c.id) ? d.filter((x) => x !== c.id) : [...d, c.id]))}
                                    label={<span style={{ fontSize: "var(--text-xs)" }}>{c.title}</span>} />
                            ))}
                        </div>
                    </Field>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center", paddingBottom: 18 }}>
                    {!cleanAcceptance.length && <Mono dim size="var(--text-2xs)" style={{ marginRight: "auto", color: "var(--amber-300)" }}>at least one acceptance command — Layer B is mandatory</Mono>}
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" disabled={!valid}
                        onClick={() => { onCreate({ projectId, title: title.trim(), intent: intent.trim(), acceptance: cleanAcceptance, scopeHint: scopeHint.trim() || null, dependsOn: deps }); onClose(); }}>
                        Queue task
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}

/* ---------- promote (§5.1.4) ---------- */
export const MODE_BLURB: Record<Project["promotionMode"], string> = {
    pr: "pr mode — Helm pushes the integration branch and hands you a PR command. Trunk advances only when the PR merges.",
    direct: "direct mode — on your explicit click, Helm advances the target to the exact re-validated commit. Nothing else is pushed.",
    strict: "strict mode — Helm pushes nothing. You get the full local command sequence to run yourself.",
};

/** The promote result surface — pure so the verify slice can drive every outcome of the union. */
export function PromoteOutcome({ project, result }: { project: Project; result: PromoteResponse }) {
    const ready = result.outcome === "ready" ? result : null;
    return (
        <div className="helm-fade-in" {...verifyAttrs({ unit: "PromoteOutcome", outcome: result.outcome, advanced: ready ? !!ready.advancedTarget : null, commands: ready?.commands?.length ?? 0 })} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {result.outcome === "nothing-to-promote" && <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>Nothing to promote — integration has no unlanded commits beyond origin/{project.targetBranch}.</div>}
            {result.outcome === "conflict" && <FailureBox reason={`integration conflicts with origin/${project.targetBranch} — resolve on integration, then promote again. Nothing was pushed.`} />}
            {result.outcome === "recheck-failed" && (
                <>
                    <FailureBox reason="re-check failed on the fresh target tip — integration does not compose with trunk as-is. Nothing was pushed." />
                    <div className="helm-well" style={{ maxHeight: 220, overflowY: "auto" }}>{result.output}</div>
                </>
            )}
            {ready && (
                <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Icon name={ready.error ? "TriangleAlert" : "CircleCheck"} size={16} style={{ color: ready.error ? "var(--amber-400)" : "var(--green-400)" }} />
                        <span style={{ fontSize: "var(--text-sm)", fontWeight: 500 }}>re-check green at <Mono>{ready.validatedSha.slice(0, 12)}</Mono></span>
                        <Mono dim size="var(--text-2xs)">{ready.diffstat}</Mono>
                    </div>
                    {ready.advancedTarget && <div style={{ fontSize: "var(--text-sm)", color: "var(--green-300)" }}>advanced {project.targetBranch} → <Mono>{(ready.advancedTo ?? ready.validatedSha).slice(0, 12)}</Mono> on your click — the exact re-validated commit, nothing else.</div>}
                    {ready.error && <FailureBox reason={ready.error} />}
                    {(ready.pushedRefs?.length ?? 0) > 0 && (
                        <Field label="pushed refs">{ready.pushedRefs!.map((r) => <Mono key={r} dim size="var(--text-2xs)">{r}</Mono>)}</Field>
                    )}
                    {(ready.commands?.length ?? 0) > 0 && (
                        <Field label={ready.error ? "retry command" : ready.advancedTarget ? "audit trail — the push Helm just ran for you" : "your move — copyable commands"}>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {ready.commands!.map((c) => <CopyCmd key={c} cmd={c} />)}
                            </div>
                        </Field>
                    )}
                    {ready.note && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{ready.note}</div>}
                </>
            )}
        </div>
    );
}

export function PromoteDialog({ open, project, onClose }: {
    open: boolean;
    project: Project | undefined;
    onClose: () => void;
}) {
    const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
    const [result, setResult] = useState<PromoteResponse | null>(null);
    useEffect(() => { if (open) { setPhase("idle"); setResult(null); } }, [open, project?.id]);
    if (!open || !project) return null;

    const run = async () => {
        setPhase("running");
        try {
            setResult(await window.helm.promote(project.id));
        } catch (e) {
            // A thrown mid-promote git failure surfaces as recheck-failed so the human sees why.
            setResult({ outcome: "recheck-failed", output: e instanceof Error ? e.message : String(e) });
        }
        setPhase("done");
    };

    const ready = result?.outcome === "ready" ? result : null;
    return (
        <Dialog open onClose={phase === "running" ? undefined : onClose} title={"Promote — " + project.name} width={620}
            description={`${project.integrationBranch} → ${project.targetBranch} · ${MODE_BLURB[project.promotionMode]}`}
            footer={
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button variant="ghost" onClick={onClose} disabled={phase === "running"}>{phase === "done" ? "Close" : "Cancel"}</Button>
                    {phase === "idle" && <Button variant="primary" iconLeft={<Icon name="GitCompare" size={14} />} onClick={() => void run()}>Validate &amp; promote</Button>}
                    {phase === "done" && ready?.error && <Button variant="primary" onClick={() => void run()}>Retry promote</Button>}
                </div>
            }>
            <div {...verifyAttrs({ unit: "PromoteDialog", phase, outcome: result?.outcome ?? null, advanced: ready ? !!ready.advancedTarget : null })} style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
                {phase === "idle" && (
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.55 }}>
                        Promotion counts the unlanded commits on <Mono>{project.integrationBranch}</Mono>, merges them onto a <b>fresh</b> fetch of{" "}
                        <Mono>origin/{project.targetBranch}</Mono> in a throwaway worktree, and re-runs <Mono>{project.checkCommand}</Mono> there
                        before anything moves — this takes real time.
                    </div>
                )}
                {phase === "running" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "8px 0" }}>
                        <ProgressBar indeterminate tone="primary" size="sm" />
                        <Mono dim size="var(--text-xs)">fetching origin/{project.targetBranch} fresh · merging integration in a throwaway worktree · re-running {project.checkCommand} there…</Mono>
                    </div>
                )}
                {phase === "done" && result && <PromoteOutcome project={project} result={result} />}
            </div>
        </Dialog>
    );
}

/* ---------- register project (§5.1.1) ---------- */
export function RegisterProjectDialog({ open, onCreate, onClose }: {
    open: boolean;
    onCreate: (input: NewProjectInput) => void;
    onClose: () => void;
}) {
    const blank = { name: "", repoPath: "", targetBranch: "", checkCommand: "", setupCommand: "" };
    const [f, setF] = useState(blank);
    const [detected, setDetected] = useState(false);
    const [detecting, setDetecting] = useState(false);
    useEffect(() => { if (open) { setF(blank); setDetected(false); setDetecting(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!open) return null;
    const set = (k: keyof typeof blank, v: string) => setF((o) => ({ ...o, [k]: v }));
    const detect = async () => {
        setDetecting(true);
        try {
            const d = await window.helm.detectProject(f.repoPath);
            setF((o) => ({
                ...o,
                name: o.name || (o.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? ""),
                targetBranch: d.targetBranch ?? o.targetBranch,
                checkCommand: d.checkCommand ?? o.checkCommand,
                setupCommand: d.setupCommand ?? o.setupCommand,
            }));
            setDetected(true);
        } finally { setDetecting(false); }
    };
    const valid = !!f.name.trim() && !!f.repoPath.trim() && !!f.checkCommand.trim();
    return (
        <Dialog open onClose={onClose} title="Register project" width={540}
            description="Point Helm at a git repo. The check command is the project-wide verification gate — mandatory."
            footer={
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <Button variant="ghost" onClick={onClose}>Cancel</Button>
                    <Button variant="primary" disabled={!valid}
                        onClick={() => {
                            onCreate({ name: f.name.trim(), repoPath: f.repoPath.trim(), targetBranch: f.targetBranch.trim() || "main", checkCommand: f.checkCommand.trim(), setupCommand: f.setupCommand.trim() || null });
                            onClose();
                        }}>Register</Button>
                </div>
            }>
            <div {...verifyAttrs({ unit: "RegisterProjectDialog", valid })} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Field label="repo path" required>
                    <div style={{ display: "flex", gap: 6 }}>
                        <div style={{ flex: 1 }}><Input mono value={f.repoPath} onChange={(e) => set("repoPath", e.target.value)} placeholder="C:\dev\my-repo" autoFocus /></div>
                        <Button variant="secondary" loading={detecting} disabled={!f.repoPath.trim()} iconLeft={<Icon name="ScanSearch" size={14} />} onClick={() => void detect()}>Auto-detect</Button>
                    </div>
                    {detected && <Mono dim size="var(--text-2xs)" style={{ color: "var(--green-400)" }}>detected: branch from git · check from package.json scripts · setup from the lockfile</Mono>}
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="name" required><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="my-repo" /></Field>
                    <Field label="target branch" hint="the human-owned trunk"><Input mono value={f.targetBranch} onChange={(e) => set("targetBranch", e.target.value)} placeholder="main" /></Field>
                </div>
                <Field label="check command" required hint="runs after every iteration — the project gate">
                    <Input mono value={f.checkCommand} onChange={(e) => set("checkCommand", e.target.value)} placeholder="npm run check" />
                </Field>
                <Field label="setup command" hint="optional — once per fresh worktree">
                    <Input mono value={f.setupCommand} onChange={(e) => set("setupCommand", e.target.value)} placeholder="npm install" />
                </Field>
                <div style={{ fontSize: "var(--text-2xs)", color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
                    bounds, model, jail and promotion mode are editable later in the project's Config tab
                </div>
            </div>
        </Dialog>
    );
}

/* ---------- model override picker ---------- */
// The `claude --model` override. These are the CLI's tier aliases (each resolves to the
// latest model of that tier) plus "cli default" (empty) and a "custom…" escape hatch so
// an exact model id like `claude-opus-4-8` can still be pinned.
const MODEL_PRESETS = ["fable", "opus", "sonnet", "haiku"] as const;
const MODEL_OPTIONS: SelectOption[] = [
    { value: "", label: "cli default" },
    ...MODEL_PRESETS.map((m) => ({ value: m, label: m })),
    { value: "__custom__", label: "custom…" },
];

/** Keyed per project by the caller so a project switch re-derives custom-vs-preset. */
function ModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const [customMode, setCustomMode] = useState<boolean>(() => value !== "" && !(MODEL_PRESETS as readonly string[]).includes(value));
    const selValue = customMode ? "__custom__" : value;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Select
                value={selValue}
                options={MODEL_OPTIONS}
                onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__custom__") setCustomMode(true);
                    else { setCustomMode(false); onChange(v); }
                }}
            />
            {customMode && (
                <Input mono value={value} placeholder="e.g. claude-opus-4-8" autoFocus onChange={(e) => onChange(e.target.value)} />
            )}
        </div>
    );
}

/* Explains every promotion mode at once — an inline card toggled by the ⓘ. Rendered
 * outside the Field's <Overline> label so it's neither uppercased nor clipped by the
 * scrolling config pane (both bit the hover-tooltip version). */
function PromotionHelpCard() {
    return (
        <div className="helm-help-card">
            {(["pr", "direct", "strict"] as const).map((m) => (
                <div key={m}><span className="helm-help-term">{m}</span> — {MODE_BLURB[m].split("— ")[1] ?? MODE_BLURB[m]}</div>
            ))}
            <div style={{ color: "var(--text-faint)" }}>Trunk never advances without your explicit action — Helm never pushes it for you.</div>
        </div>
    );
}

/* ---------- project config tab (§5.1.2 / §5.1.3) ---------- */
export function ProjectConfigTab({ project, onSave, onDelete }: {
    project: Project;
    onSave: (id: string, patch: ProjectConfigPatch) => void;
    onDelete: (id: string) => void;
}) {
    const toForm = (p: Project) => ({
        setupCommand: p.setupCommand ?? "", model: p.model ?? "",
        iterationCap: p.iterationCap?.toString() ?? "", noProgressK: p.noProgressK?.toString() ?? "",
        stallTimeoutMin: p.stallTimeoutMin?.toString() ?? "", costCapUsd: p.costCapUsd?.toString() ?? "",
        concurrencyCap: p.concurrencyCap?.toString() ?? "", terminalCommand: p.terminalCommand ?? "",
        autoModeEnvironment: p.autoModeEnvironment ?? "", promotionMode: p.promotionMode, jailImage: p.jailImage ?? "",
    });
    const [f, setF] = useState(() => toForm(project));
    const [dirty, setDirty] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [showPromoHelp, setShowPromoHelp] = useState(false);
    useEffect(() => { setF(toForm(project)); setDirty(false); }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
    const set = (k: keyof ReturnType<typeof toForm>, v: string) => { setF((o) => ({ ...o, [k]: v })); setDirty(true); };
    const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
    const save = () => {
        onSave(project.id, {
            setupCommand: f.setupCommand || null, model: f.model || null,
            iterationCap: numOrNull(f.iterationCap), noProgressK: numOrNull(f.noProgressK),
            stallTimeoutMin: numOrNull(f.stallTimeoutMin), costCapUsd: numOrNull(f.costCapUsd),
            concurrencyCap: numOrNull(f.concurrencyCap), terminalCommand: f.terminalCommand || null,
            autoModeEnvironment: f.autoModeEnvironment || null,
            promotionMode: f.promotionMode as Project["promotionMode"],
            jailImage: f.jailImage || null,
        });
        setDirty(false);
    };

    const locked = (label: string, value: string) => (
        <Field label={<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{label} <Icon name="Lock" size={10} style={{ display: "inline-block" }} /></span>}>
            <Input mono value={value} disabled readOnly />
        </Field>
    );

    return (
        <div {...verifyAttrs({ unit: "ProjectConfigTab", id: project.id, dirty })} style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 22, paddingBottom: 32 }}>
            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Overline>identity — fixed at registration</Overline>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    {locked("name", project.name)}
                    {locked("repo path", project.repoPath)}
                    {locked("target branch", project.targetBranch)}
                </div>
                <Mono dim size="var(--text-2xs)">integration: {project.integrationBranch} · branch prefix: {project.branchPrefix} · worktrees: {project.worktreeDir}</Mono>
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Overline>gates &amp; bounds</Overline>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="setup command" hint="once per fresh worktree"><Input mono value={f.setupCommand} onChange={(e) => set("setupCommand", e.target.value)} placeholder="(none)" /></Field>
                    <Field label="model" hint="claude --model override"><ModelField key={project.id} value={f.model} onChange={(v) => set("model", v)} /></Field>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
                    <Field label="iter cap"><Input mono type="number" value={f.iterationCap} onChange={(e) => set("iterationCap", e.target.value)} placeholder="8" /></Field>
                    <Field label="no-progress k"><Input mono type="number" value={f.noProgressK} onChange={(e) => set("noProgressK", e.target.value)} placeholder="2" /></Field>
                    <Field label="stall (min)"><Input mono type="number" value={f.stallTimeoutMin} onChange={(e) => set("stallTimeoutMin", e.target.value)} placeholder="40" /></Field>
                    <Field label="cost cap ($)"><Input mono type="number" value={f.costCapUsd} onChange={(e) => set("costCapUsd", e.target.value)} placeholder="25" /></Field>
                    <Field label="concurrency"><Input mono type="number" value={f.concurrencyCap} onChange={(e) => set("concurrencyCap", e.target.value)} placeholder="3" /></Field>
                </div>
                <Mono dim size="var(--text-2xs)">explicit cost cap 0 = spawn nothing · raising concurrency takes effect immediately</Mono>
            </section>

            <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <Overline>hand-off &amp; promotion</Overline>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 12 }}>
                    <Field
                        label={<span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>promotion mode
                            <button type="button" className="helm-help-toggle" aria-label="How promotion modes work" aria-expanded={showPromoHelp} onClick={() => setShowPromoHelp((v) => !v)}><Icon name="Info" size={12} /></button>
                        </span>}
                        hint={MODE_BLURB[f.promotionMode as Project["promotionMode"]]}
                    >
                        <Select value={f.promotionMode} onChange={(e) => set("promotionMode", e.target.value)} options={["pr", "direct", "strict"]} />
                    </Field>
                    <Field label="terminal command" hint="drop-in template with {worktree} / {resume} — empty = in-app terminal tabs">
                        <Input mono value={f.terminalCommand} onChange={(e) => set("terminalCommand", e.target.value)} placeholder="(in-app terminals)" />
                    </Field>
                </div>
                {showPromoHelp && <PromotionHelpCard />}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="jail image" hint="set = every agent run is jailed in Docker; gates still run host-side">
                        <Input mono value={f.jailImage} onChange={(e) => set("jailImage", e.target.value)} placeholder="(agents run on the host)" />
                    </Field>
                    <Field label="auto-mode environment" hint="trusted-environment config — expert knob">
                        <Input mono value={f.autoModeEnvironment} onChange={(e) => set("autoModeEnvironment", e.target.value)} placeholder="(defaults)" />
                    </Field>
                </div>
            </section>

            <div style={{ display: "flex", gap: 8 }}>
                <Button variant="primary" disabled={!dirty} onClick={save}>Save config</Button>
                {dirty && <Button variant="ghost" onClick={() => { setF(toForm(project)); setDirty(false); }}>Discard</Button>}
            </div>

            <section style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                <Overline style={{ color: "var(--red-400)" }}>danger</Overline>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", flex: 1 }}>Delete removes the project and every task, iteration and plan under it. Irreversible.</div>
                    <Button variant="danger" iconLeft={<Icon name="Trash2" size={14} />} onClick={() => setConfirmDelete(true)}>Delete project</Button>
                </div>
            </section>

            <ConfirmDialog open={confirmDelete} title={`Delete ${project.name}?`}
                body="All tasks, iteration history and plans in this project are removed permanently."
                confirmLabel="Delete everything" danger matchText={project.name}
                onConfirm={() => onDelete(project.id)} onClose={() => setConfirmDelete(false)} />
        </div>
    );
}
