// src/main/engine/verifyState.ts
// The build-once core: one reducer over EngineSnapshot, feeding both the live cockpit (real stream
// events) and the M3 verify slice (scripted events incl. probes). Pure — no IO, no Electron — so
// the live engine owns one draft per task and the verify runner reduces over a fresh emptySnapshot.
import type {
    EngineSnapshot, SnapshotEvent, IterationView, TokenTotals, ActivityEntry, TaskStatus, Iteration, Task,
} from "../../shared/types";

const FEED_CAP = 200;

export function emptyTokens(): TokenTotals {
    return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0 };
}

// ── Token accounting: the canonical derivations ─────────────────────────────────────────────────
// Characterised against claude's stream-json terminal result event (result.usage):
//   input_tokens                = NON-cached input only (tiny once caching kicks in)
//   output_tokens               = generated output — what a human means by "tokens the agent produced"
//   cache_read_input_tokens     = context RE-READS (~10% of input price; dwarfs every other field summed)
//   cache_creation_input_tokens = context newly written to cache (billed at 1.25× input)
// The old headline summed input+output (and the fleet card added both cache fields on top), so the
// displayed number tracked cache traffic, not work. The HEADLINE is OUTPUT tokens only.
export function headlineTokens(t: TokenTotals): number {
    return t.output;
}

// BILLABLE tokens — the runaway-backstop currency (the M12 synthetic-$ cap's successor): everything
// the API meaningfully bills per NEW token — input + output + cacheCreation — cacheRead EXCLUDED, so
// a long-lived cached session is not punished for cheap re-reads. runTaskLoop accumulates this per
// iteration and parks needs-human once the run crosses LoopConfig.tokenCap.
export function billableTokens(t: TokenTotals): number {
    return t.input + t.output + t.cacheCreation;
}

export function emptySnapshot(taskId: string, status: TaskStatus = "queued"): EngineSnapshot {
    return {
        taskId, status, currentIteration: null,
        iterations: [], totals: emptyTokens(),
        feed: [], feedEventsConsumed: 0, terminalReason: null,
    };
}

function freshIteration(index: number): IterationView {
    return { index, verdict: null, tokens: emptyTokens(), durationMs: null, sessionId: null, commitSha: null, outputTail: null };
}

// totals is always the sum of the per-iteration series — recomputed from scratch so it can never
// drift from the iterations it claims to summarize (the token-accounting invariant relies on this).
function recomputeTotals(s: EngineSnapshot): void {
    const t = emptyTokens();
    for (const it of s.iterations) {
        t.input += it.tokens.input;
        t.output += it.tokens.output;
        t.cacheRead += it.tokens.cacheRead;
        t.cacheCreation += it.tokens.cacheCreation;
        t.costUsd += it.tokens.costUsd;
    }
    s.totals = t;
}

function pushFeed(s: EngineSnapshot, entry: ActivityEntry): void {
    s.feed.push(entry);
    s.feedEventsConsumed += 1;                              // counts every feed event, ever
    if (s.feed.length > FEED_CAP) s.feed.splice(0, s.feed.length - FEED_CAP); // trim oldest; consumed unchanged
}

// Mutates the caller-owned draft and returns it (so the live engine can keep one draft per task).
export function applyEvent(draft: EngineSnapshot, event: SnapshotEvent): EngineSnapshot {
    switch (event.type) {
        case "iteration-start": {
            draft.iterations.push(freshIteration(event.index));
            draft.currentIteration = { index: event.index, phase: "spawning", latestActivity: "" };
            break;
        }
        case "assistant": {
            pushFeed(draft, { iterationIndex: event.index, kind: "assistant", text: event.text });
            if (draft.currentIteration) {
                draft.currentIteration.latestActivity = event.text;
                // First agent output ⇒ we're past launch: spawning → working (gates flip it later).
                if (draft.currentIteration.phase === "spawning") draft.currentIteration.phase = "working";
            }
            break;
        }
        case "tool-use": {
            pushFeed(draft, { iterationIndex: event.index, kind: "tool-use", text: event.name });
            if (draft.currentIteration) {
                draft.currentIteration.latestActivity = event.name;
                if (draft.currentIteration.phase === "spawning") draft.currentIteration.phase = "working";
            }
            break;
        }
        case "gate": {
            pushFeed(draft, { iterationIndex: event.index, kind: "gate", text: event.label });
            if (draft.currentIteration) {
                draft.currentIteration.latestActivity = event.label;
                const l = event.label.toLowerCase();
                if (l.includes("accept")) draft.currentIteration.phase = "accepting";
                else if (l.includes("check")) draft.currentIteration.phase = "checking";
            }
            break;
        }
        case "usage": {
            const it = draft.iterations.find((i) => i.index === event.index);
            if (it) {
                it.tokens = event.tokens;
                if (event.durationMs !== undefined) it.durationMs = event.durationMs;
                if (event.sessionId !== undefined) it.sessionId = event.sessionId;
            }
            recomputeTotals(draft);
            break;
        }
        case "iteration-end": {
            const it = draft.iterations.find((i) => i.index === event.index);
            if (it) { it.verdict = event.verdict; it.commitSha = event.commitSha; it.outputTail = event.tail || null; }
            draft.currentIteration = null;
            break;
        }
        case "status": {
            draft.status = event.status;
            if (event.terminalReason !== undefined) draft.terminalReason = event.terminalReason;
            break;
        }
    }
    return draft;
}

// Rebuild a snapshot from durable DB rows for an inactive/restarted task. The feed stays EMPTY —
// the ring is in-memory-only; the raw per-iteration log is the durable activity archive.
export function snapshotFromRows(
    task: Pick<Task, "id" | "status" | "failureReason">,
    rows: Iteration[],
): EngineSnapshot {
    const s = emptySnapshot(task.id, task.status);
    s.terminalReason = task.failureReason ?? null;
    for (const r of rows) {
        s.iterations.push({
            index: r.index,
            verdict: r.gateVerdict,
            tokens: {
                input: r.inputTokens ?? 0,
                output: r.outputTokens ?? 0,
                cacheRead: r.cacheReadTokens ?? 0,
                cacheCreation: r.cacheCreationTokens ?? 0,
                costUsd: r.costUsd ?? 0,
            },
            durationMs: r.durationMs,
            sessionId: r.sessionId,
            commitSha: r.commitSha,
            outputTail: r.outputTail || null,
        });
    }
    recomputeTotals(s);
    return s;
}
