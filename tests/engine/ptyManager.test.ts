// tests/engine/ptyManager.test.ts
// PtyManager is the pure, DI'd home of all PTY lifecycle — Electron-free, fake-able, so the native
// node-pty module NEVER loads in a test (it stays behind the injected factory; the real one is wired in
// ipc.ts). These tests drive the REAL createPtyManager with a fake factory that records every call and
// lets the test push data / fire exit on demand. Behaviour through the public interface only.
import { describe, it, expect } from "vitest";
import { createPtyManager, SCROLLBACK_CAP, sanitizeReplay, type PtyFactory, type PtyHandle } from "../../src/main/engine/ptyManager";

// A fake PTY handle: records writes/resizes/kills and exposes emit()/fireExit() so a test can drive it.
interface FakeHandle extends PtyHandle {
    cmd: string; args: string[]; opts: { cwd: string; cols: number; rows: number };
    writes: string[]; resizes: Array<[number, number]>; killCount: number;
    emit: (data: string) => void;
    fireExit: (code: number) => void;
}
function makeFakeFactory() {
    const handles: FakeHandle[] = [];
    const factory: PtyFactory = (cmd, args, opts) => {
        let onData: ((d: string) => void) | undefined;
        let onExit: ((code: number) => void) | undefined;
        const h: FakeHandle = {
            cmd, args, opts, writes: [], resizes: [], killCount: 0,
            onData: (cb) => { onData = cb; },
            onExit: (cb) => { onExit = cb; },
            write: (d) => { h.writes.push(d); },
            resize: (c, r) => { h.resizes.push([c, r]); },
            kill: () => { h.killCount++; },
            emit: (d) => onData?.(d),
            fireExit: (code) => onExit?.(code),
        };
        handles.push(h);
        return h;
    };
    return { factory, handles };
}
const create = (m: ReturnType<typeof createPtyManager>, over: Partial<Parameters<typeof m.create>[0]> = {}) =>
    m.create({ cwd: "/wt/a", argv: ["pwsh.exe", "-NoExit", "-Command", "claude"], kind: "dropin", title: "T", ...over });

describe("createPtyManager.create", () => {
    it("spawns via the factory (argv[0]=cmd, rest=args) and returns a PtySession with a uuid", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m, { cwd: "/wt/x", argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume z"], kind: "planner", title: "Plan", taskId: "t1", projectId: "p1" });
        expect(s.id).toMatch(/[0-9a-f-]{36}/);
        expect(s).toMatchObject({ kind: "planner", title: "Plan", cwd: "/wt/x", taskId: "t1", projectId: "p1" });
        expect(handles).toHaveLength(1);
        expect(handles[0].cmd).toBe("pwsh.exe");
        expect(handles[0].args).toEqual(["-NoExit", "-Command", "claude --resume z"]);
        expect(handles[0].opts.cwd).toBe("/wt/x");
        expect(handles[0].opts.cols).toBeGreaterThan(0);
        expect(handles[0].opts.rows).toBeGreaterThan(0);
    });

    it("assigns a distinct id per session", () => {
        const { factory } = makeFakeFactory();
        const m = createPtyManager(factory);
        expect(create(m).id).not.toBe(create(m).id);
    });
});

describe("write / resize / kill forwarding + idempotence", () => {
    it("write(id,data) and resize(id,c,r) forward to the session's handle", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        m.write(s.id, "ls\r");
        m.resize(s.id, 100, 40);
        expect(handles[0].writes).toEqual(["ls\r"]);
        expect(handles[0].resizes).toEqual([[100, 40]]);
    });

    it("write / resize / kill on an unknown id are silent no-ops (never throw)", () => {
        const { factory } = makeFakeFactory();
        const m = createPtyManager(factory);
        expect(() => { m.write("nope", "x"); m.resize("nope", 1, 1); m.kill("nope"); }).not.toThrow();
    });

    it("kill(id) invokes handle.kill once and is idempotent (killing a dead id is a no-op)", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        m.kill(s.id);
        m.kill(s.id); // idempotent
        expect(handles[0].killCount).toBe(1);
        expect(m.list().find((x) => x.id === s.id)?.alive).toBe(false);
    });
});

describe("attach replays scrollback then streams live; detach stops the stream", () => {
    it("replays buffered data (in order) on attach, then streams subsequent data", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        handles[0].emit("one ");
        handles[0].emit("two ");     // written BEFORE attach → must appear in the replay, in order
        const seen: string[] = [];
        m.attach(s.id, (d) => seen.push(d));
        expect(seen.join("")).toContain("one two ");
        handles[0].emit("three");    // live stream after attach
        expect(seen.join("")).toContain("three");
    });

    it("detach stops live streaming (scrollback keeps accumulating for the next attach)", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        const seen: string[] = [];
        m.attach(s.id, (d) => seen.push(d));
        handles[0].emit("live");
        m.detach(s.id);
        handles[0].emit("after-detach");
        expect(seen.join("")).toContain("live");
        expect(seen.join("")).not.toContain("after-detach");
        // a fresh attach replays everything, including what arrived while detached
        const seen2: string[] = [];
        m.attach(s.id, (d) => seen2.push(d));
        expect(seen2.join("")).toContain("after-detach");
    });

    it("attaching to an unknown id is a silent no-op", () => {
        const { factory } = makeFakeFactory();
        const m = createPtyManager(factory);
        expect(() => m.attach("nope", () => {})).not.toThrow();
    });

    it("a re-attach REPLAY strips terminal query/response sequences (the `[?1;2c` pin/unpin bug)", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        const ESC = "\x1b";
        // The shell's init wrote a Device-Attributes query + response into scrollback; a naive replay
        // would make xterm re-answer and pwsh echo the `[?1;2c` junk on every re-attach.
        handles[0].emit(`prompt> ${ESC}[c${ESC}[?1;2c${ESC}[6n done`);
        const seen: string[] = [];
        m.attach(s.id, (d) => seen.push(d));
        const replay = seen.join("");
        expect(replay).toContain("prompt>");         // visible text survives
        expect(replay).toContain("done");
        expect(replay).not.toContain(`${ESC}[?1;2c`); // the DA response is gone from the replay
        expect(replay).not.toContain(`${ESC}[c`);     // …and the query that re-triggers it
        expect(replay).not.toContain(`${ESC}[6n`);    // …and the cursor-position query
    });
});

describe("sanitizeReplay — strips only query/response sequences, never visible output", () => {
    const ESC = "\x1b";
    it("removes DA (`[c`,`[?1;2c`), DSR (`[6n`) and cursor-position reports (`[r;cR`)", () => {
        const out = sanitizeReplay(`a${ESC}[cb${ESC}[?1;2cc${ESC}[6nd${ESC}[12;34Re`);
        expect(out).toBe("abcde");
    });
    it("PROBE: ordinary SGR colours and cursor MOVES (uppercase C/D, `m`, `J`) are untouched", () => {
        const ring = `${ESC}[31mred${ESC}[0m ${ESC}[5C ${ESC}[2D ${ESC}[2J`;
        expect(sanitizeReplay(ring)).toBe(ring); // none of these solicit a response
    });
});

describe("scrollback ring is bounded (~200 KB), keeping the freshest tail", () => {
    it("trims old data past the cap but retains the latest", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const s = create(m);
        handles[0].emit("HEAD-MARKER");
        handles[0].emit("x".repeat(SCROLLBACK_CAP));  // pushes HEAD past the cap
        handles[0].emit("TAIL-MARKER");
        const seen: string[] = [];
        m.attach(s.id, (d) => seen.push(d));
        const replay = seen.join("");
        expect(replay.length).toBeLessThanOrEqual(SCROLLBACK_CAP);
        expect(replay).toContain("TAIL-MARKER");   // freshest kept
        expect(replay).not.toContain("HEAD-MARKER"); // oldest trimmed
    });
});

describe("list + onExit", () => {
    it("list() returns each session with its liveness", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const a = create(m, { title: "A" });
        const b = create(m, { title: "B" });
        handles[1].fireExit(0); // B exits naturally
        const list = m.list();
        expect(list.map((x) => x.title).sort()).toEqual(["A", "B"]);
        expect(list.find((x) => x.id === a.id)?.alive).toBe(true);
        expect(list.find((x) => x.id === b.id)?.alive).toBe(false);
    });

    it("onExit(cb) fires with (id, code) when a session exits, and flips it not-alive", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const exits: Array<[string, number]> = [];
        m.onExit((id, code) => exits.push([id, code]));
        const s = create(m);
        handles[0].fireExit(3);
        expect(exits).toEqual([[s.id, 3]]);
        expect(m.list().find((x) => x.id === s.id)?.alive).toBe(false);
    });

    it("an onExit listener that THROWS never breaks the manager (isolated)", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        m.onExit(() => { throw new Error("boom"); });
        const good: Array<[string, number]> = [];
        m.onExit((id, code) => good.push([id, code]));
        const s = create(m);
        expect(() => handles[0].fireExit(1)).not.toThrow();
        expect(good).toEqual([[s.id, 1]]); // the second listener still ran
    });
});

describe("killByCwdPrefix + disposeAll", () => {
    it("killByCwdPrefix kills only sessions under the (slash-normalized) prefix", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const under = create(m, { cwd: "C:\\repo\\.helm\\worktrees\\task-1", title: "under" }); // backslashes
        const sibling = create(m, { cwd: "C:/repo/.helm/worktrees-evil/x", title: "sibling" });   // must NOT match
        const other = create(m, { cwd: "C:/repo/other", title: "other" });
        m.killByCwdPrefix("C:/repo/.helm/worktrees"); // forward slashes — must still match `under`
        const alive = (id: string) => m.list().find((x) => x.id === id)?.alive;
        expect(alive(under.id)).toBe(false);
        expect(alive(sibling.id)).toBe(true);
        expect(alive(other.id)).toBe(true);
        expect(handles[0].killCount).toBe(1); // only `under` was killed
    });

    // M8 worktree-reap seam: the ipc edge calls killByCwdPrefix(worktreePath) immediately before a
    // task-worktree removeWorktree (abandon / verify-&-merge merged / boot orphan-prune) so an open human
    // shell can't EBUSY-wedge the removal. This is the pure kernel of that seam: reap the shells INSIDE the
    // reaped worktree (root + nested), spare a shell in the primary checkout, spare the `-evil` sibling.
    it("reaps every shell under a task worktree (root + nested) and spares the primary checkout + siblings", () => {
        const { factory } = makeFakeFactory();
        const m = createPtyManager(factory);
        const wt = "C:\\repo\\.helm\\worktrees\\ralph-task-1";
        const atRoot = create(m, { cwd: wt, title: "shell-at-worktree-root" });
        const nested = create(m, { cwd: `${wt}\\src\\deep`, title: "shell-nested" });
        const primary = create(m, { cwd: "C:\\repo", title: "primary-checkout" });      // must survive
        const sibling = create(m, { cwd: `${wt}-evil`, title: "sibling-evil" });          // boundary — must survive
        m.killByCwdPrefix(wt);
        const alive = (id: string) => m.list().find((x) => x.id === id)?.alive;
        expect(alive(atRoot.id)).toBe(false);
        expect(alive(nested.id)).toBe(false);
        expect(alive(primary.id)).toBe(true);
        expect(alive(sibling.id)).toBe(true);
    });

    it("disposeAll kills every live session (the quit path), skipping already-dead ones", () => {
        const { factory, handles } = makeFakeFactory();
        const m = createPtyManager(factory);
        const a = create(m); const b = create(m); const c = create(m);
        handles[1].fireExit(0); // b already exited
        m.disposeAll();
        expect(handles[0].killCount).toBe(1); // a killed
        expect(handles[1].killCount).toBe(0); // b already dead → not re-killed
        expect(handles[2].killCount).toBe(1); // c killed
        expect(m.list().every((x) => !x.alive)).toBe(true);
        void a; void b; void c;
    });
});
