// src/main/engine/deps.ts
// The M9 dependency gate — one deliberate engine change (spec §6). A task branches off the integration tip
// when it STARTS, so a child started before its parent MERGES builds against code that lacks the parent's
// work, thrashes its iterationCap, and lands a false needs-human. So the scheduler holds a child until every
// parent has merged. "blocked" is DERIVED from these edges + live parent statuses — there is NO new
// TaskStatus, and the state machine is untouched. Leaf module (types only) so the scheduler AND the cockpit
// derivation import the exact same predicate.
import type { Task, TaskStatus, WaitingOn } from "../../shared/types";

// A parent is "satisfied" iff it has MERGED (its code is on integration) OR is UNKNOWN (undefined — the row
// was deleted; deletion is deliberate human intent, so treat it as satisfied rather than wedge the child
// forever on a ghost). Every other status (queued/running/handed-off = in flight; needs-human/abandoned =
// stuck) leaves the child blocked. .every over an empty edge list is true, so a no-deps task is free.
export function depsSatisfied(task: Task, getStatus: (id: string) => TaskStatus | undefined): boolean {
    return task.dependsOn.every((id) => {
        const status = getStatus(id);
        return status === undefined || status === "merged";
    });
}

// The cockpit-facing derivation: the UNMERGED existing parents this task waits on, each with its title +
// status (so the card can render "waiting on X" and tell in-flight from stuck). Merged and deleted (unknown)
// parents are satisfied, so they're dropped. By construction `waitingOnFor(t).length > 0` ⟺ `!depsSatisfied`,
// so `blocked = waitingOnFor(t).length > 0` — the same truth the scheduler gates on, rendered for a human.
export function waitingOnFor(task: Task, lookup: (id: string) => Task | undefined): WaitingOn[] {
    const out: WaitingOn[] = [];
    for (const id of task.dependsOn) {
        const parent = lookup(id);
        if (!parent || parent.status === "merged") continue; // satisfied → not waited on
        out.push({ id, title: parent.title, status: parent.status });
    }
    return out;
}
