// src/main/engine/deps.ts
// The M9 dependency gate — one deliberate engine change (spec §6). A task branches off the integration tip
// when it STARTS, so a child started before its parent MERGES builds against code that lacks the parent's
// work, thrashes its iterationCap, and lands a false needs-human. So the scheduler holds a child until every
// parent has merged. "blocked" is DERIVED from these edges + live parent statuses — there is NO new
// TaskStatus, and the state machine is untouched. Leaf module (types only) so the scheduler AND the cockpit
// derivation import the exact same predicate.
import type { Task, TaskStatus } from "../../shared/types";

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
