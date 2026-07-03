// tests/verify/terminal/surface.ts
// The M7 verify SURFACE. Drives the REAL createPtyManager (with a recording FAKE factory — the native
// node-pty never loads) + the REAL buildDropinArgv, and distils a flat TerminalRecording the invariants
// read. Complementary to, and separate from, the untouched M2/M3/M4/M5/M6 slices (dropin is the nearest
// exemplar). The real ConPTY + real claude TUI are NOT headless-reachable → manual acceptance is
// load-bearing (Task 7); this slice proves the pure lifecycle logic the headless world CAN observe.
import { createPtyManager, type PtyFactory } from "../../../src/main/engine/ptyManager";
import { buildDropinArgv } from "../../../src/main/engine/terminalLaunch";

// A recording fake pty handle: records kill() and lets the scenario push data / fire exit on demand.
interface FakeHandle {
    killed: boolean;
    cmd: string; args: string[];
    onData(cb: (d: string) => void): void;
    onExit(cb: (code: number) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
    emit: (d: string) => void;
    fireExit: (code: number) => void;
}
function recordingFactory() {
    const handles: FakeHandle[] = [];
    const factory: PtyFactory = (cmd, args) => {
        let onData: ((d: string) => void) | undefined;
        let onExit: ((c: number) => void) | undefined;
        const h: FakeHandle = {
            killed: false, cmd, args,
            onData: (cb) => { onData = cb; },
            onExit: (cb) => { onExit = cb; },
            write: () => {}, resize: () => {}, kill: () => { h.killed = true; },
            emit: (d) => onData?.(d),
            fireExit: (c) => onExit?.(c),
        };
        handles.push(h);
        return h;
    };
    return { factory, handles };
}

// The flat recording the invariants read.
export interface TerminalRecording {
    unit: "terminal";
    // no-orphan-ptys
    createdCount: number;
    killedHandleCount: number;      // fake handles whose kill() was invoked
    orphansAfterDispose: number;    // sessions STILL alive after disposeAll (the quit path) — must be 0
    killActuallyKills: boolean;     // an explicit kill(id) invoked handle.kill AND flipped list()'s alive→false
    // dropin-respects-resume-guard — buildDropinArgv output per session state
    argvCases: Array<{ sessionId: string | null; argv: string[] }>;
    argvForwardedToFactory: boolean; // the manager passed buildDropinArgv verbatim to the factory (real seam)
    // attach-replays-scrollback
    emittedBeforeAttach: string;    // ordered concatenation of chunks written BEFORE attach
    replayed: string;               // what the attach listener received as the replay (must === emittedBeforeAttach)
    liveEmittedAfterAttach: string; // chunks emitted AFTER attach
    streamedAfterAttach: string;    // what the listener received live after the replay (must === liveEmittedAfterAttach, in order)
    // close-tab-kills-pty (M8) — closing a tab is the ONLY renderer-initiated kill
    closedTabId: string;            // the session id closed via kill(id)
    closedTabAlive: boolean;        // its alive flag in list() AFTER the close — must be false
    closedTabHandleKilled: boolean; // the underlying pty handle's kill was invoked
    // reap-kills-worktree-shells (M8) — killByCwdPrefix(worktree) before a task-worktree removeWorktree
    reapedWorktree: string;                 // the worktree path passed to killByCwdPrefix
    survivorsUnderReapedWorktree: number;   // live sessions still under reapedWorktree AFTER the reap — must be 0
    outsideSessionsStillAlive: number;      // sessions OUTSIDE the worktree that must remain alive (no over-reach)
    outsideSessionsExpected: number;        // how many outside sessions there were (all must survive)
}

// The comprehensive positive run: one real manager driven through all three concerns.
export function runTerminalScenario(): TerminalRecording {
    const { factory, handles } = recordingFactory();
    const m = createPtyManager(factory);

    // ── no-orphan-ptys: create three live sessions, kill one explicitly, then disposeAll (quit) ─────
    const s1 = m.create({ cwd: "/wt/1", argv: buildDropinArgv("sess-1"), kind: "dropin", title: "T1", taskId: "t1" });
    const s2 = m.create({ cwd: "/wt/2", argv: buildDropinArgv(null), kind: "free", title: "T2" });
    const s3 = m.create({ cwd: "/wt/3", argv: buildDropinArgv("sess-3"), kind: "planner", title: "T3" });
    m.kill(s1.id);
    const killActuallyKills = handles[0].killed && m.list().find((x) => x.id === s1.id)?.alive === false;
    m.disposeAll(); // must reap every still-live session (s2, s3) — plus s1 already dead (idempotent)
    const orphansAfterDispose = m.list().filter((x) => x.alive).length;

    // ── dropin-respects-resume-guard: buildDropinArgv per session state (the real resume-guard) ─────
    const argvCases = [
        { sessionId: "sess-42" as string | null, argv: buildDropinArgv("sess-42") },
        { sessionId: null as string | null, argv: buildDropinArgv(null) },
    ];
    // Prove the manager forwards buildDropinArgv verbatim (argv[0]=cmd, rest=args) to the factory.
    const argvForwardedToFactory =
        handles[0].cmd === "pwsh.exe" && handles[0].args.join(" ") === buildDropinArgv("sess-1").slice(1).join(" ") &&
        handles[1].args.join(" ") === buildDropinArgv(null).slice(1).join(" ");

    // ── attach-replays-scrollback: emit before attach, then attach, then live ───────────────────────
    const { factory: f2, handles: h2 } = recordingFactory();
    const m2 = createPtyManager(f2);
    const s = m2.create({ cwd: "/wt/x", argv: buildDropinArgv("sx"), kind: "dropin", title: "TX" });
    const beforeChunks = ["one ", "two ", "three "];
    beforeChunks.forEach((c) => h2[0].emit(c));
    let replayed = "";
    let streamedAfterAttach = "";
    let sawReplay = false;
    m2.attach(s.id, (d) => { if (!sawReplay) { sawReplay = true; replayed = d; } else { streamedAfterAttach += d; } });
    const liveChunks = ["four ", "five "];
    liveChunks.forEach((c) => h2[0].emit(c));

    // ── close-tab-kills-pty (M8): closing a tab = kill(id); the session must be DEAD in list() ───────
    const { factory: f3, handles: h3 } = recordingFactory();
    const m3 = createPtyManager(f3);
    const closed = m3.create({ cwd: "/wt/close-me", argv: ["pwsh.exe", "-NoLogo"], kind: "free", title: "close-me" });
    m3.kill(closed.id); // the tab's × → pty:kill — the ONLY renderer-initiated kill
    const closedTabAlive = m3.list().find((x) => x.id === closed.id)?.alive === true;
    const closedTabHandleKilled = h3[0].killed;

    // ── reap-kills-worktree-shells (M8): killByCwdPrefix(worktree) reaps shells under it, spares the rest ─
    const { factory: f4 } = recordingFactory();
    const m4 = createPtyManager(f4);
    const wt = "C:\\repo\\.helm\\worktrees\\ralph-task-1";
    const free = (cwd: string, title: string) => m4.create({ cwd, argv: ["pwsh.exe", "-NoLogo"], kind: "free", title });
    // Track ids by group so we read liveness directly (no need to re-implement the manager's prefix match).
    const underIds = [free(wt, "at-root").id, free(`${wt}\\src`, "nested").id, free(wt.replace(/\\/g, "/"), "slash-style").id];
    const outsideIds = [free("C:\\repo", "primary-checkout").id, free(`${wt}-evil`, "sibling-evil").id];
    m4.killByCwdPrefix(wt);
    const isAlive = (id: string) => m4.list().find((x) => x.id === id)?.alive === true;
    const survivorsUnderReapedWorktree = underIds.filter(isAlive).length;
    const outsideSessionsStillAlive = outsideIds.filter(isAlive).length;

    return {
        unit: "terminal",
        createdCount: 3,
        killedHandleCount: handles.filter((h) => h.killed).length,
        orphansAfterDispose,
        killActuallyKills,
        argvCases,
        argvForwardedToFactory,
        emittedBeforeAttach: beforeChunks.join(""),
        replayed,
        liveEmittedAfterAttach: liveChunks.join(""),
        streamedAfterAttach,
        closedTabId: closed.id,
        closedTabAlive,
        closedTabHandleKilled,
        reapedWorktree: wt,
        survivorsUnderReapedWorktree,
        outsideSessionsStillAlive,
        outsideSessionsExpected: outsideIds.length,
    };
}

// A clean baseline (all invariants hold) — probes clone it and flip ONE field.
export const BASELINE: TerminalRecording = {
    unit: "terminal",
    createdCount: 3,
    killedHandleCount: 3,
    orphansAfterDispose: 0,
    killActuallyKills: true,
    argvCases: [
        { sessionId: "sess-42", argv: ["pwsh.exe", "-NoExit", "-Command", "claude --resume sess-42"] },
        { sessionId: null, argv: ["pwsh.exe", "-NoExit", "-Command", "claude"] },
    ],
    argvForwardedToFactory: true,
    emittedBeforeAttach: "one two three ",
    replayed: "one two three ",
    liveEmittedAfterAttach: "four five ",
    streamedAfterAttach: "four five ",
    closedTabId: "closed-1",
    closedTabAlive: false,
    closedTabHandleKilled: true,
    reapedWorktree: "C:/repo/.helm/worktrees/ralph-task-1",
    survivorsUnderReapedWorktree: 0,
    outsideSessionsStillAlive: 2,
    outsideSessionsExpected: 2,
};
