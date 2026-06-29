// tests/engine/mutex.test.ts
// The per-key serialized async lock behind at-most-one-merge-in-flight. Ordering is asserted with
// deferred promises (a resolver the test controls), never timers, so the guarantees are deterministic.
import { describe, it, expect } from "vitest";
import { createKeyedMutex } from "../../src/main/engine/mutex";

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Flush the microtask queue a few times so any eagerly-scheduled continuation would have run.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("createKeyedMutex", () => {
    it("serializes same-key calls: the second fn does not start until the first settles", async () => {
        const m = createKeyedMutex();
        const order: string[] = [];
        const gate = deferred();

        const first = m.withLock("p", async () => { order.push("first-start"); await gate.promise; order.push("first-end"); });
        const second = m.withLock("p", async () => { order.push("second-start"); });

        await flush();
        expect(order).toEqual(["first-start"]); // single-flight: second is still blocked

        gate.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second-start"]);
    });

    it("a rejecting fn releases the lock so a later same-key call still runs", async () => {
        const m = createKeyedMutex();
        const ran: string[] = [];
        const boom = m.withLock("p", async () => { throw new Error("boom"); });
        await expect(boom).rejects.toThrow("boom");
        await m.withLock("p", async () => { ran.push("after"); });
        expect(ran).toEqual(["after"]); // the key wasn't wedged by the rejection
    });

    it("runs different keys concurrently (one key's block does not stall another)", async () => {
        const m = createKeyedMutex();
        const order: string[] = [];
        const gateA = deferred();

        const a = m.withLock("a", async () => { order.push("a-start"); await gateA.promise; order.push("a-end"); });
        const b = m.withLock("b", async () => { order.push("b-start"); });

        await flush();
        expect(order).toEqual(["a-start", "b-start"]); // b ran even though a is still blocked

        gateA.resolve();
        await Promise.all([a, b]);
    });

    it("preserves FIFO arrival order for same-key calls", async () => {
        const m = createKeyedMutex();
        const order: number[] = [];
        const tasks = [0, 1, 2, 3].map((n) => m.withLock("p", async () => { order.push(n); }));
        await Promise.all(tasks);
        expect(order).toEqual([0, 1, 2, 3]);
    });
});
