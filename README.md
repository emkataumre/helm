# Helm

An Electron desktop **cockpit for running autonomous "Ralph loop" Claude Code agents in parallel** — plan work into tasks, let a fleet of agents grind them in isolated git worktrees, watch everything live, drop into any session and take the wheel, and promote the accumulated green work to trunk with one explicit human action.

Helm is the GUI successor in spirit to [Pail](https://github.com/emkataumre/pail) (its safety core — worktree isolation, independent gates, never-push — is ported faithfully) and adds what Pail deliberately lacked: real-time steering.

## The loop

Each task runs a **Ralph loop**: a fresh `claude -p "/goal …"` session per iteration, with all state on disk (per-iteration commits plus git-excluded `.ralph/` files), so process death is cheap and every iteration starts clean.

1. **Register a project** — repo path, check command, integration/target branches, optional setup command, loop bounds.
2. **Create tasks** — the contract is `intent` (prose) plus mandatory structured **acceptance commands**. Tasks can declare `dependsOn` edges; children wait for their parents to *merge*.
3. The **scheduler** auto-starts queued tasks up to a per-project concurrency cap. Each task gets its own git worktree and branch — agents never touch your working tree.
4. Per iteration, the agent works toward the `/goal`; the engine commits its work, then **independently re-runs both gates** (project check ∧ task acceptance) as the authoritative exit — the in-session goal evaluator only sees the transcript and can be fooled; the engine's gate can't.
5. On green, a **serialized merge stage** squash-merges the task onto the integration branch: rebase onto the fresh tip in a throwaway worktree, re-run both gates there, and advance the ref atomically only if they pass. A task that loses the race to a moved tip **recycles in-place** (bounded) with the conflict fed back into its next prompt; what the loop can't fix parks at `needs-human`.
6. Wedge exits keep unattended runs bounded: iteration cap, no-progress breaker, silent-stream stall detector, per-run **cost cap**, and a deny-wall breaker (a load-bearing permission denial repeating across iterations escalates early instead of burning the budget).
7. **Promotion is yours.** A Promote action validates the whole integration branch against a fresh trunk tip and hands you the exact command — the tool **never pushes or merges the target branch itself**. That invariant is enforced three ways: a `permissions.deny` block injected per spawn, a trunk-guard hook installed in every task worktree, and (in jail mode) the real origin simply not existing inside the container.

## What's in the cockpit

- **Board** — task lanes (queued / running / needs-human / handed-off / merged), live per-task one-liners, plan badges and filters, dependency "waiting on" indicators.
- **Task detail** — a live activity feed from the agent's event stream, per-iteration token/cost accounting, gate results with evidence, the task's evolving `progress.md`.
- **Drop-in handoff** — hard-interrupt a live agent mid-iteration (its work is checkpoint-committed), take over in a terminal resuming the same Claude session, then hand back: *Resume loop* (fresh budget, same worktree) or *Verify & merge*.
- **Terminals** — a full in-app terminal manager (xterm.js + node-pty): free-form tabs on projects and retained worktrees, scrollback re-attach, external-terminal fallback.
- **Planner** — an embedded `claude` session runs your real planning workflow (brainstorm → PRD → tasks); drafts travel over a watched `.helm/plan/` file seam into a side rail, get **pre-flighted** (each acceptance command is actually executed in a throwaway worktree and classified), and queue as dependency-ordered tasks only after every warning is explicitly acknowledged.
- **Conductor** — one persistent Claude session per project as its single touchpoint, backed by a blessed `helm` CLI over a per-instance named pipe (`status` / `task` / `progress` / `plan status` / `failures` reads; `pause` / `resume` / `abandon` / `clear-deps` steers). It has **no autonomy** — it acts only in conversation; the loop stays the only autonomous layer.
- **Docker jail (opt-in, per project)** — run iterations with full permissions (`--dangerously-skip-permissions`) inside a container instead of tuning host auto-mode. Git is the wall: the container sees only a bare exchange repo and pushes its task branch back; the engine fetches into a host worktree and runs the gates there. The authoritative gates never move inside the jail.
- **Failure ledger** — a durable, append-only history of every engine failure (`helm failures`): kind (merge-conflict, re-check failed, cost cap, deny wall, …), evidence, and whether it resolved itself, was recycled back to the agent, or needed a human.
- **Tray residence** — close the window and the engine keeps grinding; boot reconcile + crash-resume make a hard kill recoverable (DB is authoritative for state, git for code, and the engine reconciles the two on boot).

## Stack & layout

TypeScript (ESM) · Electron + electron-vite · React 18 · better-sqlite3 · node-pty + xterm.js · Vitest.

```
src/main/         Electron main process
  engine/         the pure engine — DI functions, Electron-free, unit-tested
  db/             better-sqlite3 (migration stepper on PRAGMA user_version)
  ctl/            the blessed `helm` CLI protocol (named pipe)
  ipc.ts          typed IPC edge
src/preload/      the window.helm bridge
src/renderer/     the React cockpit
src/shared/       shared types
tests/
  renderer/       headless component render tests
  verify/         runtime-verification slices (invariants + must-FAIL probes)
  accept/         live acceptance — drives the real built app
```

`src/main/engine/spawn.ts` is the single chokepoint every agent spawn goes through — which is what made the Docker jail a one-seam change.

## Running it

Requirements: Node 24+, git, and [Claude Code](https://claude.com/claude-code) ≥ 2.1.139 on PATH and authenticated (the `/goal` command is load-bearing). Docker is only needed for jail-enabled projects. Developed and tested on Windows 11 (ConPTY); not yet packaged — run from source.

```sh
npm install
npm run dev      # the live app
```

Checks, in this order (the better-sqlite3 native module is swapped between the node and electron ABIs by pre-steps, so order matters):

```sh
npm run check    # typecheck + headless Vitest (renderer + verify slices)
npm run build    # electron-vite build
npm run accept   # live acceptance: drives the real built app via playwright-core
```

## How it's tested

Three layers, cheapest first:

1. **Headless render tests** — presentational components assert a machine-readable `data-verify-*` contract (stripped from prod builds).
2. **Verify slices** — every feature ships `tests/verify/<slice>/`: a machine-readable surface, declared invariants, and at least one **probe** (a deliberately-wrong fixture that must FAIL — a suite that can't catch a lie is a happy-path replay). Safety invariants like *no-merge-on-red*, *never-push-target*, and *gates-run-host-side* live here.
3. **Live acceptance** — `playwright-core`'s `_electron` driver runs the real built app against a throwaway data dir (your real board is unreachable by construction), agent-free, including a negative control that proves the harness catches false assertions.

## Status

Personal project, moving fast. The executor spine, the in-app planner, and most of the riskier-autonomy phase (unattended guards, Docker jail, conductor, failure ledger + feedback) are built and verified; cockpit polish and packaged distribution are next. Helm builds itself: since the guards milestone, new Helm features are dogfooded as Helm tasks.
