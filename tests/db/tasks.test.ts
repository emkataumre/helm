// tests/db/tasks.test.ts
import { openDb } from "../../src/main/db/db";
import { insertTask, getTask, listTasks, updateTask } from "../../src/main/db/tasks";

it("inserts a queued task, round-trips acceptance, updates status", () => {
    const db = openDb(":memory:");
    const t = insertTask(db, { projectId: "p1", title: "T", intent: "do it", acceptance: ["npm test -- x"] });
    expect(t.status).toBe("queued");
    expect(getTask(db, t.id)?.acceptance).toEqual(["npm test -- x"]);
    updateTask(db, t.id, { status: "merged", diffstat: "+3 -1" });
    const got = getTask(db, t.id)!;
    expect(got.status).toBe("merged");
    expect(got.diffstat).toBe("+3 -1");
    expect(listTasks(db)).toHaveLength(1);
    db.close();
});

// M5: "handed-off" is the new drop-in pause status. The tasks.status column is plain TEXT (no CHECK),
// so the value needs no migration — but it must round-trip through updateTask/getTask like any other.
it("round-trips the handed-off status (the M5 drop-in pause state)", () => {
    const db = openDb(":memory:");
    const t = insertTask(db, { projectId: "p1", title: "T", intent: "do it", acceptance: ["x"] });
    updateTask(db, t.id, { status: "handed-off" });
    expect(getTask(db, t.id)?.status).toBe("handed-off");
    db.close();
});

// M9: dependency edges. An absent list defaults to [] on both insert-return and read; a provided list
// round-trips through JSON. Empty = stored NULL, read back as [] (byte-identical to a Phase-1 task).
it("round-trips dependsOn edges; an absent list defaults to []", () => {
    const db = openDb(":memory:");
    const a = insertTask(db, { projectId: "p1", title: "A", intent: "x", acceptance: ["x"] });
    expect(a.dependsOn).toEqual([]);                        // absent on input → [] on the returned task
    expect(getTask(db, a.id)?.dependsOn).toEqual([]);       // …and on read (stored NULL → [])
    const b = insertTask(db, { projectId: "p1", title: "B", intent: "x", acceptance: ["x"], dependsOn: [a.id] });
    expect(b.dependsOn).toEqual([a.id]);
    expect(getTask(db, b.id)?.dependsOn).toEqual([a.id]);   // persisted + round-trips through JSON
    db.close();
});
