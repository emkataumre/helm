// src/main/engine/snapshotStore.ts
// The per-task live-snapshot registry: the engine keeps one EngineSnapshot draft per active task,
// and dispatch reduces a SnapshotEvent into it (via the shared applyEvent) then notifies. Extracted
// from ipc.ts so the dispatch path is Electron-free and unit-testable; ipc.ts supplies the onChange
// that pushes to the renderer.
import type { EngineSnapshot, SnapshotEvent, TaskStatus } from "../../shared/types";
import { emptySnapshot, applyEvent } from "./verifyState";

export interface SnapshotStore {
    ensure: (taskId: string, status?: TaskStatus) => EngineSnapshot;
    get: (taskId: string) => EngineSnapshot | undefined;
    dispatch: (taskId: string, event: SnapshotEvent) => EngineSnapshot;
    delete: (taskId: string) => void;
}

export function createSnapshotStore(onChange?: (taskId: string, snapshot: EngineSnapshot) => void): SnapshotStore {
    const map = new Map<string, EngineSnapshot>();
    const ensure = (taskId: string, status?: TaskStatus): EngineSnapshot => {
        let s = map.get(taskId);
        if (!s) { s = emptySnapshot(taskId, status); map.set(taskId, s); }
        return s;
    };
    return {
        ensure,
        get: (taskId) => map.get(taskId),
        delete: (taskId) => { map.delete(taskId); },
        dispatch: (taskId, event) => {
            const s = ensure(taskId);
            applyEvent(s, event);
            onChange?.(taskId, s);
            return s;
        },
    };
}
