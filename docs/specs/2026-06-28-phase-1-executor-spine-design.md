# Helm — Phase 1 (Executor Spine) Design Spec

- **Working codename:** Helm *(placeholder — steering/cockpit, "take the wheel" drop-in metaphor; rename freely)*
- **Date:** 2026-06-28
- **Status:** Draft for review
- **Author:** Emil + Claude (grill-me session)
- **Donor / reference implementation:** Pail (`I:\Personal\pail`) — its safety core is ported, its tests are the spec for "safe".

---

## 1. What Helm is

Helm is a **polished desktop cockpit for running autonomous "Ralph loop" coding agents**, built greenfield around the idea of a *session*: a Claude Code run, kickstarted headless with a prompt + acceptance criteria in an isolated git worktree, that grinds toward a verifiable "done" — and that you can drop into and take over whenever you want.

It is a **daily-driver utility** (not a learning toy, not a demo): the bar is that you reach for it instead of doing the work yourself, and the UX is good enough to live in. It is **local-first**, **Claude Code–centric**, and **never touches your trunk**.

### Relationship to the two reference tools

- **emdash** is a real-time, human-driven cockpit for fanning out *one-shot* agents you review by hand. Helm borrows its *form* (Electron desktop, worktree-per-task, parallel sessions, structured-event observability) but not its *control model* (Helm's sessions are autonomous loops, not single dispatches).
- **Pail** is an unattended, headless drain that runs *one* `claude -p` per task with no retry and no session capture. Helm borrows its *safety rails* (worktree isolation → commit → independent check → acceptance gate → `--no-ff`/squash merge to an integration branch → never-push) but **not** its loop — Pail is single-pass; Helm is a true Ralph loop.

The two things that make Helm *Helm* — **loop-until-done** and **resumable drop-in** — are both net-new versus Pail.

### The product is a three-subsystem conveyor, built in phases

| Phase | Subsystem | Status |
|---|---|---|
| **1 (this spec)** | **Executor Spine** — the autonomous Ralph engine + a minimal-but-real cockpit | Designing now |
| 2 | **Planner front-half** — in-app idea → grill-me → PRD → dependency-ordered, acceptance-bearing tasks | Deferred |
| 3 | **Cockpit polish & scale** — richer control room, reports, scale | Deferred |

We build **executor-first** because the engine is the hardest, scariest, highest-value core and is the literal heart of the product; the planner (Phase 2) merely auto-fills a task contract the engine already consumes (see §6).

---

## 2. Goals and non-goals (Phase 1)

### Goals
- Run **autonomous Ralph loops** that grind a well-specced task to a machine-verified "done", fully unattended.
- Run them **in parallel**, safely, with a polished cockpit to watch and steer.
- Let the user **drop into** any session, take over in a terminal, and hand control back.
- Port Pail's **safety guarantees** faithfully: never push/merge the target branch; isolated worktrees; independent verification.
- Be a **trustworthy daily driver** on Windows.

### Non-goals (deferred to later phases — see §17)
- In-app planner (grill-me/PRD/issue breakdown). Phase 1 tasks are hand-authored.
- Docker/sandbox jail (auto mode is the Phase-1 safety net; the spawn chokepoint makes the jail a later one-component swap).
- Decoupled engine daemon, multi-provider support, batch/feature grouping, per-task config overrides, a separate "morning report".

---

## 3. Core concepts and domain model

Three flat entities (no grouping layer in Phase 1).

### Project
A registered repo + its config. Fields:
- `repoPath`, `integrationBranch` (default `integration/ralph`), `branchPrefix` (default `ralph`)
- `targetBranch` — the single branch the integration branch is **created from** and **promoted into** (own repos: `main`; direct-push teams: the current milestone branch, updated each cycle). See §13.
- `promotionMode` — `pr | direct | strict` (§13)
- `checkCommand` — **mandatory**; the authoritative Layer-A gate
- `acceptanceTemplate` — pre-fills the task form's acceptance field
- `setupCommand` — runs post-worktree to install deps (node_modules etc. are gitignored → absent in fresh worktrees)
- `worktreeDir`, `concurrencyCap` (default **3**), `model` / `claudeArgs`
- `iterationCap` (default 8), `noProgressK` (default 2), `stallTimeoutMin` (default ~40), `checkInIntervalMin` (default 60), `costCap` (optional, default off)
- `autoModeEnvironment` — trusted repos/remotes/domains injected into auto mode (§10)

### Task — *the unit of work, and the stable planner↔engine contract*
The **Task contract is two distinct stored fields**:
- `intent` (prose) — *what to build*. The directive.
- `acceptance` (structured list of shell commands) — *executable proof of done*. **Mandatory.** Stored as separately-runnable commands, never buried in prose (the engine must execute them as Layer B).

Plus: `title`, `projectId`, optional `scopeHint`, and runtime fields `status`, `branchName`, `worktreePath`, `iterationCount`, `lastGateOutput`, `diffstat`, `failureReason`.

> **Why two fields:** intent alone isn't machine-checkable; acceptance alone doesn't say what to build. In Phase 1 the user authors both; in Phase 2 the planner auto-fills the *exact same two fields*, so it plugs in with zero engine reshaping.

**Task status:** `queued → running → { merged | needs-human | abandoned }`, plus `handed-off` (paused for drop-in).

### Iteration — *one cold `claude -p "/goal"` run inside a task*
Fields: `index`, captured **Claude `sessionId`** (feeds drop-in), `startedAt`/`endedAt`, `gateVerdict`, `commitSha`, `tokens`/`durationMs`, `outputTail`.

### The three artifacts (do not conflate)
| Artifact | What | Producer |
|---|---|---|
| **Intent / prompt** | prose: what to build | Phase 1: user · Phase 2: planner |
| **Acceptance** | executable proof of done | Phase 1: user · Phase 2: planner |
| **`/goal` condition** | transcript-provable stop heuristic for the inner session | **always the engine** — *derived* from acceptance + check |

---

## 4. Architecture

- **Electron** desktop app (chosen for the PTY/process/worktree/SQLite workload and Windows cross-platform; matches emdash's proven shape).
- **Engine lives in the Electron main process, tray-resident.** Closing the window hides to the system tray; the engine keeps grinding. Quitting from the tray stops it.
- **Renderer = React cockpit.** Talks to the engine over typed IPC: engine **emits events → renderer subscribes → views update live**; renderer **invokes actions → engine**.
- **SQLite** (better-sqlite3) in the main process for all persistent state.
- **Single agent-spawn chokepoint** — every `claude` invocation goes through one module, so a future Docker jail is a one-line swap (`spawn(claude,…)` → `spawn(docker run … claude,…)`). This is Pail's "only `agent.ts` changes for v2" discipline.

### Process death is cheap (by design)
All task state is on disk — per-iteration commits + the git-excluded progress file. A killed iteration (crash, forced quit, Electron auto-update restart) loses at most the current in-flight turn. **On startup the engine reconciles DB ↔ git** (Pail's `pruneOrphans`, generalized): for every task the DB calls `running`, find its worktree/branch; if gone, re-create and let Ralph re-derive from the last commit; prune worktrees with no live task. This makes the simple tray-in-main-process model resilient without a separate daemon.

---

## 5. The Ralph loop (the heart)

### 5.1 True Ralph: fresh session per iteration
Each iteration is a **cold `claude -p` invocation** that re-derives state from the worktree — *not* a carried conversation. State crosses the cold boundary via (a) per-iteration commits and (b) a git-excluded progress file (§5.4).

### 5.2 Nesting: `/goal` inner, engine gate authoritative
Each iteration is launched as `claude -p "/goal <condition>"` **with auto mode**, so within that one cold session Claude self-drives multiple turns to its *own* believed-done (no per-turn babysitting). The `/goal` evaluator (Haiku) only judges the **transcript** — it can be fooled by a transcript that *claims* success.

Therefore: **after the session ends, the engine independently re-runs the real gates** (Layer A check, then Layer B acceptance). The engine's gate is the *authoritative* exit — `/goal` is only the inner self-stop heuristic. If the engine's gate fails (Haiku was fooled), the **next** fresh iteration gets the **ground-truth failure** injected (§5.5).

> Inner loop = autonomy; outer loop = honesty.

### 5.3 Termination
The loop is literally: `do one iteration → engine re-checks → green? stop : loop`.

A single iteration is bounded by the `/goal` "stop after K turns" clause (§5.5), so it returns control on its own. **Time is never a kill signal for a task** — long, actively-progressing goals routinely run well over an hour and still succeed; killing on elapsed time would murder exactly those.

- **Success exit:** engine gates green.
- **Wedge exits (→ `needs-human`):**
  1. **Iteration cap** — default **8** per task (configurable). A backstop; on a wedged task the no-progress breaker fires first.
  2. **No-progress breaker** — default **K=2**: if K consecutive iterations produce no new commit / no change in the failing-gate output, bail (a pure Ralph loop's signature failure is spinning without advancing).
  3. **Stall detector (hang, not duration)** — if the `stream-json` event stream goes **completely silent for ~40 min** (configurable), the iteration is treated as a genuinely hung process (wedged command / infinite wait — Pail's "check timed out (hang)") and recycled into the normal retry. Fires *only* on a dead stream, never on slow-but-active work.
- **No hard wall-clock or token ceiling.** Instead: a **soft check-in notification** at **1 hour** of a task running, then hourly — purely informational (iteration count + latest activity), dismissible, no action forced. An **optional per-task token/$ cost cap** exists but is **OFF by default**; cumulative spend is always shown on the card.
- Auto-mode **denials fold into the no-progress breaker** — a blocked-but-needed action just fails to advance and is caught there; no separate denial-handling path. Denial reasons are surfaced in the cockpit so the user can extend `autoModeEnvironment`.

### 5.4 What carries across iterations
- **Code:** the **engine commits after every iteration** on the task branch (`ralph: iter N — <task>`), not the agent — crash-safe, gives the cold next iteration a clean tree, and is the trail you inspect on drop-in. On green, **squash-merge** the task branch into the integration branch (one-commit-per-task, clean history).
- **Reasoning:** a git-excluded `.ralph/progress.md` the agent **reads first / updates last** each iteration, kept in a light fixed structure — **`Current focus` / `Done` / `Remaining` / `Tried & ruled out`** — so a cold session doesn't re-walk dead ends *and* the cockpit can render it tidily. Engine-seeded on iteration 1. (Fallback to free-form markdown if the structure proves fussy.)
- **Both `.ralph/` files are git-excluded** (engine adds them to `.git/info/exclude`, Pail's trick) so they persist across iterations on disk but never enter a commit and never reach `targetBranch`. **Lifetime == worktree lifetime; removed with the worktree; no doc rot.**

### 5.5 What the engine feeds each iteration
- **Standing instructions ("the Ralph ritual")** live in git-excluded `.ralph/INSTRUCTIONS.md` (read progress first; continue; don't re-walk listed dead-ends; run check + acceptance yourself; stay in scope; update progress last) — *not* crammed into the `/goal` condition.
- **The `/goal` condition** is the lean, transcript-provable end-state: *"`<checkCommand>` exits 0 and every acceptance command exits 0, both shown in this transcript; no files outside `<scope>` changed; or stop after K turns."*
- **Task intent + acceptance commands** delivered in the initial directive, pointing at the managed files.
- **On retry, the engine injects the real prior-gate failure** (actual check/acceptance output tail) — the ground truth a cold `/goal` session can't otherwise see.

*(Exact CLI string finalized at build; the spec fixes this structure.)*

### 5.6 Invocation + observability
Spawn `claude -p "/goal <condition>" --output-format stream-json --verbose --session-id <uuid> <auto-mode flags>`. Parse the NDJSON event stream for three things:
- **session id** (init event) → captured for drop-in (from iteration 1)
- **assistant text + tool-use events** → the cockpit live activity feed
- **final result event** (tokens/cost/duration) → accounting + ceiling enforcement

Raw stream is appended to a **per-iteration log file** (what drop-in/debugging reads); parsed events push to the renderer. No PTY / no terminal-scraping (emdash's "explicit events, never infer from terminal" principle).

### 5.7 Permissions / safety: auto mode (not bypassPermissions)
Each iteration runs in **auto mode** — the classifier auto-approves routine work but still blocks anything irreversible, destructive, or aimed outside the environment (force-push, `curl | bash`, prod deploys, exfiltration). This is a **real safety net on the host even without Docker**, and it's what Pail already uses.

- Engine injects `autoMode.environment` **per spawn** (via `--settings` inline JSON) declaring the project's trusted repo + remotes + configured domains. (The classifier does not read `autoMode` from checked-in `.claude/settings.json`, so a repo can't smuggle in allow rules.)
- **Never-push is absolute, belt-and-suspenders:** a `permissions.deny` hard block on pushes to protected branches (runs *before* the classifier, can't be overridden) **plus** Pail's trunk-guard hook.

---

## 6. Concurrency and the merge stage

**Full parallel from Phase 1.** Greenfield dissolves Pail's parallel blockers (no shared working tree — every task has its own worktree; no contested label pool — the queue is the app DB). The scheduler hands each worktree to exactly one task, bounded by `concurrencyCap` (default 3, configurable).

The genuinely hard part, built correctly from the start:
- **Serialized merge stage (one mutex)** — if two tasks go green at once they cannot both merge to integration simultaneously.
- **Rebase-on-tip + re-check before each merge** — task B re-checks against the integration tip task A just produced, or you get silent semantic conflicts that compile but break.

---

## 7. Verification gates

Both **mandatory** (no check-only tasks):
- **Layer A — repo check** (`checkCommand`): the floor.
- **Layer B — acceptance** (the task's command list, run sequentially, stop at first failure — ported from Pail's `acceptance.ts`).

**Two-layer independence:** the agent runs check + acceptance itself inside each iteration (self-correction), but the **engine re-runs both independently** after the session ends — test-author ≠ implementer.

---

## 8. Drop-in handoff

- **Available anytime** — not just on `needs-human`; you can grab a healthy mid-grind task you see going sideways.
- **Grabbing it pauses the loop for that task** (state → `handed-off`); the engine stops touching that worktree and **frees a concurrency slot**.
- **Launches a configurable terminal into the worktree, resuming the latest session** — Windows default `wt.exe -d {worktree} claude --resume {lastSessionId}` (with "start fresh" + a config template). (This is why we capture session ids.)
- **Explicit two-button hand-back:**
  - **Resume autonomous loop** — engine continues Ralph from your committed state.
  - **I finished it — verify & merge** — engine runs the gates once; green → squash-merge, red → `needs-human`.
  - The engine **commits your working tree before either**, so nothing is lost.

---

## 9. Project registration & config

- **DB-stored, GUI-managed** (not a `.pail`-style repo file — cleaner for a single-user GUI, nothing to git-exclude).
- **Auto-detect then confirm** on registration: propose trunk (current branch), `integration/ralph`, a detected `test`/`check` script, detected package manager → setup command; user confirms/edits.
- **Check command is mandatory** — registration isn't complete without it (no authoritative gate otherwise).

---

## 10. Task creation (Phase 1's only way in)

A **new-task form**:
- **Title**, **Project** (supplies defaults/trust), **Intent/prompt**, **Acceptance commands** (free-text shell lines, pre-filled from the project template — **mandatory**), **Scope hint** (optional → feeds the `/goal` no-out-of-scope clause).
- Everything else (model, iteration cap, concurrency) **inherits project defaults**.
- On submit → `queued`; the scheduler starts it when a slot frees under the cap.

---

## 11. The cockpit (functional scope; pixels deferred)

**Task-centric board** (the control-room glance), filterable by project.

- **Board:** every task as a card under its status lane (`queued · running · needs-human · handed-off · merged`). Running cards show a live one-line activity + iteration count.
- **Task detail (click a card):**
  - **Live activity feed** (parsed §5.6 events, real-time) + "view raw log" (per-iteration log).
  - **Iteration history** (verdict, diffstat, tokens/time per iteration).
  - **Current diffstat + failing gate output** (when red), and a **collapsible, read-only `progress.md` panel** (latest version, refreshed each iteration, rendered from its `Current focus / Done / Remaining / Tried & ruled out` structure — edited only by dropping in).
  - **Contextual actions:** Drop-in (always); `needs-human` → failure reason + Abandon; `handed-off` → the two hand-back buttons; `merged` → promote.
- **Project sidebar/manager** (§9) — each with its queue, cap, token spend.
- **New-task form** (§10) as a modal/panel.
- **Global header + tray** — aggregate counts (running / queued / needs-human) + today's token spend; tray reflects activity when hidden; the hourly **check-in notification** (§5.3) surfaces here and as an OS notification.

---

## 12. Worktree & branch lifecycle

- **Create** per task from the integration branch; branch `<branchPrefix>/<task>` (e.g. `ralph/task-N`).
- **Cleanup the moment it's no longer needed** (no orphans, same discipline as the progress file):
  - **green merge** → remove worktree (+ delete task branch after squash-merge).
  - **abandon** → remove worktree + delete branch.
  - **needs-human** → **retain** the worktree (it's in use for drop-in) until you resolve/dismiss, then remove.
  - **orphans** (from a crash) → pruned/adopted on boot (§4).

---

## 13. Promotion (integration → target)

**Invariant (non-negotiable):** the tool **never pushes to or merges the `targetBranch` itself.** The target only changes by a human action. Enforced against the agent by auto mode + `permissions.deny`.

- **Granularity:** promote the integration branch **as a batch** (the accumulated greens) — one graduation, clean history. Before *any* mode promotes, the engine **rebases on the fresh `origin/targetBranch` tip and re-checks in an isolated throwaway worktree** — the same merge-and-verify-in-isolation primitive the engine uses everywhere, so promotion never touches your checked-out branches and never merges on a stale base.
- **`promotionMode` per project:**
  - **`pr`** *(default, own repos)* — rebase + re-check (above), then push the *integration* branch (non-protected) + `gh pr create` targeting `targetBranch`; **you** merge.
  - **`direct`** *(Inact-style teams with no PRs)* — tool `fetch`es, creates a fresh **promote branch off `origin/targetBranch`** (never a stale local) in a **throwaway worktree**, merges `integration` with **`--no-ff --no-edit`** (kills the editor-abort footgun that once silently dropped a commit's content in Pail/Inact), re-checks there, then hands you the exact command to fast-forward `targetBranch` and push; **you** push. It never touches your checked-out branches. `targetBranch` = the current milestone branch, updated each cycle.
  - **`strict`** *(remote-less / paranoid)* — tool confirms green and prints every command; you do the merge and push.

---

## 14. Failure handling

- A wedged/failed task → `needs-human`: flagged with a **reason**, worktree **retained** for drop-in. The cockpit surfaces the reason + the failing output.
- The user resolves by **dropping in** (then hand-back) or **abandoning** (cleanup).
- **Circuit breaker** at the engine level (consecutive failures) as a backstop, ported from Pail.

---

## 15. Persistence (SQLite)

- **DB authoritative for** the queue, task identity/status, iteration history, project config — *what to do and what happened*.
- **Git / worktree authoritative for** the actual code, commits, and the `.ralph/` files — *the work itself*.
- **Reconcile on boot** (§4).
- Tables (sketch): `projects`, `tasks`, `iterations`. Schema finalized in the implementation plan.

---

## 16. Module decomposition (sketch — mirrors Pail's DI/testable style)

Main-process engine:
- `loop` — the Ralph orchestrator (termination, scheduling)
- `spawn` — **the single agent-spawn chokepoint** (stream-json, session id, auto-mode settings injection, process kill)
- `gates/check`, `gates/acceptance` — verification (ported from Pail)
- `worktree` — create/remove/prune/setup (ported + extended)
- `merge` — commit, squash-merge, rebase-on-tip, diffstat, the merge mutex
- `promote` — pr/direct/strict, re-check
- `prompt` — builds the per-iteration directive + `/goal` condition + `.ralph/` managed files
- `db` — SQLite, reconciliation
- `events` / `ipc` — engine→renderer events, renderer→engine actions
- `tray`, `terminal-launch` (drop-in)

Renderer:
- `board`, `task-detail` (live feed, iteration history), `projects`, `new-task-form`, `header/tray-status`

---

## 17. Out of scope / deferred

- **Phase 2:** in-app planner (grill-me → PRD → issues auto-filling the Task contract); batch/feature grouping (`batchId`).
- **Phase 3:** richer control room, scale, reports.
- **Later, independent:** Docker/sandbox jail (one-component swap at the spawn chokepoint); decoupled engine daemon (headless/server runs); multi-provider; per-task config overrides; config export/import.

---

## 18. Assumptions & build-time verifications

- **Claude Code `≥ 2.1.139`** (for `/goal`) — engine asserts on startup.
- **`/goal` composes with `--output-format stream-json` in `-p` mode** — strongly expected (docs say `/goal` runs non-interactively; stream-json is just an output format) — **verify at build**.
- **Exact flag to enable auto mode headless** — Pail uses `--permission-mode auto`; confirm against the permission-modes page at build.
- **Auth** — engine spawns the user's already-logged-in `claude` CLI; no separate auth.
- **`gh`** available for `pr` promotion mode.
- **Windows terminal launch** specifics (`wt.exe` present; fallback shell) — verify; make the launch command a config template.

---

## 19. Open questions — resolved 2026-06-28

1. **Iteration cap = 8** (configurable). **No time/token kill caps** — time is a health signal, not a guillotine: a **stall detector** (~40 min of silent `stream-json`) catches genuine hangs, a **soft hourly check-in notification** (from 1h) keeps you informed, and the no-progress breaker (K=2) + iteration cap are the real bounds. Optional per-task cost cap, **off by default**. (See §5.3.)
2. **Collapsible, read-only `progress.md` panel** in task detail, lightly structured (`Current focus / Done / Remaining / Tried & ruled out`); the board card stays on the live feed. (See §5.4, §11.)
3. **`direct` promotion prepares a promote branch off `origin/targetBranch` in a throwaway worktree** (`--no-ff --no-edit`, re-check, hand the user the push), never touching checked-out branches; the rebase-on-fresh-target + re-check-in-isolation generalizes to `pr` mode too. (See §13.)
