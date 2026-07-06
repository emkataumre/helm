// src/main/engine/planDraft.ts
// The M10 validation brain — PURE, no I/O (the plan's TDD unit). parsePlanDraft turns raw tasks.json into a
// validated PlanDraft (or a list of human-readable errors); staticPreflight flags hallucinated acceptance
// commands against a caller-supplied npmScripts list + fileExists probe. Both are Electron-free leaves so the
// verify slice drives the REAL functions. Only PARSE failures block approve — static warns never do (a task
// may legitimately create its own verify script; the grill's nuance), which is why staticPreflight only ever
// returns ok | warn.
import type { PlanDraft, PlanDraftTask, PreflightVerdict } from "../../shared/types";

export type ParseResult = { ok: true; draft: PlanDraft } | { ok: false; errors: string[] };

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// Shape → slugs → edges. Accumulates every error we can (so a human sees all the problems at once), but
// bails early on the two cases that make further checks meaningless: non-JSON, and a missing/empty task array.
export function parsePlanDraft(tasksJson: string): ParseResult {
    let raw: unknown;
    try { raw = JSON.parse(tasksJson); }
    catch (e) { return { ok: false, errors: [`tasks.json is not valid JSON: ${(e as Error).message}`] }; }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, errors: ["tasks.json must be a JSON object with planTitle + tasks"] };
    }
    const obj = raw as Record<string, unknown>;
    const errors: string[] = [];
    if (!isNonEmptyString(obj.planTitle)) errors.push("planTitle must be a non-empty string");

    if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
        errors.push("tasks must be a non-empty array (at least one task)");
        return { ok: false, errors };
    }

    const tasks: PlanDraftTask[] = [];
    obj.tasks.forEach((rt, i) => {
        const at = `task[${i}]`;
        if (typeof rt !== "object" || rt === null || Array.isArray(rt)) { errors.push(`${at} must be an object`); return; }
        const t = rt as Record<string, unknown>;

        if (!isNonEmptyString(t.slug)) errors.push(`${at}.slug must be a non-empty string`);
        if (!isNonEmptyString(t.title)) errors.push(`${at}.title must be a non-empty string`);
        if (!isNonEmptyString(t.intent)) errors.push(`${at}.intent must be a non-empty string`);

        let acceptance: string[] = [];
        if (!Array.isArray(t.acceptance) || t.acceptance.length === 0) {
            errors.push(`${at}.acceptance must be a non-empty array of separately-runnable commands`);
        } else if (!t.acceptance.every(isNonEmptyString)) {
            errors.push(`${at}.acceptance must contain only non-empty command strings`);
        } else {
            acceptance = t.acceptance.map((c) => (c as string).trim());
        }

        let scopeHint: string | null = null;
        if (t.scopeHint != null) {
            if (typeof t.scopeHint !== "string") errors.push(`${at}.scopeHint must be a string or null`);
            else scopeHint = t.scopeHint.trim() || null;
        }

        let dependsOn: string[] = [];
        if (t.dependsOn != null) {
            if (!Array.isArray(t.dependsOn) || !t.dependsOn.every((d) => typeof d === "string")) {
                errors.push(`${at}.dependsOn must be an array of sibling slugs`);
            } else {
                dependsOn = t.dependsOn as string[];
            }
        }

        // A placeholder slug for a task whose own slug is invalid keeps the cross-checks total without
        // pretending it's a real node (it never matches a dependsOn ref, and it's skipped in the dup scan).
        tasks.push({
            slug: isNonEmptyString(t.slug) ? t.slug.trim() : `«${at}»`,
            title: isNonEmptyString(t.title) ? t.title : "",
            intent: isNonEmptyString(t.intent) ? t.intent : "",
            acceptance, scopeHint, dependsOn,
        });
    });

    const seen = new Set<string>();
    for (const t of tasks) {
        if (t.slug.startsWith("«")) continue;
        if (seen.has(t.slug)) errors.push(`duplicate slug "${t.slug}" — slugs must be unique within the file`);
        seen.add(t.slug);
    }

    const slugSet = new Set(tasks.map((t) => t.slug));
    for (const t of tasks) {
        for (const dep of t.dependsOn) {
            if (!slugSet.has(dep)) errors.push(`task "${t.slug}" dependsOn "${dep}" which is not a sibling slug in this file`);
        }
    }

    const cycle = findCycle(tasks);
    if (cycle) errors.push(`dependency cycle: ${cycle.join(" → ")}`);

    if (errors.length) return { ok: false, errors };
    return { ok: true, draft: { planTitle: (obj.planTitle as string).trim(), tasks } };
}

// DFS with GRAY/BLACK colouring; edges to non-existent slugs are ignored (already flagged as bad refs). Returns
// the cycle as a slug path (…u → v → u) or null. First cycle found is enough to reject.
function findCycle(tasks: PlanDraftTask[]): string[] | null {
    const nodes = new Set(tasks.map((t) => t.slug));
    const adj = new Map<string, string[]>();
    for (const t of tasks) adj.set(t.slug, t.dependsOn.filter((d) => nodes.has(d)));

    const GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const stack: string[] = [];
    let found: string[] | null = null;

    const dfs = (u: string): boolean => {
        color.set(u, GRAY); stack.push(u);
        for (const v of adj.get(u) ?? []) {
            if (color.get(v) === GRAY) { found = [...stack.slice(stack.indexOf(v)), v]; return true; }
            if (!color.has(v) && dfs(v)) return true;
        }
        color.set(u, BLACK); stack.pop();
        return false;
    };
    for (const n of nodes) { if (!color.has(n) && dfs(n)) break; }
    return found;
}

// ── Approve planner (pure) ─────────────────────────────────────────────────────────────────────────
// The pure planner-of-the-approve (the reconcile pure-planner/thin-executor idiom): topologically sort the
// draft's tasks (parents first) and resolve each dependsOn SLUG to the real id its parent was assigned. genId
// is injected (one call per task) so this is deterministic + unit-testable; the ipc executor passes randomUUID.
// Because the order is parent-first, a child's parent id is always already assigned when its edges resolve.
export interface PlanInsert {
    id: string;
    slug: string;
    title: string;
    intent: string;
    acceptance: string[];
    scopeHint: string | null;
    dependsOn: string[]; // resolved real ids (parents), in draft order
}

export function planApproval(draft: PlanDraft, genId: () => string): PlanInsert[] {
    const order = topoSort(draft.tasks);
    const slugToId = new Map<string, string>();
    const inserts: PlanInsert[] = [];
    for (const t of order) {
        const id = genId();
        slugToId.set(t.slug, id);
        inserts.push({
            id, slug: t.slug, title: t.title, intent: t.intent, acceptance: t.acceptance, scopeHint: t.scopeHint,
            // Parents come first in topo order, so every valid edge resolves; an unresolved slug (only reachable
            // via a cycle that bypassed parse) is dropped rather than emitting a dangling id.
            dependsOn: t.dependsOn.map((s) => slugToId.get(s)).filter((x): x is string => x != null),
        });
    }
    return inserts;
}

// The approve decision core (pure, thin-executor idiom): parse tasks.json from disk, and ONLY on success
// produce the plan + its topo-ordered, id-resolved inserts. A parse failure yields NO inserts — the ipc
// executor's DB transaction never runs, so a parse-invalid draft can never produce rows (approve-only-valid).
// prdText is passed through (missing → "" so approve isn't wedged; the ipc surfaces the warn).
export interface ApprovalPlan { planTitle: string; prdText: string; inserts: PlanInsert[]; }
export function approveFromTasksJson(tasksJson: string, prdText: string | null, genId: () => string): { ok: true; plan: ApprovalPlan } | { ok: false; errors: string[] } {
    const parsed = parsePlanDraft(tasksJson);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return { ok: true, plan: { planTitle: parsed.draft.planTitle, prdText: prdText ?? "", inserts: planApproval(parsed.draft, genId) } };
}

// Kahn's algorithm, ties broken by draft order (stable + deterministic). A residual cycle (should be impossible
// post-parse) falls back to appending the unordered remainder in draft order — planApproval never hangs.
function topoSort(tasks: PlanDraftTask[]): PlanDraftTask[] {
    const bySlug = new Map(tasks.map((t) => [t.slug, t]));
    const parents = new Map<string, string[]>();
    const indeg = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const t of tasks) { children.set(t.slug, []); }
    for (const t of tasks) {
        const ps = t.dependsOn.filter((d) => bySlug.has(d));
        parents.set(t.slug, ps);
        indeg.set(t.slug, ps.length);
    }
    for (const t of tasks) for (const p of parents.get(t.slug)!) children.get(p)!.push(t.slug);

    const queue = tasks.filter((t) => indeg.get(t.slug) === 0).map((t) => t.slug);
    const out: PlanDraftTask[] = [];
    const seen = new Set<string>();
    while (queue.length) {
        const s = queue.shift()!;
        if (seen.has(s)) continue;
        seen.add(s);
        out.push(bySlug.get(s)!);
        for (const c of children.get(s) ?? []) {
            indeg.set(c, (indeg.get(c) ?? 0) - 1);
            if (indeg.get(c) === 0) queue.push(c);
        }
    }
    for (const t of tasks) if (!seen.has(t.slug)) out.push(t); // cycle fallback
    return out;
}

// ── Static pre-flight ────────────────────────────────────────────────────────────────────────────
export interface PreflightCtx { npmScripts: string[]; fileExists: (p: string) => boolean; }

export function staticPreflight(draft: PlanDraft, ctx: PreflightCtx): PreflightVerdict[] {
    const out: PreflightVerdict[] = [];
    for (const t of draft.tasks) for (const command of t.acceptance) out.push(judge(t.slug, command, ctx));
    return out;
}

function judge(taskSlug: string, command: string, ctx: PreflightCtx): PreflightVerdict {
    const cmd = command.trim();

    const script = matchNpmRun(cmd);
    if (script != null) {
        if (ctx.npmScripts.includes(script)) return { taskSlug, command, level: "ok" };
        const suggestion = didYouMean(script, ctx.npmScripts);
        return { taskSlug, command, level: "warn", reason: `no npm script "${script}" in package.json`, ...(suggestion ? { suggestion } : {}) };
    }

    const path = firstPathToken(cmd);
    if (path != null) {
        if (ctx.fileExists(path)) return { taskSlug, command, level: "ok" };
        return { taskSlug, command, level: "warn", reason: `path "${path}" does not exist in the repo` };
    }

    // An opaque command we can't statically judge (pytest, a global binary) — never false-warn; ok.
    return { taskSlug, command, level: "ok" };
}

// `npm run <script>` (optionally `-- args`), captures the script name. Only `run` (not bare `npm test`/`ci`).
function matchNpmRun(cmd: string): string | null {
    const m = /^npm\s+run\s+(\S+)/.exec(cmd);
    return m ? m[1] : null;
}

// The first non-flag token that looks like a path (a leading ./ or ../, or an embedded / or \). Handles both
// `./x.ps1` (first token is the path) and `node scripts/x.mjs` (the interpreter first, the path second).
function firstPathToken(cmd: string): string | null {
    for (const tok of cmd.split(/\s+/).filter(Boolean)) {
        if (tok.startsWith("-")) continue;
        if (/^\.\.?\//.test(tok) || tok.includes("/") || tok.includes("\\")) return tok;
    }
    return null;
}

const SUGGEST_THRESHOLD = 3; // require a meaningful shared prefix/substring before proposing a did-you-mean

function didYouMean(target: string, scripts: string[]): string | undefined {
    let best: string | undefined;
    let bestScore = 0;
    for (const s of scripts) {
        const score = similarity(target, s);
        if (score > bestScore) { bestScore = score; best = s; }
    }
    return bestScore >= SUGGEST_THRESHOLD ? best : undefined;
}

// Cheap similarity (no new dep): longest common prefix length, lifted to the shorter length when one string
// contains the other (a strong hallucinated-suffix/typo signal, e.g. verify:tray ⊂ verify:trays).
function similarity(a: string, b: string): number {
    let p = 0;
    const n = Math.min(a.length, b.length);
    while (p < n && a[p] === b[p]) p++;
    if (a.includes(b) || b.includes(a)) return Math.max(p, n);
    return p;
}
