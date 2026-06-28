// tests/db/db.test.ts
import { openDb } from "../../src/main/db/db";

it("creates projects, tasks, iterations tables", () => {
    const db = openDb(":memory:");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["projects", "tasks", "iterations"]));
    db.close();
});
